import { useEffect, useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

function tone(status = '') {
  if (status === 'succeeded') return 'bg-emerald-500/15 text-emerald-200 border-emerald-400/25'
  if (status === 'failed') return 'bg-red-500/15 text-red-200 border-red-400/25'
  if (status === 'ignored') return 'bg-zinc-500/15 text-zinc-200 border-zinc-400/25'
  return 'bg-amber-500/15 text-amber-200 border-amber-400/25'
}

export default function GitHubAutomationPanel() {
  const [events, setEvents] = useState([])
  const [repo, setRepo] = useState('')
  const [issueNumber, setIssueNumber] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const refresh = async () => {
    try {
      const data = await api('/api/operator/github-automation/events?limit=50')
      setEvents(data.events || [])
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }
  useEffect(() => {
    const t = setTimeout(() => { refresh().catch(() => {}) }, 0)
    return () => clearTimeout(t)
  }, [])

  const sendComment = async () => {
    try {
      setSaved(false)
      await api('/api/operator/github-automation/comment', { method: 'POST', body: JSON.stringify({ repo, issueNumber: Number(issueNumber), body }) })
      setSaved(true)
      setBody('')
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">GitHub Automation</h2>
          <p className="text-[12px] text-cream-faint">Issue/PR commands: /browserai run, review, fix-ci, status and help. Webhooks create operator missions and optional GitHub comments.</p>
        </div>
        <button onClick={() => void refresh()} className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft hover:bg-white/5">Refresh</button>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}

      <div className="mb-3 rounded-xl border border-white/10 bg-black/15 p-3">
        <div className="mb-2 text-[12px] font-medium text-cream">Manual GitHub comment</div>
        <div className="grid gap-2 md:grid-cols-[1fr_120px]">
          <input placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} className="rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 text-[12px] text-cream focus:outline-none" />
          <input placeholder="#" type="number" value={issueNumber} onChange={(e) => setIssueNumber(e.target.value)} className="rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 text-[12px] text-cream focus:outline-none" />
        </div>
        <textarea placeholder="Comment body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 text-[12px] text-cream focus:outline-none" />
        <button onClick={() => void sendComment()} className="mt-2 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-100 hover:bg-emerald-500/20">{saved ? 'Sent' : 'Send comment'}</button>
      </div>

      <div className="space-y-2">
        {events.length === 0 ? <div className="text-[12px] text-cream-faint">No GitHub automation events yet.</div> : events.map((e) => (
          <details key={e.id} className="rounded-xl border border-white/10 bg-black/15 p-3 text-[12px]" open={e.status === 'failed'}>
            <summary className="cursor-pointer">
              <span className={`mr-2 rounded border px-1.5 py-0.5 text-[10px] ${tone(e.status)}`}>{e.status}</span>
              <span className="text-cream">{e.event}/{e.action}</span>
              <span className="ml-2 text-cream-faint">{e.repo}{e.issueNumber ? ` #${e.issueNumber}` : e.prNumber ? ` PR #${e.prNumber}` : ''}</span>
            </summary>
            <div className="mt-2 space-y-1 text-[11px] text-cream-faint">
              <div>sender: {e.sender || 'unknown'} · delivery: {e.delivery || e.id}</div>
              {e.command && <div className="font-mono text-violet-200">{e.command}</div>}
              {e.error && <div className="text-red-200">{e.error}</div>}
              {e.result?.missionId && <div className="text-emerald-200">mission: {e.result.missionId}</div>}
              {e.result?.comment?.url && <a href={e.result.comment.url} target="_blank" rel="noreferrer" className="text-emerald-200 underline">comment</a>}
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[10px]">{JSON.stringify(e.result || {}, null, 2).slice(0, 4000)}</pre>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
