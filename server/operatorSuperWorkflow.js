import db from './db.js'
import {
  startOperatorCodeTask,
  getOperatorCodeTask,
  reviewOperatorCodeTask,
  finalizeOperatorCodeTask,
  waitOperatorCodeTaskCi,
  startOperatorCodeCiAutoFix,
  mergeOperatorCodeTaskPr,
} from './operatorCode.js'
import { createDeploySession, getDeploySession } from './deploySessions.js'

let initialized = false
const running = new Set()
const cancelled = new Set()

function now() { return Date.now() }
function id(prefix = 'super') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))) }
function terminal(status = '') { return ['succeeded', 'failed', 'cancelled'].includes(String(status || '')) }

export function initOperatorSuperWorkflows() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_super_workflows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      mission_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      goal TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '{}',
      state_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_super_user ON operator_super_workflows(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_super_mission ON operator_super_workflows(mission_id);
  `)
  initialized = true
  const rows = db.prepare(`SELECT id FROM operator_super_workflows WHERE status IN ('queued','running','waiting_code','reviewing','finalizing','waiting_ci','auto_fixing','merging','deploying') ORDER BY created_at ASC LIMIT 20`).all()
  for (const r of rows) setTimeout(() => runSuperWorkflow(r.id), 1000).unref?.()
}

function rowToSuper(r) {
  if (!r) return null
  const sw = {
    id: r.id,
    userId: r.user_id,
    missionId: r.mission_id,
    projectId: r.project_id,
    status: r.status,
    goal: r.goal,
    options: parse(r.options_json, {}),
    state: parse(r.state_json, {}),
    result: parse(r.result_json, {}),
    error: r.error || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  }
  if (sw.state?.codeTaskId) sw.codeTask = getOperatorCodeTask(sw.state.codeTaskId)
  if (sw.state?.deploySessionId) sw.deploySession = getDeploySession(sw.state.deploySessionId)
  return sw
}

export function getSuperWorkflow(id) {
  initOperatorSuperWorkflows()
  return rowToSuper(db.prepare('SELECT * FROM operator_super_workflows WHERE id=?').get(String(id || '')))
}

export function listSuperWorkflows({ userId = '', limit = 30 } = {}) {
  initOperatorSuperWorkflows()
  const max = Math.max(1, Math.min(100, Number(limit) || 30))
  const rows = userId
    ? db.prepare('SELECT * FROM operator_super_workflows WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(String(userId), max)
    : db.prepare('SELECT * FROM operator_super_workflows ORDER BY updated_at DESC LIMIT ?').all(max)
  return rows.map(rowToSuper)
}

function patchSuper(id, patch = {}) {
  const cur = getSuperWorkflow(id)
  if (!cur) return null
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE operator_super_workflows SET status=?, state_json=?, result_json=?, error=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status || cur.status,
    JSON.stringify(next.state || cur.state || {}),
    JSON.stringify(next.result || cur.result || {}),
    next.error || '',
    now(),
    next.finishedAt || null,
    id,
  )
  if (cur.missionId) {
    const isTerm = terminal(next.status)
    db.prepare(`UPDATE operator_missions SET status=?, result_json=?, error=?, updated_at=?, finished_at=? WHERE id=?`).run(
      next.status || cur.status,
      JSON.stringify({ ...(next.result || cur.result || {}), superWorkflowId: id, codeTaskId: next.state?.codeTaskId || cur.state?.codeTaskId || '' }),
      next.error || '',
      now(),
      isTerm ? now() : null,
      cur.missionId,
    )
  }
  return getSuperWorkflow(id)
}

async function emit(superWorkflow, type, title, message = '', data = {}) {
  if (!superWorkflow?.missionId) return
  try {
    const { addOperatorMissionEvent } = await import('./operatorMode.js')
    addOperatorMissionEvent({ missionId: superWorkflow.missionId, userId: superWorkflow.userId, type, title, message, data: { superWorkflowId: superWorkflow.id, ...data } })
  } catch { /* best-effort */ }
}

async function waitCodeTask(taskId, superId, phase = 'waiting_code') {
  while (true) {
    if (cancelled.has(superId)) throw new Error('super workflow cancelled')
    const task = getOperatorCodeTask(taskId)
    if (!task) throw new Error('code task disappeared')
    if (terminal(task.status)) return task
    patchSuper(superId, { status: phase, state: { ...(getSuperWorkflow(superId)?.state || {}), codeTaskStatus: task.status } })
    await sleep(5000)
  }
}

async function waitDeploy(sessionId, superId) {
  while (true) {
    if (cancelled.has(superId)) throw new Error('super workflow cancelled')
    const session = getDeploySession(sessionId)
    if (!session) throw new Error('deploy session disappeared')
    if (terminal(session.status)) return session
    patchSuper(superId, { status: 'deploying', state: { ...(getSuperWorkflow(superId)?.state || {}), deployStatus: session.status, deployProgress: session.progress } })
    await sleep(5000)
  }
}

function buildFinalReport(sw, codeTask, deploySession = null) {
  const lines = [
    `# Super Operator Workflow Report`,
    '',
    `- Workflow: \`${sw.id}\``,
    `- Goal: ${sw.goal}`,
    `- Status: **${sw.status}**`,
    codeTask ? `- Code task: \`${codeTask.id}\` (${codeTask.status})` : '',
    codeTask?.result?.finalize?.pullRequest?.url ? `- PR: ${codeTask.result.finalize.pullRequest.url}` : '',
    codeTask?.result?.finalize?.commit ? `- Commit: \`${codeTask.result.finalize.commit}\`` : '',
    codeTask?.result?.ci ? `- CI: **${codeTask.result.ci.status}**` : '',
    codeTask?.result?.merge?.ok ? `- Merge: **done** (${codeTask.result.merge.sha || ''})` : '',
    deploySession ? `- Deploy: **${deploySession.status}** (${deploySession.id})` : '',
    '',
    '## Summary',
    codeTask?.result?.report || codeTask?.error || '',
    deploySession?.result?.report ? `\n## Deploy report\n\n${deploySession.result.report}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

export function startSuperOperatorWorkflow({ userId = '', missionId = '', project = {}, goal = '', options = {}, autostart = true } = {}) {
  initOperatorSuperWorkflows()
  const swId = id('super')
  const ts = now()
  const opts = {
    autoFinalize: options.autoFinalize !== false,
    autoWaitCi: options.autoWaitCi !== false,
    autoFixCi: options.autoFixCi !== false,
    maxCiFixAttempts: Math.max(1, Math.min(5, Number(options.maxCiFixAttempts || 2))),
    autoMerge: options.autoMerge === true,
    autoDeploy: options.autoDeploy === true,
    confirmMerge: options.confirmMerge === true,
    confirmDeploy: options.confirmDeploy === true,
  }
  db.prepare(`INSERT INTO operator_super_workflows (id,user_id,mission_id,project_id,status,goal,options_json,state_json,result_json,created_at,updated_at)
    VALUES (?,?,?,?,? ,?,?, '{}','{}',?,?)`).run(swId, String(userId || ''), String(missionId || ''), project?.id || 'browserai', 'queued', String(goal || '').slice(0, 4000), JSON.stringify(opts), ts, ts)
  const sw = getSuperWorkflow(swId)
  emit(sw, 'info', 'Super workflow created', goal, { options: opts }).catch(() => {})
  if (autostart !== false) setTimeout(() => runSuperWorkflow(swId), 10).unref?.()
  return getSuperWorkflow(swId)
}

export function cancelSuperWorkflow(id) {
  const sw = getSuperWorkflow(id)
  if (!sw) return null
  if (terminal(sw.status)) return sw
  cancelled.add(id)
  emit(sw, 'warn', 'Super workflow cancelled', 'Cancelled by user').catch(() => {})
  return patchSuper(id, { status: 'cancelled', error: 'cancelled by user', finishedAt: now() })
}

export function resumeSuperWorkflow(id) {
  const sw = getSuperWorkflow(id)
  if (!sw) return null
  if (!['failed', 'cancelled'].includes(sw.status)) return sw
  cancelled.delete(id)
  emit(sw, 'info', 'Super workflow resumed', 'Resume requested').catch(() => {})
  patchSuper(id, { status: 'queued', error: '', finishedAt: null })
  setTimeout(() => runSuperWorkflow(id), 10).unref?.()
  return getSuperWorkflow(id)
}

export function runSuperWorkflow(id) {
  initOperatorSuperWorkflows()
  const sw = getSuperWorkflow(id)
  if (!sw || running.has(id) || terminal(sw.status)) return sw
  running.add(id)
  ;(async () => {
    try {
      if (cancelled.has(id)) return
      let current = getSuperWorkflow(id)
      const opts = current.options || {}
      let state = current.state || {}
      patchSuper(id, { status: 'running' })

      let codeTask = state.codeTaskId ? getOperatorCodeTask(state.codeTaskId) : null
      if (!codeTask) {
        codeTask = startOperatorCodeTask({ userId: current.userId, missionId: current.missionId, project: current.result?.project || { id: current.projectId }, goal: current.goal, mode: 'full_dev_cycle' })
        state = { ...state, codeTaskId: codeTask.id }
        current = patchSuper(id, { status: 'waiting_code', state })
        await emit(current, 'info', 'Code task started', codeTask.id, { codeTaskId: codeTask.id, branch: codeTask.branch })
      }

      codeTask = await waitCodeTask(codeTask.id, id)
      if (codeTask.status !== 'succeeded') throw new Error(`code task ${codeTask.status}: ${codeTask.error || ''}`)
      current = patchSuper(id, { status: 'reviewing', state: { ...state, codeTaskId: codeTask.id } })
      await emit(current, 'info', 'Reviewing code task', codeTask.id)
      codeTask = await reviewOperatorCodeTask({ taskId: codeTask.id })
      if (!codeTask.result?.review?.approvedForMerge) throw new Error(`review blocked merge: ${(codeTask.result?.review?.blockers || []).join('; ')}`)

      if (opts.autoFinalize && !codeTask.result?.finalize?.committed) {
        current = patchSuper(id, { status: 'finalizing', state })
        await emit(current, 'info', 'Finalizing PR', codeTask.id)
        codeTask = await finalizeOperatorCodeTask({ taskId: codeTask.id, push: true, createPr: true })
      }

      if (opts.autoWaitCi && codeTask.result?.finalize?.pushed) {
        current = patchSuper(id, { status: 'waiting_ci', state })
        await emit(current, 'info', 'Waiting CI', codeTask.branch)
        codeTask = await waitOperatorCodeTaskCi({ taskId: codeTask.id, timeoutSec: 900, intervalSec: 15 })
        if (codeTask.result?.ci?.ok !== true && opts.autoFixCi) {
          current = patchSuper(id, { status: 'auto_fixing', state })
          await emit(current, 'warn', 'CI failed, starting auto-fix', codeTask.id, { ci: codeTask.result?.ci })
          codeTask = startOperatorCodeCiAutoFix({ taskId: codeTask.id, maxAttempts: opts.maxCiFixAttempts || 2 })
          codeTask = await waitCodeTask(codeTask.id, id, 'auto_fixing')
        }
        if (codeTask.result?.ci?.ok !== true) throw new Error(`CI not green: ${codeTask.result?.ci?.status || codeTask.error || 'unknown'}`)
      }

      let deploySession = state.deploySessionId ? getDeploySession(state.deploySessionId) : null
      if (opts.autoMerge || opts.autoDeploy) {
        if (!opts.confirmMerge && !opts.confirmDeploy) throw new Error('merge/deploy requires confirmation')
        current = patchSuper(id, { status: 'merging', state })
        await emit(current, 'info', opts.autoDeploy ? 'Merging PR and deploying' : 'Merging PR', codeTask.id)
        codeTask = await mergeOperatorCodeTaskPr({ taskId: codeTask.id, mergeMethod: 'squash', deploy: Boolean(opts.autoDeploy), confirmDeploy: Boolean(opts.confirmDeploy) })
        if (codeTask.result?.deployWorkflowId) {
          state = { ...state, deployWorkflowId: codeTask.result.deployWorkflowId }
        }
      }

      if (opts.autoDeploy && !codeTask.result?.deployWorkflowId) {
        current = patchSuper(id, { status: 'deploying', state })
        deploySession = createDeploySession({ userId: current.userId, title: `Deploy for ${current.goal.slice(0, 80)}`, input: { superWorkflowId: id, codeTaskId: codeTask.id } })
        state = { ...state, deploySessionId: deploySession.id }
        await emit(current, 'info', 'Deploy session started', deploySession.id)
        deploySession = await waitDeploy(deploySession.id, id)
        if (deploySession.status !== 'succeeded') throw new Error(`deploy ${deploySession.status}: ${deploySession.error || ''}`)
      }

      current = getSuperWorkflow(id)
      const report = buildFinalReport({ ...current, status: 'succeeded' }, codeTask, deploySession)
      current = patchSuper(id, { status: 'succeeded', state, result: { ...(current.result || {}), codeTaskId: codeTask.id, deploySessionId: deploySession?.id || '', report }, error: '', finishedAt: now() })
      await emit(current, 'success', 'Super workflow completed', current.id, { report })
    } catch (e) {
      const failed = patchSuper(id, { status: 'failed', error: e?.message || String(e), finishedAt: now() })
      await emit(failed, 'error', 'Super workflow failed', e?.message || String(e))
    } finally {
      running.delete(id)
    }
  })()
  return getSuperWorkflow(id)
}

export default { initOperatorSuperWorkflows, startSuperOperatorWorkflow, runSuperWorkflow, getSuperWorkflow, listSuperWorkflows, cancelSuperWorkflow, resumeSuperWorkflow }
