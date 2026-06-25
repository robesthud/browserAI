import crypto from 'node:crypto'
import db from './db.js'
import log from './logger.js'
import { invokeTool } from './agentTools.js'
import { runOpsAction } from './ops.js'
import { withWorkspaceScope } from './workspace.js'
import { evaluateWorkflowStart, initAutomationPolicy } from './automationPolicy.js'
import { notifyWorkflow } from './notifications.js'

let initialized = false
const running = new Set()
const cancelled = new Set()

function now() { return Date.now() }
function id(prefix = 'wf') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function hashJson(value) { try { return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex') } catch { return crypto.createHash('sha256').update(String(value)).digest('hex') } }
function clip(value, max = 24000) {
  let s
  if (typeof value === 'string') { s = value }
  else { try { s = JSON.stringify(value ?? null, null, 2) } catch { s = String(value) } }
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))) }
function retryPolicyForStep(spec = {}) {
  const r = spec.retry || {}
  return {
    attempts: Math.max(1, Math.min(5, Number(r.attempts || spec.attempts || 1))),
    delayMs: Math.max(0, Math.min(60_000, Number(r.delayMs || r.delay_ms || 0))),
    backoff: Math.max(1, Math.min(5, Number(r.backoff || 1))),
  }
}

export const AUTOMATION_RECIPES = [
  {
    id: 'production_health_check',
    title: 'Production health check',
    icon: '🩺',
    description: 'Проверить BrowserAI на сервере: health, docker compose, синхронизация с origin/main.',
    risk: 'safe',
    tags: ['ops', 'monitoring'],
    steps: [
      { title: 'Check app health', kind: 'ops', service: 'browserai', action: 'health', safe: true, retry: { attempts: 2, delayMs: 5000 } },
      { title: 'Docker compose status', kind: 'ops', service: 'browserai', action: 'docker_ps', safe: true },
      { title: 'Git/deploy sync status', kind: 'ops', service: 'browserai', action: 'sync_check', safe: true },
    ],
  },
  {
    id: 'browserai_deploy_safe',
    title: 'Safe deploy BrowserAI',
    icon: '🚀',
    description: 'Аккуратный production deploy: sync check → deploy_safe с rollback → health wait → финальный sync check.',
    risk: 'production-write',
    requiresConfirmation: true,
    tags: ['ops', 'deploy'],
    steps: [
      { title: 'Pre-deploy sync check', kind: 'ops', service: 'browserai', action: 'sync_check', safe: true },
      { title: 'Deploy with rollback', kind: 'ops', service: 'browserai', action: 'deploy_safe', confirm: true, nonIdempotent: true },
      { title: 'Wait for healthy app', kind: 'ops', service: 'browserai', action: 'deploy_wait', safe: true, params: { timeout_sec: 90, interval_sec: 5 }, retry: { attempts: 2, delayMs: 8000 } },
      { title: 'Post-deploy sync check', kind: 'ops', service: 'browserai', action: 'sync_check', safe: true },
    ],
  },
  {
    id: 'production_self_heal_restart',
    title: 'Self-heal: restart app',
    icon: '🛠️',
    description: 'Собрать диагностику, перезапустить browserai container и проверить health. Нужен confirm.',
    risk: 'production-write',
    requiresConfirmation: true,
    tags: ['ops', 'self-heal'],
    steps: [
      { title: 'Initial health', kind: 'ops', service: 'browserai', action: 'health', safe: true },
      { title: 'Recent logs', kind: 'ops', service: 'browserai', action: 'docker_logs_recent', safe: true, params: { service: 'browserai', tail: 120 } },
      { title: 'Restart app container', kind: 'ops', service: 'browserai', action: 'restart', confirm: true, nonIdempotent: true },
      { title: 'Wait for healthy app', kind: 'ops', service: 'browserai', action: 'deploy_wait', safe: true, params: { timeout_sec: 60, interval_sec: 5 }, retry: { attempts: 2, delayMs: 8000 } },
      { title: 'Final docker status', kind: 'ops', service: 'browserai', action: 'docker_ps', safe: true },
    ],
  },
  {
    id: 'workspace_security_audit',
    title: 'Workspace security audit',
    icon: '🛡️',
    description: 'Скан секретов + профиль проекта + git status в workspace.',
    risk: 'safe',
    tags: ['security', 'workspace'],
    steps: [
      { title: 'Scan secrets', kind: 'tool', tool: 'secret_scan', args: { root: '' }, safe: true },
      { title: 'Build project profile', kind: 'tool', tool: 'project_profile', args: {}, safe: true },
      { title: 'Git status', kind: 'tool', tool: 'git_status', args: {}, safe: true },
    ],
  },
  {
    id: 'github_ci_status',
    title: 'GitHub CI status',
    icon: '✅',
    description: 'Проверить последние GitHub Actions runs/status для репозитория.',
    risk: 'safe',
    tags: ['github', 'ci'],
    steps: [
      { title: 'Repository status', kind: 'ops', service: 'github', action: 'repo_status', safe: true },
      { title: 'Recent Actions runs', kind: 'ops', service: 'github', action: 'actions_runs', safe: true, params: { limit: 8 } },
      { title: 'Actions status', kind: 'ops', service: 'github', action: 'actions_status', safe: true, params: { limit: 8 }, retry: { attempts: 2, delayMs: 5000 } },
    ],
  },
  {
    id: 'browserai_full_diagnostic',
    title: 'Full BrowserAI diagnostic',
    icon: '🔎',
    description: 'Полный safe diagnostic: health, docker, recent logs, git sync, GitHub CI.',
    risk: 'safe',
    tags: ['ops', 'diagnostic', 'github'],
    steps: [
      { title: 'App health', kind: 'ops', service: 'browserai', action: 'health', safe: true, retry: { attempts: 2, delayMs: 5000 } },
      { title: 'Docker compose status', kind: 'ops', service: 'browserai', action: 'docker_ps', safe: true },
      { title: 'Recent app logs', kind: 'ops', service: 'browserai', action: 'docker_logs_recent', safe: true, params: { service: 'browserai', tail: 100 } },
      { title: 'Git/deploy sync status', kind: 'ops', service: 'browserai', action: 'sync_check', safe: true },
      { title: 'GitHub Actions status', kind: 'ops', service: 'github', action: 'actions_status', safe: true, params: { limit: 8 } },
    ],
  },
]

export function initAgentWorkflows() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_workflows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      chat_id TEXT NOT NULL DEFAULT '',
      recipe_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      progress INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_workflows_user ON agent_workflows(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_workflows_status ON agent_workflows(status);
    CREATE TABLE IF NOT EXISTS agent_workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_workflow_steps_wf ON agent_workflow_steps(workflow_id, idx);
    CREATE TABLE IF NOT EXISTS agent_tool_ledger (
      hash TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL DEFAULT '',
      step_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  initAutomationPolicy()
  initialized = true

  const resumable = db.prepare(`SELECT id FROM agent_workflows WHERE status IN ('queued','running') ORDER BY created_at ASC`).all()
  if (resumable.length) {
    console.log(`[workflows] resuming ${resumable.length} workflow(s)`)
    // B — reset steps still stuck in 'running' state from a crashed process:
    //   - idempotent steps → reset to 'queued' so they are retried
    //   - nonIdempotent steps → mark 'failed' (cannot safely re-run)
    for (const r of resumable) {
      const stuck = db.prepare(`SELECT * FROM agent_workflow_steps WHERE workflow_id=? AND status='running'`).all(r.id)
      for (const s of stuck) {
        const spec = parse(s.input_json, {})
        if (spec.nonIdempotent) {
          db.prepare(`UPDATE agent_workflow_steps SET status='failed', error='interrupted (non-idempotent)', updated_at=?, finished_at=? WHERE id=?`).run(now(), now(), s.id)
        } else {
          db.prepare(`UPDATE agent_workflow_steps SET status='queued', attempts=0, error='', updated_at=? WHERE id=?`).run(now(), s.id)
        }
      }
    }
    setTimeout(() => { for (const r of resumable) startWorkflow(r.id) }, 1000).unref?.()
  }
}

function recipePublic(r) {
  return {
    id: r.id, title: r.title, icon: r.icon, description: r.description,
    risk: r.risk, requiresConfirmation: Boolean(r.requiresConfirmation), tags: r.tags || [],
    steps: (r.steps || []).map((s, i) => ({ idx: i + 1, title: s.title, kind: s.kind, tool: s.tool, service: s.service, action: s.action, safe: Boolean(s.safe), retry: s.retry || null })),
  }
}
export function listAutomationRecipes() { return AUTOMATION_RECIPES.map(recipePublic) }
export function getAutomationRecipe(recipeId) { return AUTOMATION_RECIPES.find((r) => r.id === recipeId) || null }

function rowToWorkflow(row) {
  if (!row) return null
  const steps = db.prepare('SELECT * FROM agent_workflow_steps WHERE workflow_id=? ORDER BY idx ASC').all(row.id).map((s) => ({
    id: s.id, workflowId: s.workflow_id, idx: s.idx, title: s.title, kind: s.kind, status: s.status,
    input: parse(s.input_json, {}), result: parse(s.result_json, {}), error: s.error || '', attempts: s.attempts,
    startedAt: s.started_at, updatedAt: s.updated_at, finishedAt: s.finished_at,
  }))
  return {
    id: row.id, userId: row.user_id, chatId: row.chat_id, recipeId: row.recipe_id, title: row.title,
    status: row.status, input: parse(row.input_json, {}), result: parse(row.result_json, {}), error: row.error || '', progress: row.progress,
    createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at, steps,
  }
}

export function getWorkflow(workflowId) {
  initAgentWorkflows()
  return rowToWorkflow(db.prepare('SELECT * FROM agent_workflows WHERE id=?').get(String(workflowId || '')))
}

export function listWorkflows({ userId = '', chatId = '', limit = 30 } = {}) {
  initAgentWorkflows()
  const max = Math.min(100, Math.max(1, Number(limit) || 30))
  const rows = chatId
    ? db.prepare('SELECT * FROM agent_workflows WHERE chat_id=? ORDER BY updated_at DESC LIMIT ?').all(String(chatId), max)
    : db.prepare('SELECT * FROM agent_workflows WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(String(userId || ''), max)
  return rows.map(rowToWorkflow)
}

function patchWorkflow(workflowId, patch = {}) {
  const cur = getWorkflow(workflowId)
  if (!cur) return null
  const next = { ...cur, ...patch, updatedAt: now() }
  db.prepare(`UPDATE agent_workflows SET status=?, result_json=?, error=?, progress=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status, JSON.stringify(next.result || {}), next.error || '', Math.max(0, Math.min(100, Number(next.progress) || 0)), next.updatedAt, next.finishedAt || null, workflowId,
  )
  return getWorkflow(workflowId)
}

function patchStep(stepId, patch = {}) {
  const cur = db.prepare('SELECT * FROM agent_workflow_steps WHERE id=?').get(stepId)
  if (!cur) return null
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE agent_workflow_steps SET status=?, result_json=?, error=?, attempts=?, started_at=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status || cur.status,
    JSON.stringify(next.result || parse(cur.result_json, {})),
    next.error || '',
    Number(next.attempts ?? cur.attempts ?? 0),
    next.started_at ?? next.startedAt ?? cur.started_at ?? null,
    now(),
    next.finished_at ?? next.finishedAt ?? cur.finished_at ?? null,
    stepId,
  )
  return db.prepare('SELECT * FROM agent_workflow_steps WHERE id=?').get(stepId)
}

export function renderWorkflowReport(workflow) {
  if (!workflow) return ''
  const icon = workflow.status === 'succeeded' ? '✅' : workflow.status === 'failed' ? '❌' : workflow.status === 'cancelled' ? '⊘' : '⏳'
  const dur = workflow.finishedAt && workflow.createdAt ? `${Math.round((workflow.finishedAt - workflow.createdAt) / 1000)}s` : ''
  const lines = [
    `${icon} ${workflow.title}`,
    '',
    `Workflow: ${workflow.id}`,
    `Recipe: ${workflow.recipeId}`,
    `Status: ${workflow.status}`,
    dur ? `Duration: ${dur}` : '',
    workflow.error ? `Error: ${workflow.error}` : '',
    '',
    'Steps:',
  ].filter(Boolean)
  for (const s of workflow.steps || []) {
    const mark = s.status === 'succeeded' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'cancelled' ? '⊘' : '…'
    lines.push(`${mark} ${s.idx}. ${s.title}${s.error ? ` — ${s.error}` : ''}`)
  }
  return lines.join('\n')
}

async function attachIncidentRcaIfNeeded(workflow) {
  const incidentId = workflow?.input?.incidentId
  if (!incidentId) return
  try {
    const { attachIncidentRcaFromWorkflow } = await import('./incidents.js')
    attachIncidentRcaFromWorkflow(incidentId, workflow)
  } catch { /* RCA is best-effort */ }
}

async function notifyWorkflowIfNeeded(workflow) {
  if (!workflow) return
  await attachIncidentRcaIfNeeded(workflow)
  if (['succeeded', 'failed'].includes(workflow.status)) { try { notifyWorkflow(workflow) } catch { /* best-effort */ } }
  const recipe = getAutomationRecipe(workflow.recipeId)
  const shouldNotify = workflow.status === 'failed' || recipe?.risk === 'production-write' || workflow.input?.notifyTelegram === true
  if (!shouldNotify) return
  try {
    await runOpsAction({ service: 'telegram', action: 'notify_admin', params: { text: renderWorkflowReport(workflow) }, confirm: true })
  } catch { /* notification is best-effort */ }
}

export function createWorkflow({ userId = '', chatId = '', recipeId = '', input = {}, confirm = false, source = 'manual' } = {}) {
  initAgentWorkflows()
  const recipe = getAutomationRecipe(recipeId)
  if (!recipe) throw new Error(`Unknown automation recipe: ${recipeId}`)
  const policyDecision = evaluateWorkflowStart({ recipe, userId, source, confirm })
  if (!policyDecision.ok) {
    const err = new Error(policyDecision.reason || `Recipe ${recipeId} blocked by policy`)
    err.code = policyDecision.code || 'POLICY_DENY'
    err.policy = policyDecision
    throw err
  }
  const workflowId = id('wf')
  const ts = now()
  db.prepare(`INSERT INTO agent_workflows (id,user_id,chat_id,recipe_id,title,status,input_json,result_json,created_at,updated_at)
    VALUES (?,?,?,?,?,'queued',?,'{}',?,?)`).run(
    workflowId, String(userId || ''), String(chatId || ''), recipe.id, recipe.title, JSON.stringify({ ...(input || {}), confirmed: Boolean(confirm), source }), ts, ts,
  )
  recipe.steps.forEach((step, i) => {
    db.prepare(`INSERT INTO agent_workflow_steps (id,workflow_id,idx,title,kind,status,input_json,result_json,updated_at)
      VALUES (?,?,?,?,?,'queued',?,'{}',?)`).run(
      id('step'), workflowId, i + 1, step.title || `${step.kind} step`, step.kind || 'tool', JSON.stringify(step), ts,
    )
  })
  return getWorkflow(workflowId)
}

export function cancelWorkflow(workflowId) {
  const wf = getWorkflow(workflowId)
  if (!wf) return null
  if (['succeeded', 'failed', 'cancelled'].includes(wf.status)) return wf
  cancelled.add(workflowId)
  db.prepare(`UPDATE agent_workflow_steps SET status='cancelled', error='cancelled by user', finished_at=?, updated_at=? WHERE workflow_id=? AND status IN ('queued','running')`).run(now(), now(), workflowId)
  return patchWorkflow(workflowId, { status: 'cancelled', error: 'cancelled by user', finishedAt: now(), progress: 100 })
}

async function executeStep({ workflow, step }) {
  const spec = step.input || {}
  const stepHash = hashJson({ recipeId: workflow.recipeId, idx: step.idx, spec })
  if (!spec.nonIdempotent) {
    const cached = db.prepare(`SELECT * FROM agent_tool_ledger WHERE hash=? AND status='succeeded'`).get(stepHash)
    if (cached) return { ok: true, cached: true, result: parse(cached.result_json, {}) }
  }

  let raw
  if (spec.kind === 'ops') {
    raw = await runOpsAction({ service: spec.service, action: spec.action, params: spec.params || {}, confirm: Boolean(spec.confirm || spec.safe) })
    raw = { ok: !raw?.requiresConfirmation && Number(raw?.exitCode ?? 0) === 0, result: raw, error: raw?.requiresConfirmation ? raw.message : (Number(raw?.exitCode ?? 0) === 0 ? '' : raw?.stderr || raw?.error || 'ops action failed') }
  } else if (spec.kind === 'tool') {
    raw = await withWorkspaceScope(workflow.chatId || '', () => invokeTool(spec.tool, { ...(spec.args || {}), _chatId: workflow.chatId || '' }, { userId: workflow.userId || '', chatId: workflow.chatId || '' }))
  } else {
    raw = { ok: false, error: `Unsupported step kind: ${spec.kind}` }
  }

  const result = { ok: Boolean(raw.ok), cached: false, result: raw.result || null, error: raw.error || '' }
  db.prepare(`INSERT OR REPLACE INTO agent_tool_ledger (hash,workflow_id,step_id,kind,name,input_json,result_json,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    stepHash, workflow.id, step.id, spec.kind || '', spec.tool || `${spec.service}.${spec.action}`, JSON.stringify(spec), JSON.stringify(result), result.ok ? 'succeeded' : 'failed', now(),
  )
  return result
}

export function startWorkflow(workflowId) {
  initAgentWorkflows()
  const wf = getWorkflow(workflowId)
  if (!wf || running.has(workflowId)) return wf
  running.add(workflowId)
  ;(async () => {
    try {
      patchWorkflow(workflowId, { status: 'running', error: '' })
      let workflow = getWorkflow(workflowId)
      const steps = workflow.steps || []
      for (const step of steps) {
        if (cancelled.has(workflowId)) break
        if (step.status === 'succeeded') continue
        const spec = step.input || {}
        const retry = retryPolicyForStep(spec)
        let out = null
        // D — if prior attempts already exhausted budget (e.g. crash-resume), reset to ensure ≥1 attempt
        const priorAttempts = Number(step.attempts || 0)
        const startAttempt = priorAttempts >= retry.attempts ? 1 : priorAttempts + 1
        for (let attempt = startAttempt; attempt <= retry.attempts; attempt += 1) {
          if (cancelled.has(workflowId)) break
          patchStep(step.id, { status: 'running', attempts: attempt, startedAt: step.startedAt || now(), error: attempt > 1 ? `retry ${attempt}/${retry.attempts}` : '' })
          workflow = getWorkflow(workflowId)
          out = await executeStep({ workflow, step: { ...step, status: 'running' } })
          if (out.ok) break
          if (attempt < retry.attempts) {
            const delay = Math.round(retry.delayMs * Math.pow(retry.backoff, attempt - 1))
            patchStep(step.id, { status: 'running', result: { ...(out.result || {}), lastError: out.error, retrying: true, nextRetryInMs: delay }, error: `Retrying after error: ${out.error || 'step failed'}` })
            if (delay) await sleep(delay)
          }
        }
        if (!out?.ok) {
          patchStep(step.id, { status: 'failed', result: out?.result || {}, error: out?.error || 'step failed', finishedAt: now() })
          let failed = patchWorkflow(workflowId, { status: 'failed', error: `${step.title}: ${out?.error || 'failed'}`, progress: Math.round(((step.idx - 1) / Math.max(steps.length, 1)) * 100), finishedAt: now() })
          const report = renderWorkflowReport(failed)
          let routed = null
          try {
            const { routeFailure } = await import('./autonomousFailureRouter.js')
            routed = routeFailure({ userId: failed?.userId || workflow.userId || '', source: 'workflow', title: `Workflow failed: ${failed?.title || workflow.title}`, error: `${step.title}: ${out?.error || 'failed'}`, entityType: 'workflow', entityId: workflowId, data: { workflow: failed, step, result: out }, incident: true, notify: false })
          } catch { /* best-effort */ }
          failed = patchWorkflow(workflowId, { result: { ...(failed?.result || {}), report, failure: routed } })
          await notifyWorkflowIfNeeded(failed)
          return
        }
        patchStep(step.id, { status: 'succeeded', result: out, error: '', finishedAt: now() })
        patchWorkflow(workflowId, { status: 'running', progress: Math.round((step.idx / Math.max(steps.length, 1)) * 100) })
      }
      if (cancelled.has(workflowId)) return
      let final = getWorkflow(workflowId)
      final = patchWorkflow(workflowId, {
        status: 'succeeded', progress: 100, finishedAt: now(),
        result: {
          summary: `${final.title} completed`,
          steps: final.steps.map((s) => ({ idx: s.idx, title: s.title, status: s.status, ok: s.status === 'succeeded', preview: clip(s.result, 1200) })),
        },
      })
      const report = renderWorkflowReport(final)
      final = patchWorkflow(workflowId, { result: { ...(final?.result || {}), report } })
      await notifyWorkflowIfNeeded(final)
    } catch (e) {
      let failed = patchWorkflow(workflowId, { status: 'failed', error: e?.message || String(e), finishedAt: now() })
      try {
        const { routeFailure } = await import('./autonomousFailureRouter.js')
        const routed = routeFailure({ userId: failed?.userId || '', source: 'workflow_crash', title: `Workflow crashed: ${failed?.title || workflowId}`, error: e?.message || String(e), entityType: 'workflow', entityId: workflowId, data: { workflow: failed }, incident: true, notify: false })
        failed = patchWorkflow(workflowId, { result: { ...(failed?.result || {}), failure: routed } })
        await notifyWorkflowIfNeeded(failed)
      } catch { /* best-effort */ }
    } finally {
      running.delete(workflowId)
      cancelled.delete(workflowId)
    }
  })()
  return getWorkflow(workflowId)
}

export function retryWorkflow(workflowId) {
  const wf = getWorkflow(workflowId)
  if (!wf) return null
  if (!['failed', 'cancelled'].includes(wf.status)) return startWorkflow(workflowId)
  db.prepare(`UPDATE agent_workflow_steps SET status='queued', error='', attempts=0, finished_at=NULL, updated_at=? WHERE workflow_id=? AND status IN ('failed','cancelled')`).run(now(), workflowId)
  patchWorkflow(workflowId, { status: 'queued', error: '', finishedAt: null })
  return startWorkflow(workflowId)
}

export default { initAgentWorkflows, listAutomationRecipes, createWorkflow, startWorkflow, getWorkflow, listWorkflows, cancelWorkflow, retryWorkflow }
