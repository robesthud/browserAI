import { useEffect, useMemo, useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

const terminal = new Set(['succeeded', 'failed', 'cancelled'])

function Pill({ tone = 'zinc', children }) {
  const cls = {
    red: 'border-red-400/30 bg-red-500/10 text-red-200',
    amber: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
    emerald: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
    violet: 'border-violet-400/30 bg-violet-500/10 text-violet-200',
    zinc: 'border-white/10 bg-white/5 text-cream-faint',
  }[tone]
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>
}

export default function AgentInbox() {
  const [questions, setQuestions] = useState([])
  const [incidents, setIncidents] = useState([])
  const [workflows, setWorkflows] = useState([])
  const [jobs, setJobs] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const actionable = useMemo(() => {
    const pendingQ = questions.length
    const openIncidents = incidents.filter((i) => i.status !== 'resolved').length
    const failedWf = workflows.filter((w) => w.status === 'failed').length
    const runningWf = workflows.filter((w) => !terminal.has(w.status)).length
    const failedJobs = jobs.filter((j) => j.status === 'failed').length
    return { pendingQ, openIncidents, failedWf, runningWf, failedJobs, total: pendingQ + openIncidents + failedWf + runningWf + failedJobs }
  }, [questions, incidents, workflows, jobs])

  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      const [q, inc, w, j] = await Promise.all([
        api('/api/agent/questions').catch(() => ({ questions: [] })),
        api('/api/incidents?limit=12').catch(() => ({ incidents: [] })),
        api('/api/agent/workflows?limit=20').catch(() => ({ workflows: [] })),
        api('/api/jobs?limit=20').catch(() => ({ jobs: [] })),
      ])
      setQuestions(q.questions || [])
      setIncidents((inc.incidents || []).filter((x) => x.status !== 'resolved').slice(0, 8))
      setWorkflows((w.workflows || []).filter((x) => !terminal.has(x.status) || x.status === 'failed').slice(0, 8))
      setJobs((j.jobs || []).filter((x) => !terminal.has(x.status) || x.status === 'failed').slice(0, 8))
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let dead = false
    const tick = async () => { if (!dead) await refresh() }
    tick()
    const id = setInterval(tick, actionable.total ? 2500 : 8000)
    return () => { dead = true; clearInterval(id) }
  }, [actionable.total])

  const answer = async (id, selected) => {
    await api('/api/agent/answer', { method: 'POST', body: JSON.stringify({ question_id: id, answer: { selected: [selected] } }) })
    await refresh()
  }
  const resolveIncident = async (id) => { await api(`/api/incidents/${id}/resolve`, { method: 'POST', body: JSON.stringify({ note: 'resolved from Agent Inbox' }) }); await refresh() }
  const diagnoseIncident = async (id) => { await api(`/api/incidents/${id}/diagnose`, { method: 'POST', body: JSON.stringify({ recipeId: 'browserai_full_diagnostic' }) }); await refresh() }
  const retryWorkflow = async (id) => { await api(`/api/agent/workflows/${id}/retry`, { method: 'POST' }); await refresh() }
  const cancelWorkflow = async (id) => { await api(`/api/agent/workflows/${id}/cancel`, { method: 'POST' }); await refresh() }

  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Agent Inbox</h2>
          <p className="text-[12px] text-cream-faint">Единая очередь внимания: incidents, approvals, running/failed workflows и jobs.</p>
        </div>
        <div className="flex items-center gap-2">
          {actionable.total > 0 && <Pill tone="amber">{actionable.total} attention</Pill>}
          <button onClick={() => void refresh()} disabled={busy} className="rounded-lg border border-white/10 px-2.5 py-1 text-[12px] text-cream-soft hover:bg-graphite-750 disabled:opacity-50">↻</button>
        </div>
      </div>
      {error && <div className="mb-2 rounded-lg border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}

      <div className="grid gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="mb-2 flex items-center justify-between"><h3 className="text-[13px] font-medium">Incidents</h3><Pill tone={actionable.openIncidents ? 'red' : 'emerald'}>{incidents.length}</Pill></div>
          <div className="space-y-2">
            {incidents.length === 0 ? <div className="text-[12px] text-cream-faint">No open incidents.</div> : incidents.map((i) => (
              <div key={i.id} className="rounded-lg border border-white/10 bg-graphite-900/60 p-2 text-[12px]">
                <div className="flex items-center justify-between gap-2"><span className="truncate text-cream-soft">{i.title}</span><Pill tone={i.severity === 'high' ? 'red' : i.severity === 'low' ? 'zinc' : 'amber'}>{i.severity}</Pill></div>
                <div className="mt-1 text-[10px] text-cream-faint">{i.source} · {i.status}</div>
                {i.workflowId && <div className="mt-1 truncate font-mono text-[10px] text-violet-200">wf: {i.workflowId}</div>}
                <div className="mt-2 flex gap-1.5">
                  <button onClick={() => void diagnoseIncident(i.id)} className="rounded bg-violet-500/15 px-2 py-1 text-[11px] text-violet-100">diagnose</button>
                  <button onClick={() => void resolveIncident(i.id)} className="rounded bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-100">resolve</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="mb-2 flex items-center justify-between"><h3 className="text-[13px] font-medium">Approvals</h3><Pill tone={questions.length ? 'amber' : 'emerald'}>{questions.length}</Pill></div>
          <div className="space-y-2">
            {questions.length === 0 ? <div className="text-[12px] text-cream-faint">Нет ожидающих вопросов.</div> : questions.map((q) => (
              <div key={q.id} className="rounded-lg border border-white/10 bg-graphite-900/60 p-2 text-[12px]">
                <div className="text-cream-soft">{q.question || `Approve ${q.tool || ''}?`}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(q.options || ['approve', 'deny']).map((o) => {
                    const val = typeof o === 'string' ? o : o.id
                    const label = typeof o === 'string' ? o : (o.label || o.id)
                    return <button key={val} onClick={() => void answer(q.id, val)} className="rounded border border-white/10 px-2 py-1 text-[11px] hover:bg-white/5">{label}</button>
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="mb-2 flex items-center justify-between"><h3 className="text-[13px] font-medium">Workflows</h3><Pill tone={actionable.failedWf ? 'red' : actionable.runningWf ? 'amber' : 'emerald'}>{workflows.length}</Pill></div>
          <div className="space-y-2">
            {workflows.length === 0 ? <div className="text-[12px] text-cream-faint">Workflow clean.</div> : workflows.map((w) => (
              <div key={w.id} className="rounded-lg border border-white/10 bg-graphite-900/60 p-2 text-[12px]">
                <div className="flex items-center justify-between gap-2"><span className="truncate text-cream-soft">{w.title}</span><Pill tone={w.status === 'failed' ? 'red' : 'amber'}>{w.status}</Pill></div>
                {w.error && <div className="mt-1 text-red-200">{w.error}</div>}
                <div className="mt-2 flex gap-1.5">
                  {w.status === 'failed' && <button onClick={() => void retryWorkflow(w.id)} className="rounded bg-violet-500/15 px-2 py-1 text-[11px] text-violet-100">retry</button>}
                  {!terminal.has(w.status) && <button onClick={() => void cancelWorkflow(w.id)} className="rounded bg-red-500/15 px-2 py-1 text-[11px] text-red-100">cancel</button>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="mb-2 flex items-center justify-between"><h3 className="text-[13px] font-medium">Jobs</h3><Pill tone={actionable.failedJobs ? 'red' : jobs.length ? 'amber' : 'emerald'}>{jobs.length}</Pill></div>
          <div className="space-y-2">
            {jobs.length === 0 ? <div className="text-[12px] text-cream-faint">Jobs clean.</div> : jobs.map((j) => (
              <div key={j.id} className="rounded-lg border border-white/10 bg-graphite-900/60 p-2 text-[12px]">
                <div className="flex items-center justify-between gap-2"><span className="truncate text-cream-soft">{j.title || j.type}</span><Pill tone={j.status === 'failed' ? 'red' : 'amber'}>{j.status}</Pill></div>
                {j.error && <div className="mt-1 text-red-200">{j.error}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
