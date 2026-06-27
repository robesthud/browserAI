import { useEffect, useState } from 'react'

export default function NotificationBadge() {
  const [summary, setSummary] = useState({ unread: 0 })
  useEffect(() => {
    let dead = false
    const tick = async () => {
      try {
        const r = await fetch('/api/notifications/summary', { credentials: 'include' })
        if (r.ok && !dead) setSummary((await r.json()).summary || { unread: 0 })
      } catch { /* ignore */ }
    }
    tick()
    const id = setInterval(tick, 10000)
    return () => { dead = true; clearInterval(id) }
  }, [])
  if (!summary.unread) return null
  return (
    <button onClick={() => { window.location.href = '/admin/agent' }} className="my-2 flex w-full items-center justify-between rounded-lg border border-amber-400/25 bg-amber-500/10 px-2.5 py-2 text-left text-[12px] text-amber-100 hover:bg-amber-500/20">
      <span>🔔 Notifications</span>
      <span className="rounded-full bg-amber-400/20 px-2 py-0.5 font-mono text-[10px]">{summary.unread}</span>
    </button>
  )
}
