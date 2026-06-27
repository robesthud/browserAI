import { useEffect, useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

export default function OperatorReportModal({ open, kind = 'mission', id = '', onClose }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(null)

  useEffect(() => {
    if (!open || !id) return
    let dead = false
    ;(async () => {
      try {
        const data = await api(`/api/operator/reports/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`)
        if (!dead) { setReport(data.report); setError(''); setSaved(null) }
      } catch (e) { if (!dead) setError(e.message || String(e)) }
    })()
    return () => { dead = true }
  }, [open, kind, id])

  if (!open) return null
  const markdown = report?.markdown || ''
  const save = async () => {
    const data = await api(`/api/operator/reports/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/save`, { method: 'POST' })
    setSaved(data.report?.path || 'saved')
  }
  const sendTelegram = async () => {
    await api(`/api/operator/reports/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/send-telegram`, { method: 'POST' })
    setSaved('sent to Telegram')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-4xl flex-col rounded-2xl border border-white/10 bg-graphite-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-[15px] font-medium text-cream">Operator Report</div>
            <div className="font-mono text-[11px] text-cream-faint">{kind}/{id}</div>
          </div>
          <button onClick={onClose} className="rounded border border-white/10 px-2 py-1 text-[12px] text-cream-soft hover:bg-white/5">close</button>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-white/10 px-4 py-2">
          <button onClick={() => navigator.clipboard?.writeText(markdown)} className="rounded border border-white/10 px-2 py-1 text-[12px] text-cream-soft hover:bg-white/5">copy</button>
          <button onClick={() => void save()} className="rounded border border-emerald-400/25 bg-emerald-500/10 px-2 py-1 text-[12px] text-emerald-100 hover:bg-emerald-500/20">save md</button>
          <button onClick={() => void sendTelegram()} className="rounded border border-blue-400/25 bg-blue-500/10 px-2 py-1 text-[12px] text-blue-100 hover:bg-blue-500/20">send Telegram</button>
          {saved && <span className="px-2 py-1 text-[12px] text-emerald-200">{saved}</span>}
        </div>
        {error && <div className="m-4 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
        <pre className="thin-scroll overflow-auto whitespace-pre-wrap p-4 text-[12px] leading-relaxed text-cream-soft">{markdown || 'Loading…'}</pre>
      </div>
    </div>
  )
}
