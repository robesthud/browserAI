import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import db from './db.js'
import { createJob, getJob, startJob } from './jobs.js'
import { getActiveKeyDecrypted } from './db.js'
import { scanSecrets } from './secretScan.js'
import { withWorkspaceScope } from './workspace.js'

let initialized = false
const monitors = new Map()

function now() { return Date.now() }
function id(prefix = 'code') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function shQuote(v = '') { return `'${String(v).replace(/'/g, `'"'"'`)}'` }
function clip(s = '', max = 20000) { const x = String(s || ''); return x.length > max ? x.slice(0, max) + `\n…[truncated ${x.length - max} chars]` : x }

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace'
const PROJECTS_ROOT = path.join(WORKSPACE_ROOT, 'projects')

function run(command, { cwd = WORKSPACE_ROOT, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []; const err = []
    let killed = false
    const t = setTimeout(() => { killed = true; try { p.kill('SIGKILL') } catch { /* already exited */ } }, timeoutMs)
    p.stdout.on('data', (c) => out.push(c))
    p.stderr.on('data', (c) => err.push(c))
    p.on('close', (code) => { clearTimeout(t); resolve({ exitCode: killed ? 124 : (code ?? 1), stdout: clip(Buffer.concat(out).toString()), stderr: clip(Buffer.concat(err).toString()) + (killed ? '\n[killed by timeout]' : '') }) })
    p.on('error', (e) => { clearTimeout(t); resolve({ exitCode: 1, stdout: '', stderr: e.message }) })
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
  return `You are BrowserAI Code Operator. Complete this development task in the local repository folder: ${rel}\n\nGoal:\n${task.goal}\n\nHard requirements:\n- Start by reading project rules/package/README and relevant files.\n- Use paths under ${rel}.\n- Make concrete file changes with edit_file/write_file.\n- After code edits run verify_code or verify_task.\n- Run tests/build when practical.\n- Do not touch production directly. If deploy is needed, state it as a separate approval-gated step.\n- Final response must include changed files and verification evidence.\n\nProject metadata:\n${JSON.stringify(project, null, 2)}`
}

export function startOperatorCodeTask({ userId = '', missionId = '', project = {}, goal = '', mode = 'code_task', autostart = true } = {}) {
  initOperatorCode()
  const taskId = id('code')
  const ts = now()
  const repo = project?.repo || process.env.GITHUB_REPO || 'robesthud/browserAI'
  const workdir = project?.localPath && project.localPath.startsWith('/workspace') ? project.localPath : path.join(PROJECTS_ROOT, repoToDir(repo))
  const branch = `operator/${mode}-${Date.now().toString(36)}-${taskId.slice(-6)}`
  db.prepare(`INSERT INTO operator_code_tasks (id,user_id,mission_id,project_id,status,goal,repo,workdir,branch,verify_json,result_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'{}','{}',?,?)`).run(taskId, String(userId || ''), String(missionId || ''), project?.id || 'browserai', 'queued', String(goal || '').slice(0, 4000), repo, workdir, branch, ts, ts)
  if (autostart !== false) setTimeout(() => monitorCodeTask(taskId), 10).unref?.()
  return getOperatorCodeTask(taskId)
}

async function verifyCodeTask(task) {
  const results = []
  const cwd = task.workdir
  const hasPkg = existsSync(path.join(cwd, 'package.json'))
  if (hasPkg && !existsSync(path.join(cwd, 'node_modules'))) {
    const r = await run('npm ci --include=dev', { cwd, timeoutMs: 8 * 60_000 })
    results.push({ name: 'npm ci', ok: r.exitCode === 0, ...r })
    if (r.exitCode !== 0) return { passed: false, results }
  }
  if (hasPkg) {
    const test = await run('npm test', { cwd, timeoutMs: 5 * 60_000 })
    results.push({ name: 'npm test', ok: test.exitCode === 0, ...test })
    const build = await run('npm run build', { cwd, timeoutMs: 8 * 60_000 })
    results.push({ name: 'npm run build', ok: build.exitCode === 0, ...build })
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

export default { initOperatorCode, startOperatorCodeTask, getOperatorCodeTask, listOperatorCodeTasks }
