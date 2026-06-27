/*
 * BrowserAI service worker.
 *
 * Three jobs:
 *   1. PWA install support: navigation fallback to /index.html so a
 *      bookmarked deep link still boots the SPA when offline.
 *   2. Cache static assets (Vite-hashed JS/CSS/img) with a stale-while-
 *      revalidate strategy. Everything under /api/ is never cached.
 *   3. Show a system push notification when /api/push/test (or a future
 *      backend) sends a `push` event.
 *
 * Cache name is bumped via the BA_CACHE constant on every breaking
 * change so old SWs drop their content automatically.
 */
const BA_CACHE = 'browserai-v2'

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(
    caches.open(BA_CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg']))
      .catch(() => undefined)
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== BA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

function shouldCache(url) {
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/')) return false
  if (url.pathname.startsWith('/admin/')) return false
  return true
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Navigation requests: try network first, fallback to cached index.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    )
    return
  }

  if (!shouldCache(url)) return

  // Stale-while-revalidate for /assets/* and root index.
  event.respondWith(
    caches.open(BA_CACHE).then(async (cache) => {
      const hit = await cache.match(req)
      const network = fetch(req).then((resp) => {
        if (resp.ok) cache.put(req, resp.clone())
        return resp
      }).catch(() => hit)
      return hit || network
    })
  )
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data?.text() || '' } }
  const title = data.title || 'BrowserAI'
  const opts = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data.data || {},
    tag: data.tag || 'browserai-default',
    renotify: Boolean(data.renotify),
  }
  event.waitUntil(self.registration.showNotification(title, opts))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) { w.focus(); w.navigate?.(target); return }
      }
      return self.clients.openWindow(target)
    })
  )
})
