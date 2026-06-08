/**
 * Web Push (VAPID) for BrowserAI.
 *
 * Endpoints registered from server/index.js:
 *   GET  /api/push/vapid           → { publicKey }
 *   POST /api/push/subscribe       → store a PushSubscription for req.user
 *   POST /api/push/unsubscribe     → forget by endpoint
 *   POST /api/push/test            → send a test push to the current user
 *
 * Server-side helper:
 *   notifyUser(userId, {title, body, data, tag})
 *     fan-out to every subscription registered for that user. Used by
 *     the cron worker, video-job 'done' event, deploy summary, etc.
 *
 * Keys (VAPID) are auto-generated on first boot and persisted in SQLite
 * (`meta.push_vapid_public`, `meta.push_vapid_private`) so subscriptions
 * survive restarts.
 *
 * Falls back to a no-op (with a warning) if the web-push npm package is
 * missing — never breaks the rest of the server.
 */
import db from './db.js'

let webPush = null
let initialised = false
let vapidPublic = ''
let vapidPrivate = ''

async function loadWebPush() {
  if (webPush) return webPush
  try {
    webPush = (await import('web-push')).default
    return webPush
  } catch (e) {
    console.warn('[push] web-push package missing — push disabled. Run `npm i web-push`.', e?.message || '')
    return null
  }
}

function init() {
  if (initialised) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      user_id    TEXT NOT NULL,
      endpoint   TEXT PRIMARY KEY,
      keys_json  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  `)
  // Load VAPID from meta or generate.
  try {
    const pub = db.prepare("SELECT value FROM meta WHERE key='push_vapid_public'").get()?.value
    const prv = db.prepare("SELECT value FROM meta WHERE key='push_vapid_private'").get()?.value
    if (pub && prv) { vapidPublic = pub; vapidPrivate = prv }
  } catch { /* meta table is created elsewhere */ }
  initialised = true
}

async function ensureKeys() {
  init()
  if (vapidPublic && vapidPrivate) return
  const wp = await loadWebPush()
  if (!wp) return
  const keys = wp.generateVAPIDKeys()
  vapidPublic = keys.publicKey
  vapidPrivate = keys.privateKey
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('push_vapid_public', ?)").run(vapidPublic)
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('push_vapid_private', ?)").run(vapidPrivate)
  } catch (e) {
    console.warn('[push] could not persist VAPID keys:', e.message)
  }
  wp.setVapidDetails(
    `mailto:${process.env.PUSH_CONTACT_EMAIL || 'admin@browserai.local'}`,
    vapidPublic, vapidPrivate,
  )
  console.log('[push] generated new VAPID keypair')
}

export async function getPublicVapidKey() {
  await ensureKeys()
  return vapidPublic
}

export async function saveSubscription(userId, sub) {
  init()
  if (!userId || !sub?.endpoint) throw new Error('userId + subscription required')
  const keys = sub.keys || {}
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, keys_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json
  `).run(userId, sub.endpoint, JSON.stringify(keys), Date.now())
  return { ok: true }
}

export function deleteSubscription(endpoint) {
  init()
  const r = db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint)
  return { deleted: r.changes }
}

export async function notifyUser(userId, payload = {}) {
  await ensureKeys()
  const wp = await loadWebPush()
  if (!wp || !vapidPublic) return { sent: 0, reason: 'web-push not available' }
  init()
  const subs = db.prepare('SELECT endpoint, keys_json FROM push_subscriptions WHERE user_id=?').all(userId)
  if (subs.length === 0) return { sent: 0, reason: 'no subscriptions' }
  wp.setVapidDetails(
    `mailto:${process.env.PUSH_CONTACT_EMAIL || 'admin@browserai.local'}`,
    vapidPublic, vapidPrivate,
  )
  const body = JSON.stringify({
    title: payload.title || 'BrowserAI',
    body:  payload.body  || '',
    data:  payload.data  || {},
    tag:   payload.tag   || 'browserai',
  })
  let sent = 0
  for (const s of subs) {
    try {
      let keys = {}
      try { keys = JSON.parse(s.keys_json) } catch { /* ignore */ }
      await wp.sendNotification({ endpoint: s.endpoint, keys }, body, { TTL: 60 * 60 })
      sent += 1
    } catch (e) {
      // 410/404 → unsubscribed, prune it.
      if (e?.statusCode === 410 || e?.statusCode === 404) {
        try { deleteSubscription(s.endpoint) } catch { /* ignore */ }
      } else {
        console.warn('[push] send failed:', e?.message || e)
      }
    }
  }
  return { sent }
}
