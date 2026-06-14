import db from './db.js'
import { executeAutoFixRecommendation, recommendAutoFix } from './failureClassifier.js'
import { createNotification } from './notifications.js'
import { getOperatorMission } from './operatorMode.js'
import { getDeploySession } from './deploySessions.js'
import { getWorkflow } from './agentWorkflows.js'
import { getJob } from './jobs.js'
import { resolveIncident } from './incidents.js'

let initialized = false
let supervisorTimer = null

function now() { return Date.now() }
function id(prefix = 'rec') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function enabled() { return process.env.AUTONOMOUS_RECOVERY_ENABLED !== '0' }
function terminal(status = '') { return ['succeeded', 'failed', 'cancelled'].includes(String(status || '')) }

export function initAutonomousRecovery() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS autonomous_recovery_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'started',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_entity ON autonomous_recovery_actions(entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_recovery_user ON autonomous_recovery_actions(user_id, created_at);
  `)
  try { db.prepare(`ALTER TABLE autonomous_recovery_actions ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''`).run() } catch { /* exists */ }
  try { db.prepare(`ALTER TABLE autonomous_recovery_actions ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0`).run() } catch { /* exists */ }
  try { db.prepare(`ALTER TABLE autonomous_recovery_actions ADD COLUMN outcome_json TEXT NOT NULL DEFAULT '{}'`).run() } catch { /* exists */ }
  try { db.prepare(`ALTER TABLE autonomous_recovery_actions ADD COLUMN finished_at INTEGER`).run() } catch { /* exists */ }
  initialized = true
}

function rowToRecovery(r) {
  if (!r) return null
  return {
    id: r.id,
    userId: r.user_id,
    source: r.source,
    entityType: r.entity_type,
    entityId: r.entity_id,
    category: r.category,
    action: r.action,
    status: r.status,
    parentId: r.parent_id || '',
    chainDepth: Number(r.chain_depth || 0),
    result: parse(r.result_json, {}),
    outcome: parse(r.outcome_json, {}),
    error: r.error || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  }
}

export function getRecoveryAction(id = '') {
  initAutonomousRecovery()
  return rowToRecovery(db.prepare('SELECT * FROM autonomous_recovery_actions WHERE id=?').get(String(id || '')))
}

export function listRecoveryActions({ userId = '', entityType = '', entityId = '', limit = 50 } = {}) {
  initAutonomousRecovery()
  const max = Math.max(1, Math.min(200, Number(limit) || 50))
  let rows
  if (entityType && entityId) rows = db.prepare('SELECT * FROM autonomous_recovery_actions WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC LIMIT ?').all(String(entityType), String(entityId), max)
  else if (userId) rows = db.prepare('SELECT * FROM autonomous_recovery_actions WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(String(userId), max)
  else rows = db.prepare('SELECT * FROM autonomous_recovery_actions ORDER BY created_at DESC LIMIT ?').all(max)
  return rows.map(rowToRecovery)
}

export function recoveryGraph({ userId = '', limit = 100 } = {}) {
  const nodes = listRecoveryActions({ userId, limit })
  const edges = nodes.filter((n) => n.parentId).map((n) => ({ from: n.parentId, to: n.id }))
  return { nodes, edges }
}

function createRecoveryRow({ userId = '', source = '', entityType = '', entityId = '', category = '', action = '', parentId = '', chainDepth = 0 } = {}) {
  initAutonomousRecovery()
  const recoveryId = id('rec')
  const ts = now()
  db.prepare(`INSERT INTO autonomous_recovery_actions (id,user_id,source,entity_type,entity_id,category,action,status,result_json,parent_id,chain_depth,outcome_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'started','{}',?,?,'{}',?,?)`).run(
    recoveryId, String(userId || ''), String(source || ''), String(entityType || ''), String(entityId || ''), String(category || ''), String(action || ''),
    String(parentId || ''), Number(chainDepth || 0), ts, ts,
  )
  return recoveryId
}

function patchRecovery(id, patch = {}) {
  initAutonomousRecovery()
  const cur = db.prepare('SELECT * FROM autonomous_recovery_actions WHERE id=?').get(id)
  if (!cur) return null
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE autonomous_recovery_actions SET status=?, result_json=?, outcome_json=?, error=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status || cur.status,
    JSON.stringify(next.result || parse(cur.result_json, {})),
    JSON.stringify(next.outcome || parse(cur.outcome_json, {})),
    next.error || '',
    now(),
    next.finishedAt ?? next.finished_at ?? cur.finished_at ?? null,
    id,
  )
  return getRecoveryAction(id)
}

export function recoverySummary({ userId = '' } = {}) {
  initAutonomousRecovery()
  const rows = userId
    ? db.prepare('SELECT status, COUNT(*) c FROM autonomous_recovery_actions WHERE user_id=? GROUP BY status').all(String(userId))
    : db.prepare('SELECT status, COUNT(*) c FROM autonomous_recovery_actions GROUP BY status').all()
  return Object.fromEntries(rows.map((r) => [r.status, r.c]))
}

function recentRecoveryExists({ entityType = '', entityId = '', category = '', windowMs = 60 * 60 * 1000 } = {}) {
  initAutonomousRecovery()
  if (!entityType || !entityId) return false
  const row = db.prepare(`SELECT id FROM autonomous_recovery_actions WHERE entity_type=? AND entity_id=? AND category=? AND created_at>? LIMIT 1`)
    .get(String(entityType), String(entityId), String(category || ''), now() - windowMs)
  return Boolean(row)
}

function tooManyRecent(userId = '') {
  initAutonomousRecovery()
  const maxPerHour = Math.max(1, Number(process.env.AUTONOMOUS_RECOVERY_MAX_PER_HOUR || 5))
  const row = db.prepare(`SELECT COUNT(*) c FROM autonomous_recovery_actions WHERE user_id=? AND created_at>?`).get(String(userId || ''), now() - 60 * 60 * 1000)
  return Number(row?.c || 0) >= maxPerHour
}

export function shouldAutoRecover({ recommendation, source = '', entityType = '', entityId = '', userId = '', parentId = '', chainDepth = 0 } = {}) {
  initAutonomousRecovery()
  if (!enabled()) return { ok: false, reason: 'autonomous recovery disabled' }
  if (!recommendation) return { ok: false, reason: 'no recommendation' }
  if (recommendation.requiresApproval) return { ok: false, reason: 'requires approval' }
  if (!recommendation.safeToAutoStart) return { ok: false, reason: 'not marked safe to auto-start' }
  if (tooManyRecent(userId)) return { ok: false, reason: 'user hourly recovery limit reached' }
  const maxDepth = Math.max(0, Number(process.env.AUTONOMOUS_RECOVERY_MAX_CHAIN_DEPTH || 2))
  if (Number(chainDepth || 0) > maxDepth) return { ok: false, reason: `max recovery chain depth ${maxDepth} reached` }
  const category = recommendation.classification?.category || ''
  if (recentRecoveryExists({ entityType, entityId, category })) return { ok: false, reason: 'recent recovery already exists for this entity/category' }
  if (/auto[_-]?recovery|ci-auto-fix|recovery/i.test(source) && !parentId) return { ok: false, reason: 'source is recovery loop' }
  return { ok: true, reason: 'safe auto recovery allowed' }
}

function spawnedEntityFromResult(result = {}) {
  if (result.mission?.id) return { type: 'mission', id: result.mission.id }
  if (result.deploySession?.id) return { type: 'deploy', id: result.deploySession.id }
  if (result.workflow?.id) return { type: 'workflow', id: result.workflow.id }
  return null
}

function readSpawnedStatus(ent) {
  if (!ent?.id) return null
  if (ent.type === 'mission') return getOperatorMission(ent.id)
  if (ent.type === 'deploy') return getDeploySession(ent.id)
  if (ent.type === 'workflow') return getWorkflow(ent.id)
  if (ent.type === 'job') return getJob(ent.id)
  return null
}

export function evaluateRecoveryAction(id = '') {
  const rec = getRecoveryAction(id)
  if (!rec || terminal(rec.status)) return rec
  const ent = rec.result?.spawnedEntity || spawnedEntityFromResult(rec.result || {})
  if (!ent) return rec
  const target = readSpawnedStatus(ent)
  if (!target || !target.status) return rec
  if (!terminal(target.status)) {
    return patchRecovery(id, { status: 'monitoring', outcome: { spawnedEntity: ent, targetStatus: target.status, checkedAt: new Date().toISOString() } })
  }
  const ok = target.status === 'succeeded'
  const recovery = patchRecovery(id, {
    status: ok ? 'succeeded' : 'failed',
    error: ok ? '' : (target.error || `${ent.type} ${target.status}`),
    outcome: { spawnedEntity: ent, targetStatus: target.status, targetError: target.error || '', checkedAt: new Date().toISOString() },
    finishedAt: now(),
  })
  if (ok && rec.result?.incidentId) {
    try { resolveIncident(rec.result.incidentId, { note: `resolved by recovery ${rec.id}` }) } catch { /* best-effort */ }
  }
  return recovery
}

export function superviseRecoveries({ limit = 50 } = {}) {
  initAutonomousRecovery()
  const rows = db.prepare(`SELECT id FROM autonomous_recovery_actions WHERE status IN ('started','monitoring') ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 50)))
  return rows.map((r) => evaluateRecoveryAction(r.id)).filter(Boolean)
}

export function maybeAutoRecoverFailure({ userId = '', source = '', entityType = '', entityId = '', input = {}, recommendation = null } = {}) {
  initAutonomousRecovery()
  const rec = recommendation || recommendAutoFix(input)
  const parentId = input.parentRecoveryId || ''
  const parent = parentId ? getRecoveryAction(parentId) : null
  const chainDepth = parent ? Number(parent.chainDepth || 0) + 1 : Number(input.chainDepth || 0)
  const gate = shouldAutoRecover({ recommendation: rec, source, entityType, entityId, userId, parentId, chainDepth })
  if (!gate.ok) return { attempted: false, gate, recommendation: rec }
  const recoveryId = createRecoveryRow({ userId, source, entityType, entityId, category: rec.classification?.category || '', action: rec.action || '', parentId, chainDepth })
  try {
    const result = executeAutoFixRecommendation({ userId, input: { ...(input || {}), source: 'auto_recovery', entityType, entityId, parentRecoveryId: recoveryId, chainDepth }, confirm: false })
    const incidentId = input.incidentId || result?.incident?.id || ''
    const spawnedEntity = spawnedEntityFromResult(result)
    const recovery = patchRecovery(recoveryId, { status: spawnedEntity ? 'monitoring' : 'started', result: { ...result, spawnedEntity, incidentId } })
    try {
      createNotification({
        userId,
        kind: 'auto_recovery_started',
        severity: rec.classification?.severity === 'critical' ? 'high' : 'medium',
        title: `Auto recovery started: ${rec.classification?.category || rec.action}`,
        message: rec.description || 'Autonomous recovery was started.',
        entityType,
        entityId,
        data: { recovery, recommendation: rec },
      })
    } catch { /* best-effort */ }
    return { attempted: true, gate, recovery, recommendation: rec }
  } catch (e) {
    const recovery = patchRecovery(recoveryId, { status: 'failed', error: e?.message || String(e), result: { recommendation: rec, code: e?.code || '' }, finishedAt: now() })
    return { attempted: true, gate, recovery, recommendation: rec, error: e?.message || String(e) }
  }
}

export function startRecoverySupervisor() {
  initAutonomousRecovery()
  if (supervisorTimer) return
  const interval = Math.max(10_000, Number(process.env.AUTONOMOUS_RECOVERY_SUPERVISOR_MS || 30_000))
  supervisorTimer = setInterval(() => {
    try { superviseRecoveries() } catch (e) { console.warn('[recovery] supervisor failed:', e?.message || e) }
  }, interval)
  supervisorTimer.unref?.()
  setTimeout(() => { try { superviseRecoveries() } catch { /* best-effort */ } }, 5000).unref?.()
  console.log(`[recovery] supervisor started interval=${interval}ms`)
}

export function stopRecoverySupervisor() {
  if (supervisorTimer) clearInterval(supervisorTimer)
  supervisorTimer = null
}

export default { initAutonomousRecovery, maybeAutoRecoverFailure, shouldAutoRecover, listRecoveryActions, recoverySummary, recoveryGraph, superviseRecoveries, evaluateRecoveryAction, startRecoverySupervisor }

