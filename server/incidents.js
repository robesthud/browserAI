import crypto from 'node:crypto'
import db from './db.js'
import { createWorkflow, startWorkflow } from './agentWorkflows.js'

let initialized = false

function now() { return Date.now() }
function id() { return `inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function stableHash(value = {}) { return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex').slice(0, 16) }

export function initIncidents() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      workflow_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_user_status ON incidents(user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_source ON incidents(source, updated_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents(fingerprint, status);
  `)
  initialized = true
}

function rowToIncident(r) {
  if (!r) return null
  return {
    id: r.id,
    userId: r.user_id,
    source: r.source,
    severity: r.severity,
    status: r.status,
    title: r.title,
    fingerprint: r.fingerprint,
    details: parse(r.details_json, {}),
    workflowId: r.workflow_id || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  }
}

export function listIncidents({ userId = '', status = '', limit = 50 } = {}) {
  initIncidents()
  const max = Math.max(1, Math.min(200, Number(limit) || 50))
  let rows
  if (userId && status) rows = db.prepare(`SELECT * FROM incidents WHERE (user_id=? OR user_id='') AND status=? ORDER BY updated_at DESC LIMIT ?`).all(String(userId), String(status), max)
  else if (userId) rows = db.prepare(`SELECT * FROM incidents WHERE (user_id=? OR user_id='') ORDER BY updated_at DESC LIMIT ?`).all(String(userId), max)
  else if (status) rows = db.prepare('SELECT * FROM incidents WHERE status=? ORDER BY updated_at DESC LIMIT ?').all(String(status), max)
  else rows = db.prepare('SELECT * FROM incidents ORDER BY updated_at DESC LIMIT ?').all(max)
  return rows.map(rowToIncident)
}

export function getIncident(incidentId) {
  initIncidents()
  return rowToIncident(db.prepare('SELECT * FROM incidents WHERE id=?').get(String(incidentId || '')))
}

export function createIncident({ userId = '', source = '', severity = 'medium', title = '', details = {}, fingerprint = '' } = {}) {
  initIncidents()
  const fp = String(fingerprint || stableHash({ source, title, details })).slice(0, 120)
  const existing = db.prepare(`SELECT * FROM incidents WHERE fingerprint=? AND status IN ('open','investigating') ORDER BY created_at DESC LIMIT 1`).get(fp)
  const ts = now()
  if (existing) {
    const merged = { ...parse(existing.details_json, {}), lastSeen: new Date(ts).toISOString(), repeats: Number(parse(existing.details_json, {})?.repeats || 0) + 1, latest: details }
    db.prepare(`UPDATE incidents SET updated_at=?, details_json=? WHERE id=?`).run(ts, JSON.stringify(merged), existing.id)
    return rowToIncident(db.prepare('SELECT * FROM incidents WHERE id=?').get(existing.id))
  }
  const incidentId = id()
  db.prepare(`INSERT INTO incidents (id,user_id,source,severity,status,title,fingerprint,details_json,workflow_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    incidentId, String(userId || ''), String(source || ''), String(severity || 'medium'), 'open', String(title || 'Incident').slice(0, 240), fp,
    JSON.stringify({ ...(details || {}), firstSeen: new Date(ts).toISOString() }), '', ts, ts,
  )
  return getIncident(incidentId)
}

export function updateIncident(incidentId, patch = {}) {
  initIncidents()
  const cur = getIncident(incidentId)
  if (!cur) return null
  const next = { ...cur, ...patch }
  const resolvedAt = next.status === 'resolved' ? (next.resolvedAt || now()) : null
  db.prepare(`UPDATE incidents SET status=?, severity=?, title=?, details_json=?, workflow_id=?, updated_at=?, resolved_at=? WHERE id=?`).run(
    next.status || cur.status,
    next.severity || cur.severity,
    String(next.title || cur.title).slice(0, 240),
    JSON.stringify(next.details || cur.details || {}),
    next.workflowId || cur.workflowId || '',
    now(),
    resolvedAt,
    incidentId,
  )
  return getIncident(incidentId)
}

export function resolveIncident(incidentId, { note = '' } = {}) {
  const inc = getIncident(incidentId)
  if (!inc) return null
  return updateIncident(incidentId, { status: 'resolved', details: { ...(inc.details || {}), resolvedNote: note, resolvedAt: new Date().toISOString() } })
}

export function linkIncidentWorkflow(incidentId, workflowId) {
  const inc = getIncident(incidentId)
  if (!inc) return null
  return updateIncident(incidentId, { status: 'investigating', workflowId, details: { ...(inc.details || {}), workflowId } })
}


function summarizeStepForRca(step = {}) {
  const result = step.result || {}
  const raw = JSON.stringify(result.result || result || {}).slice(0, 1800)
  const stderr = result.result?.stderr || result.error || step.error || ''
  const stdout = result.result?.stdout || ''
  const text = `${step.title || ''}
${step.error || ''}
${stderr}
${stdout}
${raw}`.toLowerCase()
  let category = 'unknown'
  if (/health|connection refused|timeout|unhealthy|failed to connect|curl/.test(text)) category = 'health_check_failure'
  else if (/github|workflow|actions|conclusion|failed/.test(text)) category = 'github_ci_failure'
  else if (/docker|container|compose|port is already allocated/.test(text)) category = 'docker_or_compose_failure'
  else if (/build fail|npm error|syntaxerror|failed to compile|vite/.test(text)) category = 'build_failure'
  else if (/secret|token|permission|unauthorized|forbidden|401|403/.test(text)) category = 'auth_or_secret_failure'
  return {
    idx: step.idx,
    title: step.title,
    status: step.status,
    category,
    error: step.error || result.error || '',
    evidence: String(stderr || stdout || raw || '').slice(0, 1200),
  }
}

export function generateIncidentRcaFromWorkflow(workflow = {}) {
  const failed = (workflow.steps || []).filter((s) => s.status === 'failed')
  const interesting = failed.length ? failed : (workflow.steps || []).filter((s) => s.error || s.status !== 'succeeded')
  const evidence = (interesting.length ? interesting : (workflow.steps || []).slice(-3)).map(summarizeStepForRca)
  const categories = [...new Set(evidence.map((e) => e.category).filter(Boolean))]
  const primary = categories.find((c) => c !== 'unknown') || categories[0] || 'unknown'
  const status = workflow.status || 'unknown'
  const summary = status === 'succeeded'
    ? `Workflow ${workflow.title || workflow.id} completed successfully. No unresolved failure was detected.`
    : `Workflow ${workflow.title || workflow.id} ended with status ${status}. Primary suspected category: ${primary}.`
  const recommendedActions = []
  if (primary === 'health_check_failure') recommendedActions.push('Check browserai container logs and run production_self_heal_restart if policy allows.', 'Verify public /api/health and internal container health separately.')
  else if (primary === 'github_ci_failure') recommendedActions.push('Open GitHub Actions logs for failed jobs.', 'Run GitHub CI diagnostic and create a fix branch/PR if failures are reproducible.')
  else if (primary === 'docker_or_compose_failure') recommendedActions.push('Run docker compose ps/logs and remove stale orphan containers.', 'Retry deploy_safe after confirming the container names are stable.')
  else if (primary === 'build_failure') recommendedActions.push('Inspect build output, run npm test/build locally, then redeploy with rollback protection.')
  else if (primary === 'auth_or_secret_failure') recommendedActions.push('Verify server-side env/vault credentials and rotate exposed tokens if needed.')
  else recommendedActions.push('Run Full BrowserAI diagnostic and inspect linked workflow step outputs.')
  return {
    schema: 'browserai.incident_rca.v1',
    generatedAt: new Date().toISOString(),
    workflowId: workflow.id || '',
    workflowStatus: status,
    primaryCategory: primary,
    summary,
    evidence,
    recommendedActions,
  }
}

export function attachIncidentRcaFromWorkflow(incidentId, workflow = {}) {
  const inc = getIncident(incidentId)
  if (!inc) return null
  const rca = generateIncidentRcaFromWorkflow(workflow)
  const nextStatus = workflow.status === 'succeeded' && inc.status === 'investigating' ? 'open' : inc.status
  return updateIncident(incidentId, { status: nextStatus, details: { ...(inc.details || {}), rca, rcaUpdatedAt: new Date().toISOString() } })
}

export function createIncidentWorkflow({ incident, recipeId = 'browserai_full_diagnostic', userId = '', input = {} } = {}) {
  if (!incident?.id) throw new Error('incident required')
  const wf = createWorkflow({
    userId: userId || incident.userId || '',
    chatId: '',
    recipeId,
    input: { incidentId: incident.id, notifyTelegram: true, ...(input || {}) },
    confirm: false,
    source: 'webhook',
  })
  linkIncidentWorkflow(incident.id, wf.id)
  startWorkflow(wf.id)
  return wf
}

export default { initIncidents, createIncident, listIncidents, getIncident, updateIncident, resolveIncident, linkIncidentWorkflow, createIncidentWorkflow }
