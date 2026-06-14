import { useEffect, useState } from 'react'

async function api(path) {
  const r = await fetch(path, { credentials: 'include' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

function tone(status) {
  if (status === 'started') return 'border-violet-400/25 bg-violet-500/10 text-violet-100'
  if (status === 'failed') return 'border-red-400/25 bg-red-500/10 text-red-100'
  if (status === 'succeeded') return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
  return 'border-white/10 bg-black/15 text-cream-soft'
}

export default function AutoRecoveryPanel() {
  const [recoveries, setRecoveries] = useState([])
  const [summary, setSummary] = useState({})
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState('')
  const refresh = async () => {
    try {
      const [data, graphData] = await Promise.all([api('/api/operator/recoveries?limit=20'), api('/api/operator/recoveries/graph?limit=50').catch(() => ({ graph: null }))])
      setRecoveries(data.recoveries || [])
      setSummary(data.summary || {})
      setGraph(graphData.graph || null)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }
  useEffect(() => {
    let dead = false
    const tick = async () => { if (!dead) await refresh() }
    tick()
    const id = setInterval(tick, 10000)
    return () => { dead = true; clearInterval(id) }
  }, [])
  const supervise = async () => {
    await fetch('/api/operator/recoveries/supervise', { method: 'POST', credentials: 'include' })
    await refresh()
  }
  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Autonomous Recovery</h2>
          <p className="text-[12px] text-cream-faint">Безопасные автоматические recovery actions после классифицированных failures.</p>
        </div>
        <div className="flex flex-wrap gap-1 text-[11px] text-cream-faint">
          {Object.entries(summary).map(([k, v]) => <span key={k} className="rounded border border-white/10 px-2 py-0.5">{k}: {v}</span>)}
          <button onClick={() => void supervise()} className="rounded border border-violet-400/25 bg-violet-500/10 px-2 py-0.5 text-violet-100">supervise now</button>
        </div>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      {graph && <div className="mb-2 rounded border border-white/10 bg-black/15 p-2 text-[11px] text-cream-faint">Recovery graph: {graph.nodes?.length || 0} nodes / {graph.edges?.length || 0} edges</div>}
      <div className="space-y-2">
        {recoveries.length === 0 ? <div className="text-[12px] text-cream-faint">No recovery actions yet.</div> : recoveries.map((r) => (
          <details key={r.id} className={`rounded-xl border p-3 text-[12px] ${tone(r.status)}`}>
            <summary className="cursor-pointer">
              <span className="font-medium text-cream">{r.category}</span>
              <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px]">{r.status}</span>
              <span className="ml-2 text-cream-faint">{r.entityType}/{r.entityId}</span><span className="ml-2 text-cream-faint">depth {r.chainDepth || 0}</span>
            </summary>
            {r.error && <div className="mt-2 text-red-200">{r.error}</div>}
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/25 p-2 text-[11px]">{JSON.stringify(r.result || {}, null, 2)}</pre>
          </details>
        ))}
      </div>
    </section>
  )
}
