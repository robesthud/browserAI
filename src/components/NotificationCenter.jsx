import { useEffect, useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

function tone(sev) {
  if (sev === 'critical' || sev === 'high' || sev === 'error') return 'border-red-400/25 bg-red-500/10 text-red-100'
  if (sev === 'medium' || sev === 'warning') return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
  if (sev === 'success') return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
  return 'border-white/10 bg-black/15 text-cream-soft'
}

export default function NotificationCenter() {
  const [notifications, setNotifications] = useState([])
  const [summary, setSummary] = useState({ unread: 0 })
  const [error, setError] = useState('')

  const refresh = async () => {
    try {
      const data = await api('/api/notifications?limit=30')
      setNotifications(data.notifications || [])
      setSummary(data.summary || { unread: 0 })
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }
  useEffect(() => {
    let dead = false
    const tick = async () => { if (!dead) await refresh() }
    tick()
    const id = setInterval(tick, 8000)
    return () => { dead = true; clearInterval(id) }
  }, [])

  const read = async (id) => { await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }); await refresh() }
  const readAll = async () => { await api('/api/notifications/read-all', { method: 'POST' }); await refresh() }

  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Notification Center</h2>
          <p className="text-[12px] text-cream-faint">Уведомления agent/operator runtime: incidents, workflows, deploys, reports and approvals.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${summary.unread ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'}`}>{summary.unread || 0} unread</span>
          <button onClick={() => void readAll()} className="rounded border border-white/10 px-2 py-1 text-[11px] text-cream-soft hover:bg-white/5">read all</button>
        </div>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      <div className="space-y-2">
        {notifications.length === 0 ? <div className="text-[12px] text-cream-faint">No notifications yet.</div> : notifications.map((n) => (
          <div key={n.id} className={`rounded-xl border p-3 text-[12px] ${tone(n.severity)} ${n.status === 'read' ? 'opacity-65' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-cream">{n.title}</div>
                <div className="mt-0.5 whitespace-pre-wrap text-cream-soft">{n.message}</div>
                <div className="mt-1 font-mono text-[10px] text-cream-faint">{n.kind} · {n.entityType}/{n.entityId} · {new Date(n.createdAt).toLocaleString()}</div>
              </div>
              {n.status === 'unread' && <button onClick={() => void read(n.id)} className="shrink-0 rounded border border-white/10 px-2 py-1 text-[10px] hover:bg-white/5">read</button>}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
