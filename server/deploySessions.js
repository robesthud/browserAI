import db from './db.js'
import { runOpsAction } from './ops.js'
import { notifyDeploySession } from './notifications.js'

let initialized = false
const running = new Set()

function now() { return Date.now() }
function id(prefix = 'dep') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function clip(value, max = 6000) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s
}

export function initDeploySessions() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS deploy_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      title TEXT NOT NULL DEFAULT '',
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      progress INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_sessions_user ON deploy_sessions(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_deploy_sessions_status ON deploy_sessions(status);
    CREATE TABLE IF NOT EXISTS deploy_session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      phase TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_events_session ON deploy_session_events(session_id, created_at);
  `)
  initialized = true
  // A deploy is a production operation; after process restart we do not blindly
  // re-run it. Mark stale in-process sessions as failed but keep their events.
  db.prepare(`UPDATE deploy_sessions SET status='failed', error=COALESCE(NULLIF(error,''),'Server restarted during deploy session'), finished_at=?, updated_at=? WHERE status IN ('queued','running')`).run(now(), now())
}

function rowToEvent(r) {
  return { id: r.id, sessionId: r.session_id, type: r.type, phase: r.phase, message: r.message, data: parse(r.data_json, {}), createdAt: r.created_at }
}

function rowToSession(r) {
  if (!r) return null
  const events = db.prepare('SELECT * FROM deploy_session_events WHERE session_id=? ORDER BY created_at ASC').all(r.id).map(rowToEvent)
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    title: r.title,
    input: parse(r.input_json, {}),
    result: parse(r.result_json, {}),
    error: r.error || '',
    progress: r.progress || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    events,
  }
}

export function getDeploySession(sessionId) {
  initDeploySessions()
  return rowToSession(db.prepare('SELECT * FROM deploy_sessions WHERE id=?').get(String(sessionId || '')))
}

export function listDeploySessions({ userId = '', limit = 30 } = {}) {
  initDeploySessions()
  const max = Math.max(1, Math.min(100, Number(limit) || 30))
  const rows = userId
    ? db.prepare('SELECT * FROM deploy_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(String(userId || ''), max)
    : db.prepare('SELECT * FROM deploy_sessions ORDER BY updated_at DESC LIMIT ?').all(max)
  return rows.map(rowToSession)
}

function patchSession(sessionId, patch = {}) {
  const cur = getDeploySession(sessionId)
  if (!cur) return null
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE deploy_sessions SET status=?, result_json=?, error=?, progress=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status || cur.status,
    JSON.stringify(next.result || cur.result || {}),
    next.error || '',
    Math.max(0, Math.min(100, Number(next.progress ?? cur.progress ?? 0))),
    now(),
    next.finishedAt || null,
    sessionId,
  )
  return getDeploySession(sessionId)
}

export function addDeployEvent(sessionId, { type = 'info', phase = '', message = '', data = {} } = {}) {
  initDeploySessions()
  const eventId = id('depevt')
  db.prepare('INSERT INTO deploy_session_events (id,session_id,type,phase,message,data_json,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(eventId, sessionId, String(type || 'info'), String(phase || ''), String(message || '').slice(0, 4000), JSON.stringify(data || {}), now())
  return eventId
}

async function runStep(sessionId, { phase, service = 'browserai', action, params = {}, confirm = true, progress = 0, successMessage = '' }) {
  addDeployEvent(sessionId, { type: 'info', phase, message: `Starting ${service}.${action}`, data: { params } })
  patchSession(sessionId, { status: 'running', progress })
  const started = now()
  const result = await runOpsAction({ service, action, params, confirm })
  const ok = Number(result?.exitCode ?? 0) === 0 && !result?.requiresConfirmation
  addDeployEvent(sessionId, {
    type: ok ? 'success' : 'error',
    phase,
    message: ok ? (successMessage || `${service}.${action} OK`) : `${service}.${action} failed`,
    data: { exitCode: result?.exitCode, stdout: clip(result?.stdout || ''), stderr: clip(result?.stderr || ''), ms: now() - started },
  })
  if (!ok) throw new Error(result?.stderr || result?.error || result?.message || `${service}.${action} failed`)
  return result
}

export function renderDeploySessionReport(session) {
  if (!session) return ''
  const icon = session.status === 'succeeded' ? '✅' : session.status === 'failed' ? '❌' : '⏳'
  const lines = [
    `${icon} ${session.title || 'Deploy session'}`,
    '',
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    session.error ? `Error: ${session.error}` : '',
    '',
    'Timeline:',
  ].filter(Boolean)
  for (const e of session.events || []) {
    const mark = e.type === 'success' ? '✓' : e.type === 'error' ? '✗' : '•'
    lines.push(`${mark} ${e.phase || 'step'} — ${e.message}`)
  }
  if (session.result?.commit) lines.push('', `Commit: ${session.result.commit}`)
  return lines.join('\n')
}

export function createDeploySession({ userId = '', title = 'Safe BrowserAI deploy', input = {}, autostart = true } = {}) {
  initDeploySessions()
  const sessionId = id('dep')
  const ts = now()
  db.prepare(`INSERT INTO deploy_sessions (id,user_id,status,title,input_json,result_json,created_at,updated_at) VALUES (?,?,?,?,?,'{}',?,?)`)
    .run(sessionId, String(userId || ''), 'queued', String(title || 'Deploy'), JSON.stringify(input || {}), ts, ts)
  addDeployEvent(sessionId, { type: 'info', phase: 'created', message: 'Deploy session created', data: input || {} })
  if (autostart !== false) setTimeout(() => startDeploySession(sessionId), 10).unref?.()
  return getDeploySession(sessionId)
}

export function startDeploySession(sessionId) {
  initDeploySessions()
  const session = getDeploySession(sessionId)
  if (!session || running.has(sessionId)) return session
  running.add(sessionId)
  ;(async () => {
    try {
      patchSession(sessionId, { status: 'running', progress: 2 })
      const sync = await runStep(sessionId, { phase: 'preflight', action: 'sync_check', confirm: true, progress: 10, successMessage: 'Preflight sync/health OK' })
      await runStep(sessionId, { phase: 'deploy', action: 'deploy_safe', confirm: true, progress: 35, successMessage: 'Deploy helper started' })
      await runStep(sessionId, { phase: 'health', action: 'deploy_wait', params: { timeout_sec: session.input?.timeoutSec || 180, interval_sec: 5 }, confirm: true, progress: 70, successMessage: 'Health check OK' })
      await runStep(sessionId, { phase: 'postcheck', action: 'docker_ps', confirm: true, progress: 82, successMessage: 'Docker status collected' })
      const logs = await runStep(sessionId, { phase: 'logs', action: 'docker_logs_recent', params: { service: 'browserai', tail: 120 }, confirm: true, progress: 90, successMessage: 'Recent logs collected' })
      const result = {
        preflight: { stdout: clip(sync.stdout || ''), stderr: clip(sync.stderr || '') },
        logs: { stdout: clip(logs.stdout || ''), stderr: clip(logs.stderr || '') },
        completedAt: new Date().toISOString(),
      }
      let done = patchSession(sessionId, { status: 'succeeded', progress: 100, result, finishedAt: now() })
      done = patchSession(sessionId, { result: { ...result, report: renderDeploySessionReport(done) } })
      addDeployEvent(sessionId, { type: 'success', phase: 'done', message: 'Deploy session completed successfully', data: { report: done.result?.report } })
      try { notifyDeploySession(done) } catch { /* best-effort */ }
    } catch (e) {
      const failed = patchSession(sessionId, { status: 'failed', progress: 100, error: e?.message || String(e), finishedAt: now() })
      addDeployEvent(sessionId, { type: 'error', phase: 'failed', message: e?.message || String(e), data: { report: renderDeploySessionReport(failed) } })
      try { notifyDeploySession(failed) } catch { /* best-effort */ }
    } finally {
      running.delete(sessionId)
    }
  })()
  return getDeploySession(sessionId)
}

export default { initDeploySessions, createDeploySession, startDeploySession, getDeploySession, listDeploySessions, addDeployEvent, renderDeploySessionReport }
