import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import db from './db.js'
import { createJob, getJob, startJob } from './jobs.js'
import { getActiveKeyDecrypted } from './db.js'
import { scanSecrets } from './secretScan.js'
import { withWorkspaceScope } from './workspace.js'
import { createWorkflow, startWorkflow } from './agentWorkflows.js'
import { addOperatorMissionEvent } from './operatorMode.js'
import { appendLesson } from './operatorRunbooks.js'

let initialized = false
const monitors = new Map()

function now() { return Date.now() }
function id(prefix = 'code') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function shQuote(v = '') { return `'${String(v).replace(/'/g, `'"'"'`)}'` }
function clip(s = '', max = 20000) { const x = String(s || ''); return x.length > max ? x.slice(0, max) + `\n…[truncated ${x.length - max} chars]` : x }
function redact(s = '') {
  let out = String(s || '')
  for (const v of [process.env.GITHUB_TOKEN, process.env.GH_TOKEN].filter(Boolean)) out = out.split(v).join('<redacted-token>')
  return out.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:<redacted>@')
}
function repoSlug(repo = '') {
  return String(repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
}
async function githubJson(path, { method = 'GET', body = null } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (!token) throw new Error('GITHUB_TOKEN is not configured')
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await r.text().catch(() => '')
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${clip(text, 1000)}`)
  return data
}

async function githubFetch(path, { method = 'GET', body = null, accept = 'application/vnd.github+json' } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (!token) throw new Error('GITHUB_TOKEN is not configured')
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(90_000),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`GitHub ${r.status}: ${clip(text, 1000)}`)
  }
  return r
}

async function summarizeWorkflowLogs(repo, runId, maxChars = 18000) {
  try {
    const r = await githubFetch(`/repos/${repo}/actions/runs/${runId}/logs`, { accept: 'application/zip' })
    const buf = Buffer.from(await r.arrayBuffer())
    const zip = new AdmZip(buf)
    const chunks = []
    for (const entry of zip.getEntries().slice(0, 25)) {
      if (entry.isDirectory) continue
      const text = entry.getData().toString('utf8')
      const interesting = text.split('\n').filter((line) => /error|failed|failure|exception|fatal|✖|ERR!/i.test(line)).slice(-120).join('\n')
      chunks.push(`===== ${entry.entryName} =====\n${clip(interesting || text, 3500)}`)
    }
    return clip(chunks.join('\n\n'), maxChars)
  } catch (e) {
    return `Unable to fetch workflow logs: ${e.message}`
  }
}

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace'
const PROJECTS_ROOT = path.join(WORKSPACE_ROOT, 'projects')

function run(command, { cwd = WORKSPACE_ROOT, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let killed = false
    const timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL') } catch { /* already exited */ } }, timeoutMs)
    proc.stdout.on('data', (c) => out.push(c))
    proc.stderr.on('data', (c) => err.push(c))
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: killed ? 124 : (code ?? 1), stdout: clip(Buffer.concat(out).toString()), stderr: clip(Buffer.concat(err).toString()) + (killed ? '\n[killed by timeout]' : '') })
    })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: 1, stdout: '', stderr: e.message }) })
  })
}

export function initOperatorCode() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_code_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      mission_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      goal TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL DEFAULT '',
      workdir TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      job_id TEXT NOT NULL DEFAULT '',
      verify_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_operator_code_user ON operator_code_tasks(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_operator_code_mission ON operator_code_tasks(mission_id);
    CREATE INDEX IF NOT EXISTS idx_operator_code_status ON operator_code_tasks(status);
  `)
  initialized = true
  const running = db.prepare(`SELECT id FROM operator_code_tasks WHERE status IN ('queued','preparing','agent_running','verifying') ORDER BY created_at ASC LIMIT 20`).all()
  for (const r of running) setTimeout(() => monitorCodeTask(r.id), 1000).unref?.()
}


function emitTaskEvent(task, type, title, message = '', data = {}) {
  if (!task?.missionId) return
  try { addOperatorMissionEvent({ missionId: task.missionId, userId: task.userId, type, title, message, data: { codeTaskId: task.id, ...data } }) } catch { /* best-effort */ }
}

function rowToTask(r) {
  if (!r) return null
  const task = {
    id: r.id, userId: r.user_id, missionId: r.mission_id, projectId: r.project_id,
    status: r.status, goal: r.goal, repo: r.repo, workdir: r.workdir, branch: r.branch,
    jobId: r.job_id, verify: parse(r.verify_json, {}), result: parse(r.result_json, {}), error: r.error || '',
    createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
  }
  if (task.jobId) task.job = getJob(task.jobId)
  return task
}

export function getOperatorCodeTask(taskId) {
  initOperatorCode()
  return rowToTask(db.prepare('SELECT * FROM operator_code_tasks WHERE id=?').get(String(taskId || '')))
}

export function listOperatorCodeTasks({ userId = '', limit = 30 } = {}) {
  initOperatorCode()
  const max = Math.max(1, Math.min(100, Number(limit) || 30))
  return db.prepare('SELECT * FROM operator_code_tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(String(userId || ''), max).map(rowToTask)
}

function patchTask(taskId, patch = {}) {
  const cur = getOperatorCodeTask(taskId)
  if (!cur) return null
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE operator_code_tasks SET status=?, job_id=?, verify_json=?, result_json=?, error=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status || cur.status,
    next.jobId || cur.jobId || '',
    JSON.stringify(next.verify || cur.verify || {}),
    JSON.stringify(next.result || cur.result || {}),
    next.error || '',
    now(),
    next.finishedAt || null,
    taskId,
  )
  if (cur.missionId) {
    if ((next.status || cur.status) !== cur.status) emitTaskEvent({ ...cur, id: taskId, missionId: cur.mission_id, userId: cur.user_id }, ['failed'].includes(next.status) ? 'error' : ['succeeded'].includes(next.status) ? 'success' : 'info', `Code task ${next.status || cur.status}`, next.error || '', { status: next.status || cur.status })
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(next.status)
    db.prepare(`UPDATE operator_missions SET status=?, job_id=?, result_json=?, error=?, updated_at=?, finished_at=? WHERE id=?`).run(
      next.status || cur.status,
      next.jobId || cur.jobId || '',
      JSON.stringify({ ...(next.result || cur.result || {}), codeTaskId: taskId }),
      next.error || '',
      now(),
      terminal ? now() : null,
      cur.missionId,
    )
  }
  return getOperatorCodeTask(taskId)
}

function repoToDir(repo = '') {
  const tail = String(repo || 'project').replace(/\.git$/i, '').split('/').pop() || 'project'
  return tail.replace(/[^a-zA-Z0-9._-]/g, '-') || 'project'
}

function projectMetaFromTask(task = {}) {
  return task.result?.project?.meta || {}
}
function commandFromProject(task = {}, name, fallback = '') {
  const meta = projectMetaFromTask(task)
  const cmd = meta?.commands?.[name]
  if (cmd === false || cmd === null) return ''
  return String(cmd || fallback || '').trim()
}

async function prepareCheckout(task) {
  const repo = task.repo || ''
  const workdir = task.workdir || path.join(PROJECTS_ROOT, repoToDir(repo))
  const branch = task.branch || `operator/${new Date().toISOString().replace(/[:.]/g, '-')}-${task.id.slice(-6)}`
  await run(`mkdir -p ${shQuote(PROJECTS_ROOT)}`, { timeoutMs: 30_000 })
  if (!existsSync(path.join(workdir, '.git'))) {
    if (!repo) throw new Error('repo is required for code task checkout')
    const url = /^https?:|^git@/.test(repo) ? repo : `https://github.com/${repo}.git`
    const r = await run(`git clone ${shQuote(url)} ${shQuote(workdir)}`, { timeoutMs: 3 * 60_000 })
    if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr || r.stdout}`)
  }
  await run(`rm -f .git/index.lock .git/refs/remotes/origin/*.lock 2>/dev/null || true && git fetch --all --prune || true`, { cwd: workdir, timeoutMs: 2 * 60_000 })
  await run(`git checkout ${shQuote(branch)} 2>/dev/null || git checkout -b ${shQuote(branch)}`, { cwd: workdir, timeoutMs: 60_000 })
  await run(`git config user.name 'BrowserAI Operator' && git config user.email 'operator@browserai.local'`, { cwd: workdir, timeoutMs: 30_000 })
  return { workdir, branch }
}

function buildAgentPrompt(task, project = {}) {
  const rel = path.relative(WORKSPACE_ROOT, task.workdir || '').replace(/\\/g, '/') || 'projects/browserAI'
  return `You are BrowserAI Code Operator. Complete this development task in the local repository folder: ${rel}\n\nGoal:\n${task.goal}\n\nHard requirements:\n- Start by reading project rules/package/README and relevant files.\n- Use paths under ${rel}.\n- Make concrete file changes with edit_file/write_file.\n- After code edits run verify_code or verify_task.\n- Run tests/build when practical.\n- Do not touch production directly. If deploy is needed, state it as a separate approval-gated step.\n- Final response must include changed files and verification evidence.\n\nProject metadata and commands:\n${JSON.stringify(project, null, 2)}`
}

export function startOperatorCodeTask({ userId = '', missionId = '', project = {}, goal = '', mode = 'code_task', autostart = true } = {}) {
  initOperatorCode()
  const taskId = id('code')
  const ts = now()
  const repo = project?.repo || process.env.GITHUB_REPO || 'robesthud/browserAI'
  const workdir = project?.localPath && project.localPath.startsWith('/workspace') ? project.localPath : path.join(PROJECTS_ROOT, repoToDir(repo))
  const branchPrefix = String(project?.meta?.git?.branchPrefix || 'operator').replace(/[^a-zA-Z0-9/_-]/g, '-') || 'operator'
  const branch = `${branchPrefix}/${mode}-${Date.now().toString(36)}-${taskId.slice(-6)}`
  db.prepare(`INSERT INTO operator_code_tasks (id,user_id,mission_id,project_id,status,goal,repo,workdir,branch,verify_json,result_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'{}',?, ?,?)`).run(taskId, String(userId || ''), String(missionId || ''), project?.id || 'browserai', 'queued', String(goal || '').slice(0, 4000), repo, workdir, branch, JSON.stringify({ project }), ts, ts)
  if (autostart !== false) setTimeout(() => monitorCodeTask(taskId), 10).unref?.()
  return getOperatorCodeTask(taskId)
}

async function verifyCodeTask(task) {
  const results = []
  const cwd = task.workdir
  const hasPkg = existsSync(path.join(cwd, 'package.json'))
  const installCmd = commandFromProject(task, 'install', hasPkg ? 'npm ci --include=dev' : '')
  const testCmd = commandFromProject(task, 'test', hasPkg ? 'npm test' : '')
  const buildCmd = commandFromProject(task, 'build', hasPkg ? 'npm run build' : '')
  const lintCmd = commandFromProject(task, 'lint', '')
  if (installCmd && hasPkg && !existsSync(path.join(cwd, 'node_modules'))) {
    const r = await run(installCmd, { cwd, timeoutMs: 8 * 60_000 })
    results.push({ name: installCmd, ok: r.exitCode === 0, ...r })
    if (r.exitCode !== 0) return { passed: false, results }
  }
  for (const [name, cmd, timeoutMs] of [['test', testCmd, 5 * 60_000], ['build', buildCmd, 8 * 60_000], ['lint', lintCmd, 4 * 60_000]]) {
    if (!cmd) continue
    const r = await run(cmd, { cwd, timeoutMs })
    results.push({ name: cmd || name, ok: r.exitCode === 0, ...r })
  }
  const status = await run('git status --short', { cwd, timeoutMs: 30_000 })
  const diff = await run('git diff --stat && git diff --name-only', { cwd, timeoutMs: 30_000 })
  results.push({ name: 'git status', ok: status.exitCode === 0, ...status })
  const scan = await withWorkspaceScope('', () => scanSecrets({ root: path.relative(WORKSPACE_ROOT, cwd).replace(/\\/g, '/') }))
  results.push({ name: 'secret_scan', ok: scan.ok, stdout: JSON.stringify(scan, null, 2), stderr: scan.ok ? '' : 'Secret scan failed', exitCode: scan.ok ? 0 : 1 })
  const passed = results.every((r) => r.ok)
  return { passed, results, git: { status: status.stdout, diff: diff.stdout }, secretScan: scan }
}

export function monitorCodeTask(taskId) {
  initOperatorCode()
  if (monitors.has(taskId)) return
  monitors.set(taskId, true)
  ;(async () => {
    try {
      let task = getOperatorCodeTask(taskId)
      if (!task) return
      if (task.status === 'queued' || task.status === 'preparing') {
        patchTask(taskId, { status: 'preparing' })
        const prepared = await prepareCheckout(task)
        db.prepare('UPDATE operator_code_tasks SET workdir=?, branch=?, updated_at=? WHERE id=?').run(prepared.workdir, prepared.branch, now(), taskId)
        task = getOperatorCodeTask(taskId)
        const provider = getActiveKeyDecrypted(null)
        if (!provider?.baseUrl || !provider?.model) throw new Error('No active provider configured for code operator')
        const prompt = buildAgentPrompt(task, { id: task.projectId, repo: task.repo, workdir: task.workdir, branch: task.branch })
        const job = createJob({
          userId: task.userId,
          chatId: '',
          type: 'agent_run',
          title: `code-operator: ${task.goal.slice(0, 80)}`,
          input: {
            prompt,
            history: [{ role: 'user', content: prompt }],
            extraSystem: '[code-operator-pipeline] You are running inside an Operator Code Task. Make concrete changes, verify, and report evidence. Do not use production actions without approval.',
            provider: { baseUrl: provider.baseUrl, model: provider.model, authType: provider.authType, authHeader: provider.authHeader, extraHeaders: provider.extraHeaders, temperature: 0.2 },
          },
        })
        emitTaskEvent(task, 'info', 'Coding agent started', job.id, { jobId: job.id })
        patchTask(taskId, { status: 'agent_running', jobId: job.id, result: { checkout: { workdir: task.workdir, branch: task.branch }, jobId: job.id } })
        startJob(job.id)
      }

      // Poll linked agent job until terminal, then run deterministic verification.
      let current = getOperatorCodeTask(taskId)
      while (current?.jobId) {
        const j = getJob(current.jobId)
        if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) break
        await new Promise((r) => setTimeout(r, 2500))
        current = getOperatorCodeTask(taskId)
      }
      current = getOperatorCodeTask(taskId)
      const job = current?.jobId ? getJob(current.jobId) : null
      if (job && job.status !== 'succeeded') {
        patchTask(taskId, { status: 'failed', error: `agent job ${job.status}: ${job.error || ''}`, finishedAt: now(), result: { ...(current.result || {}), job } })
        return
      }
      patchTask(taskId, { status: 'verifying' })
      const verify = await verifyCodeTask(getOperatorCodeTask(taskId))
      const finalStatus = verify.passed ? 'succeeded' : 'failed'
      patchTask(taskId, {
        status: finalStatus,
        verify,
        error: verify.passed ? '' : 'verification failed',
        finishedAt: now(),
        result: { ...(getOperatorCodeTask(taskId)?.result || {}), verify, report: renderCodeTaskReport(getOperatorCodeTask(taskId), verify) },
      })
    } catch (e) {
      patchTask(taskId, { status: 'failed', error: e?.message || String(e), finishedAt: now() })
    } finally {
      monitors.delete(taskId)
    }
  })()
}

export function renderCodeTaskReport(task, verify = task?.verify || {}) {
  const ok = verify?.passed
  const lines = [
    `${ok ? '✅' : '❌'} Code Operator task ${ok ? 'verified' : 'failed verification'}`,
    '',
    `Task: ${task?.id || ''}`,
    `Goal: ${task?.goal || ''}`,
    `Repo: ${task?.repo || ''}`,
    `Branch: ${task?.branch || ''}`,
    `Workdir: ${task?.workdir || ''}`,
    '',
    'Checks:',
  ]
  for (const r of verify?.results || []) lines.push(`${r.ok ? '✓' : '✗'} ${r.name} (exit ${r.exitCode})`)
  if (verify?.git?.status) lines.push('', 'Git status:', verify.git.status)
  return lines.join('\n')
}




async function waitJobTerminal(jobId, { timeoutMs = 20 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = getJob(jobId)
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job
    await new Promise((r) => setTimeout(r, 2500))
  }
  return getJob(jobId) || { status: 'failed', error: 'job wait timeout' }
}

function latestCiFailureContext(task = {}) {
  const ci = task.result?.ci || {}
  const failedRuns = (ci.runs || []).filter((r) => r.conclusion && !['success', 'skipped'].includes(r.conclusion))
  return [
    `CI status: ${ci.status || 'unknown'}`,
    `Branch: ${ci.branch || task.branch}`,
    `Commit: ${ci.commit || task.result?.finalize?.commit || ''}`,
    failedRuns.length ? `Failed runs: ${failedRuns.map((r) => `${r.name || r.id}=${r.conclusion}`).join(', ')}` : '',
    ci.failedLogs ? `\nFailed logs excerpt:\n${ci.failedLogs}` : '',
  ].filter(Boolean).join('\n')
}

export function startOperatorCodeCiAutoFix({ taskId = '', maxAttempts = 2 } = {}) {
  initOperatorCode()
  const start = getOperatorCodeTask(taskId)
  if (!start) throw new Error('code task not found')
  const key = `ci-fix:${taskId}`
  if (monitors.has(key)) return start
  monitors.set(key, true)
  ;(async () => {
    try {
      let task = getOperatorCodeTask(taskId)
      const attemptsLimit = Math.max(1, Math.min(5, Number(maxAttempts) || 2))
      let ciFix = { ...(task.result?.ciFix || {}), status: 'running', attempts: task.result?.ciFix?.attempts || [], startedAt: new Date().toISOString(), maxAttempts: attemptsLimit }
      patchTask(taskId, { status: 'ci_fixing', result: { ...(task.result || {}), ciFix } })

      for (let attempt = ciFix.attempts.length + 1; attempt <= attemptsLimit; attempt += 1) {
        task = getOperatorCodeTask(taskId)
        const provider = getActiveKeyDecrypted(null)
        if (!provider?.baseUrl || !provider?.model) throw new Error('No active provider configured for CI auto-fix')
        const failureContext = latestCiFailureContext(task)
        if (!failureContext.trim()) throw new Error('No CI failure context found. Run wait CI first.')
        const rel = path.relative(WORKSPACE_ROOT, task.workdir || '').replace(/\\/g, '/') || task.workdir
        const prompt = `You are BrowserAI Code Operator CI Auto-Fix. Fix the failing CI on the existing branch without creating a new branch.\n\nRepository folder: ${rel}\nBranch: ${task.branch}\nOriginal goal: ${task.goal}\n\nCI failure context:\n${failureContext}\n\nInstructions:\n- Inspect the failing files/tests/logs.\n- Patch the repository using edit_file/write_file.\n- Run focused verification, then npm_test/build when practical.\n- Do NOT touch production.\n- Final answer must summarize the root cause, changed files, and verification evidence.`
        const job = createJob({
          userId: task.userId,
          chatId: '',
          type: 'agent_run',
          title: `ci-auto-fix ${attempt}: ${task.goal.slice(0, 60)}`,
          input: {
            prompt,
            history: [{ role: 'user', content: prompt }],
            extraSystem: '[ci-auto-fix] You are fixing a failed GitHub Actions run on an existing operator branch. Work with tools and verify before final answer.',
            provider: { baseUrl: provider.baseUrl, model: provider.model, authType: provider.authType, authHeader: provider.authHeader, extraHeaders: provider.extraHeaders, temperature: 0.2 },
          },
        })
        ciFix = { ...(getOperatorCodeTask(taskId).result?.ciFix || ciFix), status: 'agent_running', currentAttempt: attempt, lastJobId: job.id, attempts: [...(ciFix.attempts || []), { attempt, jobId: job.id, status: 'agent_running', startedAt: new Date().toISOString() }] }
        patchTask(taskId, { status: 'ci_fixing', jobId: job.id, result: { ...(getOperatorCodeTask(taskId).result || {}), ciFix } })
        startJob(job.id)
        const jobDone = await waitJobTerminal(job.id)
        if (jobDone.status !== 'succeeded') {
          ciFix.attempts[ciFix.attempts.length - 1] = { ...ciFix.attempts[ciFix.attempts.length - 1], status: jobDone.status, error: jobDone.error || 'agent failed', finishedAt: new Date().toISOString() }
          patchTask(taskId, { status: 'failed', error: `CI auto-fix agent ${jobDone.status}: ${jobDone.error || ''}`, result: { ...(getOperatorCodeTask(taskId).result || {}), ciFix }, finishedAt: now() })
          return
        }

        patchTask(taskId, { status: 'verifying' })
        const verify = await verifyCodeTask(getOperatorCodeTask(taskId))
        if (!verify.passed) {
          ciFix.attempts[ciFix.attempts.length - 1] = { ...ciFix.attempts[ciFix.attempts.length - 1], status: 'verification_failed', verify, finishedAt: new Date().toISOString() }
          patchTask(taskId, { status: 'failed', verify, error: 'CI auto-fix verification failed', result: { ...(getOperatorCodeTask(taskId).result || {}), ciFix }, finishedAt: now() })
          return
        }

        const finalized = await finalizeOperatorCodeTask({ taskId, commitMessage: `operator: fix CI for ${task.goal.slice(0, 60)}`, push: true, createPr: false })
        const waited = await waitOperatorCodeTaskCi({ taskId, timeoutSec: 900, intervalSec: 15 })
        const ciOk = waited.result?.ci?.ok === true
        ciFix = { ...(waited.result?.ciFix || ciFix), status: ciOk ? 'succeeded' : (attempt >= attemptsLimit ? 'failed' : 'retrying') }
        ciFix.attempts[ciFix.attempts.length - 1] = { ...ciFix.attempts[ciFix.attempts.length - 1], status: ciOk ? 'succeeded' : 'ci_failed', commit: finalized.result?.finalize?.commit, ci: waited.result?.ci, finishedAt: new Date().toISOString() }
        patchTask(taskId, { status: ciOk ? 'succeeded' : (attempt >= attemptsLimit ? 'failed' : 'ci_fixing'), error: ciOk ? '' : (attempt >= attemptsLimit ? 'CI still failing after auto-fix attempts' : ''), result: { ...(waited.result || {}), ciFix }, finishedAt: ciOk || attempt >= attemptsLimit ? now() : null })
        if (ciOk) return
      }
    } catch (e) {
      const task = getOperatorCodeTask(taskId)
      patchTask(taskId, { status: 'failed', error: e?.message || String(e), result: { ...(task?.result || {}), ciFix: { ...(task?.result?.ciFix || {}), status: 'failed', error: e?.message || String(e), finishedAt: new Date().toISOString() } }, finishedAt: now() })
    } finally {
      monitors.delete(key)
    }
  })()
  return getOperatorCodeTask(taskId)
}

export async function waitOperatorCodeTaskCi({ taskId = '', timeoutSec = 900, intervalSec = 15 } = {}) {
  initOperatorCode()
  let task = getOperatorCodeTask(taskId)
  if (!task) throw new Error('code task not found')
  const repo = repoSlug(task.repo)
  const branch = task.result?.finalize?.branch || task.branch
  const commit = task.result?.finalize?.commit || ''
  if (!repo || !branch) throw new Error('code task has no repo/branch to watch')
  const deadline = Date.now() + Math.max(30, Number(timeoutSec) || 900) * 1000
  const interval = Math.max(5, Math.min(60, Number(intervalSec) || 15)) * 1000
  let lastRuns = []
  let iterations = 0
  emitTaskEvent(task, 'info', 'Waiting for CI', branch, { branch, commit })
  patchTask(task.id, { result: { ...(task.result || {}), ci: { status: 'waiting', branch, commit, startedAt: new Date().toISOString() } } })

  while (Date.now() < deadline) {
    iterations += 1
    const qs = new URLSearchParams({ branch, per_page: '20' })
    const data = await githubJson(`/repos/${repo}/actions/runs?${qs}`)
    lastRuns = (data.workflow_runs || []).filter((r) => !commit || String(r.head_sha || '').startsWith(commit.slice(0, 12)) || r.head_branch === branch)
    if (lastRuns.length > 0 && lastRuns.every((r) => r.status === 'completed')) {
      const ok = lastRuns.every((r) => r.conclusion === 'success' || r.conclusion === 'skipped')
      const failed = lastRuns.filter((r) => !(r.conclusion === 'success' || r.conclusion === 'skipped'))
      const logs = failed[0] ? await summarizeWorkflowLogs(repo, failed[0].id) : ''
      const ci = {
        status: ok ? 'succeeded' : 'failed', ok, branch, commit, iterations,
        runs: lastRuns.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url, sha: r.head_sha?.slice(0, 12), branch: r.head_branch })),
        failedLogs: logs,
        finishedAt: new Date().toISOString(),
      }
      const result = { ...(getOperatorCodeTask(task.id)?.result || {}), ci }
      emitTaskEvent(task, ok ? 'success' : 'error', ok ? 'CI passed' : 'CI failed', failed[0]?.html_url || '', { ci })
      if (!ok) appendLesson({ title: `CI failed: ${task.goal.slice(0, 100)}`, body: ci.failedLogs || JSON.stringify(ci, null, 2), source: task.id, tags: ['ci', 'failure'] }).catch(() => {})
      patchTask(task.id, { status: ok ? 'succeeded' : 'failed', result, error: ok ? '' : 'CI failed', finishedAt: ok ? (getOperatorCodeTask(task.id)?.finishedAt || now()) : now() })
      if (!ok) {
        try {
          const { createIncident } = await import('./incidents.js')
          createIncident({
            userId: task.userId,
            source: 'operator.ci',
            severity: 'high',
            title: `Operator PR CI failed: ${task.goal.slice(0, 120)}`,
            fingerprint: `operator-ci-${repo}-${branch}-${commit || 'latest'}`,
            details: { codeTaskId: task.id, repo, branch, commit, ci },
          })
        } catch { /* best-effort */ }
      }
      return getOperatorCodeTask(task.id)
    }
    patchTask(task.id, { result: { ...(getOperatorCodeTask(task.id)?.result || {}), ci: { status: 'waiting', branch, commit, iterations, runsSeen: lastRuns.length, updatedAt: new Date().toISOString() } } })
    await new Promise((r) => setTimeout(r, interval))
  }
  const ci = { status: 'timeout', ok: false, branch, commit, iterations, runs: lastRuns.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url })), finishedAt: new Date().toISOString() }
  patchTask(task.id, { status: 'failed', result: { ...(getOperatorCodeTask(task.id)?.result || {}), ci }, error: 'CI wait timed out', finishedAt: now() })
  return getOperatorCodeTask(task.id)
}

export async function finalizeOperatorCodeTask({ taskId = '', commitMessage = '', push = true, createPr = true, prTitle = '', prBody = '' } = {}) {
  initOperatorCode()
  let task = getOperatorCodeTask(taskId)
  if (!task) throw new Error('code task not found')
  if (!task.workdir || !existsSync(path.join(task.workdir, '.git'))) throw new Error('code task checkout not found')
  emitTaskEvent(task, 'info', 'Finalizing code task', 'verify → secret scan → commit/push/PR')
  patchTask(task.id, { status: 'finalizing' })
  task = getOperatorCodeTask(task.id)
  const verify = task.verify?.results?.length ? task.verify : await verifyCodeTask(task)
  if (!verify.passed) {
    patchTask(task.id, { status: 'failed', verify, error: 'verification failed; refusing to commit/push', finishedAt: now() })
    return getOperatorCodeTask(task.id)
  }

  const status = await run('git status --short', { cwd: task.workdir, timeoutMs: 30_000 })
  const changed = String(status.stdout || '').trim()
  if (!changed) {
    const result = { ...(task.result || {}), finalize: { committed: false, pushed: false, pr: null, message: 'No changes to commit' } }
    patchTask(task.id, { status: 'succeeded', verify, result, finishedAt: now() })
    return getOperatorCodeTask(task.id)
  }

  const scan = await withWorkspaceScope('', () => scanSecrets({ root: path.relative(WORKSPACE_ROOT, task.workdir).replace(/\\/g, '/') }))
  if (!scan.ok) {
    patchTask(task.id, { status: 'failed', verify: { ...verify, secretScan: scan }, error: `secret scan blocked finalize: ${scan.high} high findings`, finishedAt: now() })
    return getOperatorCodeTask(task.id)
  }

  const msg = String(commitMessage || `operator: ${task.goal.slice(0, 72) || 'code task'}`).replace(/\n+/g, ' ').trim()
  const add = await run('git add -A', { cwd: task.workdir, timeoutMs: 30_000 })
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`)
  const commit = await run(`git commit -m ${shQuote(msg)}`, { cwd: task.workdir, timeoutMs: 60_000 })
  const commitOk = commit.exitCode === 0 || /nothing to commit/i.test(commit.stdout + commit.stderr)
  if (!commitOk) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`)
  const sha = (await run('git rev-parse HEAD', { cwd: task.workdir, timeoutMs: 30_000 })).stdout.trim()

  let pushResult = null
  if (push) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
    if (!token) throw new Error('GITHUB_TOKEN is required to push operator branch')
    const slug = repoSlug(task.repo)
    const remote = `https://x-access-token:${token}@github.com/${slug}.git`
    const pr = await run(`git push ${shQuote(remote)} HEAD:${shQuote(task.branch)}`, { cwd: task.workdir, timeoutMs: 2 * 60_000 })
    pushResult = { exitCode: pr.exitCode, stdout: redact(pr.stdout), stderr: redact(pr.stderr) }
    if (pr.exitCode !== 0) throw new Error(`git push failed: ${redact(pr.stderr || pr.stdout)}`)
  }

  let pullRequest = null
  if (push && createPr) {
    const slug = repoSlug(task.repo)
    const body = {
      title: prTitle || msg,
      head: task.branch,
      base: 'main',
      body: prBody || renderCodeTaskReport(task, verify),
    }
    try {
      const pr = await githubJson(`/repos/${slug}/pulls`, { method: 'POST', body })
      pullRequest = { number: pr.number, url: pr.html_url, state: pr.state, head: pr.head?.ref, base: pr.base?.ref }
    } catch (e) {
      if (/A pull request already exists/i.test(e.message)) {
        const pulls = await githubJson(`/repos/${slug}/pulls?head=${encodeURIComponent(slug.split('/')[0] + ':' + task.branch)}&state=open`)
        const pr = Array.isArray(pulls) ? pulls[0] : null
        if (pr) pullRequest = { number: pr.number, url: pr.html_url, state: pr.state, head: pr.head?.ref, base: pr.base?.ref, existing: true }
        else throw e
      } else throw e
    }
  }

  const final = {
    ...(task.result || {}),
    finalize: { committed: true, pushed: Boolean(pushResult), commit: sha, branch: task.branch, push: pushResult, pullRequest, message: msg },
    report: renderCodeTaskReport(task, verify) + `\n\nCommit: ${sha}\nBranch: ${task.branch}${pullRequest?.url ? `\nPR: ${pullRequest.url}` : ''}`,
  }
  emitTaskEvent(task, 'success', 'Code task finalized', pullRequest?.url || sha, { commit: sha, branch: task.branch, pullRequest })
  appendLesson({ title: `Code task finalized: ${task.goal.slice(0, 90)}`, body: final.report || renderCodeTaskReport(task, verify), source: task.id, tags: ['code', 'operator'] }).catch(() => {})
  patchTask(task.id, { status: 'succeeded', verify, result: final, error: '', finishedAt: now() })
  return getOperatorCodeTask(task.id)
}


export async function mergeOperatorCodeTaskPr({ taskId = '', mergeMethod = 'squash', deploy = false, confirmDeploy = false } = {}) {
  initOperatorCode()
  let task = getOperatorCodeTask(taskId)
  if (!task) throw new Error('code task not found')
  const pr = task.result?.finalize?.pullRequest
  if (!pr?.number) throw new Error('code task has no pull request to merge')
  const ci = task.result?.ci
  if (ci && ci.ok !== true) throw new Error(`refusing to merge: CI is ${ci.status || 'not green'}`)
  if (!ci) throw new Error('refusing to merge before CI check; run wait CI first')

  const repo = repoSlug(task.repo)
  const prDetails = await githubJson(`/repos/${repo}/pulls/${pr.number}`)
  if (prDetails.state !== 'open') {
    const mergedResult = { ...(task.result || {}), merge: { skipped: true, reason: `PR is ${prDetails.state}`, number: pr.number, url: pr.url || pr.html_url } }
    patchTask(task.id, { status: 'succeeded', result: mergedResult })
    return getOperatorCodeTask(task.id)
  }
  if (prDetails.draft) throw new Error('refusing to merge draft PR')
  const allowed = ['merge', 'squash', 'rebase'].includes(String(mergeMethod)) ? String(mergeMethod) : 'squash'
  const body = {
    commit_title: `operator: ${task.goal.slice(0, 80) || 'merge code task'}`,
    commit_message: renderCodeTaskReport(task, task.verify),
    merge_method: allowed,
    ...(task.result?.finalize?.commit ? { sha: task.result.finalize.commit } : {}),
  }
  const merged = await githubJson(`/repos/${repo}/pulls/${pr.number}/merge`, { method: 'PUT', body })
  const merge = { ok: Boolean(merged.merged), sha: merged.sha, message: merged.message, number: pr.number, url: pr.url || pr.html_url || prDetails.html_url, method: allowed, mergedAt: new Date().toISOString() }
  let result = { ...(task.result || {}), merge }

  if (deploy) {
    if (confirmDeploy !== true) throw new Error('deploy after merge requires confirmDeploy=true')
    const wf = createWorkflow({
      userId: task.userId,
      chatId: '',
      recipeId: 'browserai_deploy_safe',
      input: { codeTaskId: task.id, pullRequest: merge, notifyTelegram: true },
      confirm: true,
      source: 'operator',
    })
    startWorkflow(wf.id)
    result = { ...result, deployWorkflowId: wf.id }
  }
  emitTaskEvent(task, 'success', deploy ? 'PR merged, deploy started' : 'PR merged', merge.url || '', { merge, deployWorkflowId: result.deployWorkflowId })
  patchTask(task.id, { status: 'succeeded', result, error: '', finishedAt: task.finishedAt || now() })
  return getOperatorCodeTask(task.id)
}

export default { initOperatorCode, startOperatorCodeTask, getOperatorCodeTask, listOperatorCodeTasks, finalizeOperatorCodeTask, waitOperatorCodeTaskCi, startOperatorCodeCiAutoFix, mergeOperatorCodeTaskPr }
