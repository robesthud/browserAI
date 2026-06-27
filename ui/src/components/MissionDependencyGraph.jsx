import { useState, useEffect } from 'react'

/**
 * MissionDependencyGraph — Фаза 1: Mission dependency graph
 * Показывает связи между mission → codeTask → workflow → deploy → incident
 */

async function api(url) {
  try {
    const r = await fetch(url, { credentials: 'include' })
    return r.json()
  } catch { return null }
}

function StatusDot({ status }) {
  const colors = {
    succeeded: 'bg-green-400', failed: 'bg-red-400', cancelled: 'bg-gray-400',
    running: 'bg-blue-400 animate-pulse', queued: 'bg-yellow-400', investigating: 'bg-orange-400', open: 'bg-red-400',
  }
  return <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${colors[status] || 'bg-gray-500'}`} />
}

function EntityCard({ icon, label, id, status, url, sub }) {
  return (
    <div className="rounded-lg border border-white/10 bg-graphite-900/60 px-3 py-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span>{icon}</span>
        <span className="font-medium text-cream-soft">{label}</span>
        {status && <StatusDot status={status} />}
        {status && <span className="text-cream-faint">{status}</span>}
      </div>
      {id && <div className="font-mono text-[10px] text-cream-faint/60 mt-0.5 truncate">{id.slice(0, 24)}</div>}
      {sub && <div className="text-[10px] text-cream-faint mt-0.5">{sub}</div>}
      {url && <a href={url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-400 hover:underline mt-0.5 block truncate">{url}</a>}
    </div>
  )
}

function Arrow() {
  return <div className="text-cream-faint/40 text-[16px] text-center my-0.5">↓</div>
}

export default function MissionDependencyGraph() {
  const [missions, setMissions] = useState([])
  const [selected, setSelected] = useState(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    api('/api/operator/missions?limit=10').then(d => {
      setMissions(d?.missions || [])
    })
  }, [])

  const m = selected || missions[0]

  if (!expanded) {
    return (
      <div className="rounded-xl border border-white/10 bg-graphite-900/40 p-4">
        <button onClick={() => setExpanded(true)} className="flex w-full items-center justify-between text-left">
          <span className="text-[13px] font-medium text-cream">🔗 Mission Dependency Graph</span>
          <span className="text-cream-faint text-[11px]">▶ показать</span>
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/10 bg-graphite-900/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-cream">🔗 Mission Dependency Graph</span>
        <button onClick={() => setExpanded(false)} className="text-cream-faint text-[11px]">▼ скрыть</button>
      </div>

      {/* Mission selector */}
      {missions.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {missions.slice(0, 6).map(ms => (
            <button key={ms.id} onClick={() => setSelected(ms)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${(m?.id === ms.id) ? 'border-violet-400/40 bg-violet-500/15 text-violet-200' : 'border-white/10 text-cream-faint hover:bg-white/5'}`}
            >
              <StatusDot status={ms.status} />
              <span className="ml-1.5">{(ms.title || ms.type || ms.id).slice(0, 30)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Dependency tree */}
      {m && (
        <div className="grid gap-2 md:grid-cols-2">
          {/* Left: mission chain */}
          <div className="space-y-0.5">
            <EntityCard icon="🎯" label="Mission" id={m.id} status={m.status}
              sub={m.goal?.slice(0, 60) || m.type} />

            {m.superWorkflow && (
              <>
                <Arrow />
                <EntityCard icon="🏁" label="Super Workflow" id={m.superWorkflow.id}
                  status={m.superWorkflow.status} sub={`goal: ${m.superWorkflow.goal?.slice(0, 40) || ''}`} />
              </>
            )}

            {m.codeTask && (
              <>
                <Arrow />
                <EntityCard icon="💻" label="Code Task" id={m.codeTask.id}
                  status={m.codeTask.status}
                  sub={`branch: ${m.codeTask.branch || '—'} | ${m.codeTask.repo || ''}`}
                  url={m.codeTask.result?.finalize?.pullRequest?.url} />
              </>
            )}

            {m.workflow && (
              <>
                <Arrow />
                <EntityCard icon="⚙️" label="Workflow" id={m.workflow.id}
                  status={m.workflow.status} sub={m.workflow.recipeId || ''} />
              </>
            )}

            {m.job && (
              <>
                <Arrow />
                <EntityCard icon="🔄" label="Background Job" id={m.job.id}
                  status={m.job.status} sub={m.job.title || m.job.type} />
              </>
            )}
          </div>

          {/* Right: events timeline */}
          <div>
            <div className="text-[11px] font-medium text-cream-soft mb-2">События миссии</div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {(m.events || []).slice(0, 20).map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <span className="font-mono text-[10px] text-cream-faint/50 flex-shrink-0 mt-0.5">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                  <span className={`flex-shrink-0 ${
                    e.type === 'error' ? 'text-red-400' :
                    e.type === 'success' ? 'text-green-400' :
                    e.type === 'warn' ? 'text-yellow-400' : 'text-cream-faint'
                  }`}>
                    {e.type === 'error' ? '✗' : e.type === 'success' ? '✓' : e.type === 'warn' ? '⚠' : '•'}
                  </span>
                  <span className="text-cream-soft">{e.title || e.message}</span>
                </div>
              ))}
              {(m.events || []).length === 0 && (
                <div className="text-[11px] text-cream-faint">Нет событий</div>
              )}
            </div>
          </div>
        </div>
      )}

      {missions.length === 0 && (
        <div className="text-[12px] text-cream-faint text-center py-4">
          Нет активных миссий. Запустите миссию через Operator Console.
        </div>
      )}
    </div>
  )
}
