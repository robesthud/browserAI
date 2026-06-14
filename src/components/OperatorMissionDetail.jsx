import { useEffect, useMemo, useState } from 'react'
import OperatorMissionTimeline from './OperatorMissionTimeline.jsx'
import OperatorReportModal from './OperatorReportModal.jsx'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

const PHASES = [
  ['queued', 'Queued'],
  ['waiting_code', 'Code'],
  ['reviewing', 'Review'],
  ['finalizing', 'PR'],
  ['waiting_ci', 'CI'],
  ['auto_fixing', 'Auto-fix'],
  ['merging', 'Merge'],
  ['deploying', 'Deploy'],
  ['succeeded', 'Done'],
]
function statusTone(status = '') {
  if (status === 'succeeded') return 'bg-emerald-500/15 text-emerald-200 border-emerald-400/25'
  if (status === 'failed') return 'bg-red-500/15 text-red-200 border-red-400/25'
  if (status === 'cancelled') return 'bg-zinc-500/15 text-zinc-200 border-zinc-400/25'
  return 'bg-amber-500/15 text-amber-200 border-amber-400/25'
}
function stepState(phase, status) {
  const statusIdx = PHASES.findIndex(([id]) => id === status)
  const phaseIdx = PHASES.findIndex(([id]) => id === phase)
  if (status === 'failed' || status === 'cancelled') return phaseIdx <= Math.max(0, statusIdx) ? 'done' : 'todo'
  if (statusIdx < 0 || phaseIdx < 0) return 'todo'
  if (phaseIdx < statusIdx) return 'done'
  if (phaseIdx === statusIdx) return 'active'
  return 'todo'
}
function MiniJson({ data }) {
  if (!data) return null
  return <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[10px] text-cream-faint">{JSON.stringify(data, null, 2).slice(0, 6000)}</pre>
}

export default function OperatorMissionDetail() {
  const [missions, setMissions] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')
  const [reportTarget, setReportTarget] = useState(null)

  const activeId = selectedId || missions[0]?.id || ''
  const activeStatus = selected?.superWorkflow?.status || selected?.codeTask?.status || selected?.workflow?.status || selected?.job?.status || selected?.status || ''

  const refresh = async () => {
    try {
      const list = await api('/api/operator/missions?limit=30')
      const ms = list.missions || []
      setMissions(ms)
      const id = selectedId || ms[0]?.id || ''
      if (id) {
        const detail = await api(`/api/operator/missions/${encodeURIComponent(id)}`)
        setSelected(detail.mission)
      }
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }
  useEffect(() => {
    let dead = false
    const tick = async () => { if (!dead) await refresh() }
    tick()
    const id = setInterval(tick, ['queued', 'running', 'waiting_code', 'reviewing', 'finalizing', 'waiting_ci', 'auto_fixing', 'merging', 'deploying'].includes(activeStatus) ? 2500 : 8000)
    return () => { dead = true; clearInterval(id) }
  }, [selectedId, activeStatus])

  const codeTask = selected?.codeTask || selected?.superWorkflow?.codeTask
  const deploySession = selected?.superWorkflow?.deploySession
  const workflow = selected?.workflow
  const job = selected?.job
  const superWorkflow = selected?.superWorkflow
  const phaseProgress = useMemo(() => {
    const idx = PHASES.findIndex(([id]) => id === activeStatus)
    if (activeStatus === 'succeeded') return 100
    if (idx < 0) return 8
    return Math.round((idx / Math.max(1, PHASES.length - 1)) * 100)
  }, [activeStatus])

  const cancelMission = async () => { if (selected?.id && window.confirm('Cancel mission?')) { await api(`/api/operator/missions/${selected.id}/cancel`, { method: 'POST' }); await refresh() } }
  const resumeMission = async () => { if (selected?.id) { await api(`/api/operator/missions/${selected.id}/resume`, { method: 'POST' }); await refresh() } }

  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Mission Detail</h2>
          <p className="text-[12px] text-cream-faint">Детальный центр миссии: timeline, super workflow, code task, PR/CI, deploy, logs, report.</p>
        </div>
        <div className="flex gap-2">
          {selected && ['queued', 'running', 'waiting_code', 'reviewing', 'finalizing', 'waiting_ci', 'auto_fixing', 'merging', 'deploying'].includes(activeStatus) && <button onClick={() => void cancelMission()} className="rounded border border-red-400/25 bg-red-500/10 px-2 py-1 text-[11px] text-red-100">cancel</button>}
          {selected && ['failed', 'cancelled'].includes(activeStatus) && <button onClick={() => void resumeMission()} className="rounded border border-violet-400/25 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-100">resume</button>}
          {selected && <button onClick={() => setReportTarget({ kind: 'mission', id: selected.id })} className="rounded border border-white/10 px-2 py-1 text-[11px] text-cream-soft hover:bg-white/5">report</button>}
        </div>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-white/10 bg-black/15 p-2">
          {missions.length === 0 ? <div className="p-2 text-[12px] text-cream-faint">No missions yet.</div> : missions.map((m) => {
            const st = m.superWorkflow?.status || m.codeTask?.status || m.workflow?.status || m.job?.status || m.status
            return <button key={m.id} onClick={() => { setSelectedId(m.id); setSelected(null) }} className={`mb-1 block w-full rounded-lg border px-2 py-2 text-left text-[12px] ${activeId === m.id ? 'border-violet-400/30 bg-violet-500/15' : 'border-white/5 hover:bg-white/5'}`}>
              <div className="truncate font-medium text-cream">{m.title}</div>
              <div className="mt-1 flex items-center justify-between gap-2"><span className="truncate text-cream-faint">{m.type}</span><span className={`rounded px-1.5 py-0.5 text-[10px] ${statusTone(st)}`}>{st}</span></div>
            </button>
          })}
        </div>

        <div className="space-y-3">
          {!selected ? <div className="rounded-xl border border-white/10 bg-black/15 p-4 text-[12px] text-cream-faint">Select a mission…</div> : (
            <>
              <div className="rounded-xl border border-white/10 bg-black/15 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-cream">{selected.title}</div>
                    <div className="font-mono text-[10px] text-cream-faint">{selected.id} · {selected.type}</div>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusTone(activeStatus)}`}>{activeStatus}</span>
                </div>
                <div className="mt-2 text-[12px] text-cream-soft">{selected.goal}</div>
                {superWorkflow && <div className="mt-3">
                  <div className="mb-1 flex justify-between text-[10px] text-cream-faint"><span>Super workflow</span><span>{phaseProgress}%</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-black/25"><div className="h-full bg-violet-400" style={{ width: `${phaseProgress}%` }} /></div>
                  <div className="mt-2 grid grid-cols-3 gap-1 md:grid-cols-5">
                    {PHASES.map(([id, label]) => <div key={id} className={`rounded border px-1.5 py-1 text-center text-[10px] ${stepState(id, activeStatus) === 'done' ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : stepState(id, activeStatus) === 'active' ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : 'border-white/10 text-cream-faint'}`}>{label}</div>)}
                  </div>
                </div>}
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-black/15 p-3">
                  <div className="mb-2 text-[13px] font-medium">Timeline</div>
                  <OperatorMissionTimeline events={selected.events || []} />
                </div>
                <div className="space-y-3">
                  {codeTask && <details open className="rounded-xl border border-white/10 bg-black/15 p-3 text-[12px]">
                    <summary className="cursor-pointer font-medium text-cream">Code Task · {codeTask.status}</summary>
                    <div className="mt-2 space-y-2">
                      <div className="font-mono text-[10px] text-cream-faint">{codeTask.id} · {codeTask.branch}</div>
                      {codeTask.result?.finalize?.pullRequest?.url && <a className="text-emerald-200 underline" target="_blank" rel="noreferrer" href={codeTask.result.finalize.pullRequest.url}>PR #{codeTask.result.finalize.pullRequest.number}</a>}
                      {codeTask.result?.review && <div className={`w-fit rounded border px-2 py-0.5 text-[11px] ${statusTone(codeTask.result.review.risk === 'critical' ? 'failed' : 'succeeded')}`}>risk {codeTask.result.review.risk}</div>}
                      {codeTask.result?.ci && <div className={`w-fit rounded border px-2 py-0.5 text-[11px] ${statusTone(codeTask.result.ci.ok ? 'succeeded' : 'failed')}`}>CI {codeTask.result.ci.status}</div>}
                      {codeTask.error && <div className="text-red-200">{codeTask.error}</div>}
                    </div>
                  </details>}

                  {deploySession && <details open className="rounded-xl border border-white/10 bg-black/15 p-3 text-[12px]">
                    <summary className="cursor-pointer font-medium text-cream">Deploy Session · {deploySession.status}</summary>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/25"><div className="h-full bg-amber-400" style={{ width: `${deploySession.progress || 0}%` }} /></div>
                    <div className="mt-2 max-h-48 overflow-auto space-y-1">
                      {(deploySession.events || []).map((e) => <div key={e.id} className="rounded border border-white/10 px-2 py-1 text-[11px]"><span className="text-cream-faint">{e.phase}</span> {e.message}</div>)}
                    </div>
                  </details>}

                  {workflow && <details className="rounded-xl border border-white/10 bg-black/15 p-3 text-[12px]"><summary className="cursor-pointer font-medium text-cream">Workflow · {workflow.status}</summary><MiniJson data={workflow.result || workflow.error} /></details>}
                  {job && <details className="rounded-xl border border-white/10 bg-black/15 p-3 text-[12px]"><summary className="cursor-pointer font-medium text-cream">Job · {job.status}</summary><MiniJson data={job.result || job.error} /></details>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <OperatorReportModal open={Boolean(reportTarget)} kind={reportTarget?.kind} id={reportTarget?.id} onClose={() => setReportTarget(null)} />
    </section>
  )
}
