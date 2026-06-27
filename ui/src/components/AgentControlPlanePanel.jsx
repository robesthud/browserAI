import { useEffect, useState } from 'react'

async function api(path) {
  const r = await fetch(path, { credentials: 'include' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

function tone(status) {
  if (status === 'ok') return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
  if (status === 'active') return 'border-violet-400/25 bg-violet-500/10 text-violet-100'
  return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/15 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-cream-faint">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] text-cream">{value ?? 0}</div>
    </div>
  )
}

export default function AgentControlPlanePanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  const refresh = async () => {
    try {
      const res = await api('/api/agent/control-plane')
      setData(res.controlPlane)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }

  useEffect(() => {
    let dead = false
    const tick = async () => { if (!dead) await refresh() }
    tick()
    const id = setInterval(tick, 10_000)
    return () => { dead = true; clearInterval(id) }
  }, [])

  const signals = data?.signals || {}
  const caps = data?.capabilities || {}
  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Agent Control Plane</h2>
          <p className="text-[12px] text-cream-faint">Высокоуровневый статус всего агентного контура: incidents, workflows, jobs, schedules, policy, webhook.</p>
        </div>
        <div className="flex items-center gap-2">
          {data && <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone(data.status)}`}>{data.status}</span>}
          <button onClick={() => void refresh()} className="rounded-lg border border-white/10 px-2.5 py-1 text-[12px] text-cream-soft hover:bg-graphite-750">↻</button>
        </div>
      </div>
      {error && <div className="mb-2 rounded-lg border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <Stat label="open incidents" value={signals.openIncidents} />
        <Stat label="failed workflows" value={signals.failedWorkflows} />
        <Stat label="running workflows" value={signals.runningWorkflows} />
        <Stat label="failed jobs" value={signals.failedJobs} />
        <Stat label="pending approvals" value={signals.pendingQuestions} />
        <Stat label="schedules" value={`${caps.enabledSchedules ?? 0}/${caps.scheduledAutomations ?? 0}`} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-cream-faint">
        <span className="rounded-full border border-white/10 bg-black/15 px-2 py-1">recipes: {caps.recipes ?? 0}</span>
        <span className="rounded-full border border-white/10 bg-black/15 px-2 py-1">webhook: {caps.webhookSecretConfigured ? 'configured' : 'no secret'}</span>
        <span className="rounded-full border border-white/10 bg-black/15 px-2 py-1">prod/hour: {caps.policy?.maxProductionWritesPerHour ?? '—'}</span>
      </div>
    </section>
  )
}
