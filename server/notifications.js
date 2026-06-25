import db from './db.js'
import { notifyUser } from './push.js'
import { runOpsAction } from './ops.js'

let initialized = false

function now() { return Date.now() }
function id(prefix = 'ntf') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }
function severityRank(s = 'info') { return ({ info: 1, success: 1, low: 1, medium: 2, warning: 2, high: 3, critical: 4, error: 3 })[s] || 1 }

export function initNotifications() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'info',
      status TEXT NOT NULL DEFAULT 'unread',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(entity_type, entity_id);
  `)
  initialized = true
}

function rowToNotification(r) {
  if (!r) return null
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    title: r.title,
    message: r.message,
    entityType: r.entity_type,
    entityId: r.entity_id,
    data: parse(r.data_json, {}),
    createdAt: r.created_at,
    readAt: r.read_at,
  }
}

export function listNotifications({ userId = '', status = '', limit = 50 } = {}) {
  initNotifications()
  const max = Math.max(1, Math.min(200, Number(limit) || 50))
  let rows
  if (userId && status) rows = db.prepare(`SELECT * FROM notifications WHERE (user_id=? OR user_id='') AND status=? ORDER BY created_at DESC LIMIT ?`).all(String(userId), String(status), max)
  else if (userId) rows = db.prepare(`SELECT * FROM notifications WHERE (user_id=? OR user_id='') ORDER BY created_at DESC LIMIT ?`).all(String(userId), max)
  else rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(max)
  return rows.map(rowToNotification)
}

export function notificationSummary({ userId = '' } = {}) {
  initNotifications()
  const rows = userId
    ? db.prepare(`SELECT severity, COUNT(*) c FROM notifications WHERE (user_id=? OR user_id='') AND status='unread' GROUP BY severity`).all(String(userId))
    : db.prepare(`SELECT severity, COUNT(*) c FROM notifications WHERE status='unread' GROUP BY severity`).all()
  const bySeverity = Object.fromEntries(rows.map((r) => [r.severity, r.c]))
  const unread = rows.reduce((s, r) => s + Number(r.c || 0), 0)
  const maxSeverity = rows.reduce((m, r) => severityRank(r.severity) > severityRank(m) ? r.severity : m, 'info')
  return { unread, bySeverity, maxSeverity }
}

async function maybeSendChannels(notification, { push = true, telegram = true } = {}) {
  const sev = severityRank(notification.severity)
  const url = notification.data?.url || (notification.entityType === 'incident' ? '/admin/agent' : '/admin/agent')
  if (push && notification.userId) {
    notifyUser(notification.userId, {
      title: notification.title,
      body: notification.message,
      tag: `browserai-${notification.kind}-${notification.entityId || notification.id}`,
      data: { url, notificationId: notification.id, entityType: notification.entityType, entityId: notification.entityId },
    }).catch(() => {})
  }
  if (telegram && sev >= severityRank(process.env.NOTIFY_TELEGRAM_MIN_SEVERITY || 'high')) {
    runOpsAction({
      service: 'telegram', action: 'notify_admin', confirm: true,
      params: { text: `${notification.severity.toUpperCase()} ${notification.title}\n\n${notification.message}\n\n${notification.entityType ? `${notification.entityType}: ${notification.entityId}` : ''}`.slice(0, 3900) },
    }).catch(() => {})
  }
}

export function createNotification({ userId = '', kind = '', severity = 'info', title = '', message = '', entityType = '', entityId = '', data = {}, channels = {} } = {}) {
  initNotifications()
  const notificationId = id('ntf')
  const ts = now()
  // B — guard against circular-ref in data (JSON.stringify would throw)
  const dataJson = (() => {
    try { return JSON.stringify(data || {}) }
    catch { return '{}' }
  })()
  db.prepare(`INSERT INTO notifications (id,user_id,kind,severity,status,title,message,entity_type,entity_id,data_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    notificationId, String(userId || ''), String(kind || ''), String(severity || 'info'), 'unread',
    String(title || '').slice(0, 240), String(message || '').slice(0, 2000), String(entityType || ''), String(entityId || ''), dataJson, ts,
  )
  const n = rowToNotification(db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId))
  maybeSendChannels(n, channels).catch(() => {})
  return n
}

export function markNotificationRead({ userId = '', id: notificationId = '' } = {}) {
  initNotifications()
  const r = db.prepare(`UPDATE notifications SET status='read', read_at=? WHERE id=? AND (user_id=? OR user_id='')`).run(now(), notificationId, String(userId || ''))
  return { updated: r.changes }
}

export function markAllNotificationsRead({ userId = '' } = {}) {
  initNotifications()
  const r = db.prepare(`UPDATE notifications SET status='read', read_at=? WHERE status='unread' AND (user_id=? OR user_id='')`).run(now(), String(userId || ''))
  return { updated: r.changes }
}

export function notifyIncident(incident) {
  if (!incident) return null
  return createNotification({
    userId: incident.userId || '',
    kind: 'incident_opened',
    severity: incident.severity === 'low' ? 'medium' : incident.severity || 'high',
    title: `Incident: ${incident.title}`,
    message: `${incident.source || 'unknown source'} · ${incident.status}`,
    entityType: 'incident',
    entityId: incident.id,
    data: { url: '/admin/agent', incident },
  })
}

export function notifyWorkflow(workflow) {
  if (!workflow) return null
  const failed = workflow.status === 'failed'
  return createNotification({
    userId: workflow.userId || '',
    kind: failed ? 'workflow_failed' : 'workflow_succeeded',
    severity: failed ? 'high' : 'success',
    title: `${failed ? 'Workflow failed' : 'Workflow completed'}: ${workflow.title}`,
    message: failed ? (workflow.error || 'Workflow failed') : (workflow.result?.summary || 'Workflow completed successfully'),
    entityType: 'workflow',
    entityId: workflow.id,
    data: { url: '/admin/agent', workflowId: workflow.id },
  })
}

export function notifyDeploySession(session) {
  if (!session) return null
  const failed = session.status === 'failed'
  return createNotification({
    userId: session.userId || '',
    kind: failed ? 'deploy_failed' : 'deploy_succeeded',
    severity: failed ? 'critical' : 'success',
    title: `${failed ? 'Deploy failed' : 'Deploy succeeded'}: ${session.title}`,
    message: failed ? (session.error || 'Deploy failed') : 'Deploy completed and health check passed',
    entityType: 'deploy',
    entityId: session.id,
    data: { url: '/admin/agent', deploySessionId: session.id },
  })
}

export default { initNotifications, listNotifications, notificationSummary, createNotification, markNotificationRead, markAllNotificationsRead, notifyIncident, notifyWorkflow, notifyDeploySession }
