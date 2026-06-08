/**
 * PWA + Web Push helpers.
 *
 *   registerServiceWorker() — at boot. Idempotent. Quietly noops on
 *                             browsers without SW support (Safari < 16).
 *
 *   subscribePush()         — call after the user clicks an "enable
 *                             notifications" button. Returns true on
 *                             success. Caller stores the PushSubscription
 *                             via POST /api/push/subscribe.
 *
 *   unsubscribePush()       — symmetric.
 *
 * VAPID public key lives in window.__BROWSERAI_VAPID_PUBLIC__ injected by
 * server-rendered config OR /api/push/vapid (fetched lazily).
 */
function urlBase64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4)
  const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export async function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    return reg
  } catch (e) {
    console.warn('[pwa] sw register failed:', e?.message || e)
    return null
  }
}

async function fetchVapidPublic() {
  if (typeof window !== 'undefined' && window.__BROWSERAI_VAPID_PUBLIC__) {
    return window.__BROWSERAI_VAPID_PUBLIC__
  }
  try {
    const r = await fetch('/api/push/vapid', { credentials: 'include' })
    if (!r.ok) return ''
    const j = await r.json()
    return j?.publicKey || ''
  } catch { return '' }
}

export async function subscribePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported in this browser')
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission denied')

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    const vapid = await fetchVapidPublic()
    if (!vapid) throw new Error('Server has no VAPID public key configured')
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8(vapid),
    })
  }

  await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON ? sub.toJSON() : sub),
  })
  return true
}

export async function unsubscribePush() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return true
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    })
  } catch { /* ignore */ }
  return sub.unsubscribe()
}
