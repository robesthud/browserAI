import { useCallback, useEffect, useMemo, useState } from 'react'
import OperatorReportModal from './OperatorReportModal.jsx'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

function tone(status) {
  if (status === 'succeeded') return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
  if (status === 'failed') return 'border-red-400/25 bg-red-500/10 text-red-100'
  if (status === 'running' || status === 'queued') return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
  return 'border-white/10 bg-black/15 text-cream-soft'
}
function eventTone(type) {
  if (type === 'success') return 'text-emerald-200'
  if (type === 'error') return 'text-red-200'
  return 'text-cream-soft'
}

export default function DeploySessionsPanel() {
  const [sessions, setSessions] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reportTarget, setReportTarget] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/operator/deploy-sessions?limit=10')
      setSessions(data.sessions || [])
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }, [])

  const hasActiveSession = useMemo(() => sessions.some((s) => ['queued', 'running'].includes(s.status)), [sessions])
  useEffect(() => {
    let dead = false
    const tick = async () => { if (!dead) await refresh() }
    tick()
    const id = setInterval(tick, hasActiveSession ? 2500 : 8000)
    return () => { dead = true; clearInterval(id) }
  }, [refresh, hasActiveSession])

  const startDeploy = async () => {
    const ok = window.confirm('Start safe deploy session? This will run deploy_safe and health/log checks.')
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await api('/api/operator/deploy-sessions', { method: 'POST', body: JSON.stringify({ title: 'Safe BrowserAI deploy', input: { timeoutSec: 240 } }) })
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const cancelSession = async (id) => { await api(`/api/operator/deploy-sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); await refresh() }
  const resumeSession = async (id) => { await api(`/api/operator/deploy-sessions/${encodeURIComponent(id)}/resume`, { method: 'POST' }); await refresh() }

  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Deploy Sessions</h2>
          <p className="text-[12px] text-cream-faint">Наблюдаемые production deploy-сессии: preflight, deploy, health, logs, report.</p>
        </div>
        <button disabled={busy} onClick={() => void startDeploy()} className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-100 hover:bg-amber-500/20 disabled:opacity-60">Start safe deploy</button>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      <div className="space-y-2">
        {sessions.length === 0 ? <div className="text-[12px] text-cream-faint">No deploy sessions yet.</div> : sessions.map((s) => (
          <details key={s.id} className={`rounded-xl border p-3 text-[12px] ${tone(s.status)}`} open={['running', 'failed'].includes(s.status)}>
            <summary className="cursor-pointer">
              <span className="font-medium text-cream">{s.title}</span>
              <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px]">{s.status}</span>
              <span className="ml-2 text-cream-faint">{s.progress || 0}%</span>
            </summary>
            {s.error && <div className="mt-2 text-red-200">{s.error}</div>}
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/25"><div className="h-full bg-current opacity-70" style={{ width: `${Math.max(3, s.progress || 0)}%` }} /></div>
            <div className="mt-3 space-y-1.5">
              {(s.events || []).map((e) => (
                <div key={e.id} className="rounded border border-white/10 bg-black/15 px-2 py-1.5">
                  <div className={`flex items-center justify-between gap-2 ${eventTone(e.type)}`}>
                    <span>{e.phase}: {e.message}</span>
                    <span className="font-mono text-[10px] opacity-60">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  </div>
                  {e.data?.stderr && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-red-100">{e.data.stderr}</pre>}
                </div>
              ))}
            </div>
            {s.result?.report && <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[11px] text-cream-soft">{s.result.report}</pre>}
            <div className="mt-2 flex gap-2">
              {['queued', 'running'].includes(s.status) && <button onClick={() => void cancelSession(s.id)} className="rounded border border-red-400/25 bg-red-500/10 px-2 py-1 text-[11px] text-red-100 hover:bg-red-500/20">cancel</button>}
              {['failed', 'cancelled'].includes(s.status) && <button onClick={() => void resumeSession(s.id)} className="rounded border border-violet-400/25 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-100 hover:bg-violet-500/20">resume</button>}
              <button onClick={() => setReportTarget({ kind: 'deploy', id: s.id })} className="rounded border border-white/10 px-2 py-1 text-[11px] text-cream-soft hover:bg-white/5">report</button>
            </div>
          </details>
        ))}
      </div>
      <OperatorReportModal open={Boolean(reportTarget)} kind={reportTarget?.kind} id={reportTarget?.id} onClose={() => setReportTarget(null)} />
    </section>
  )
}
