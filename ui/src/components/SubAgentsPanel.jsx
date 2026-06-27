import { useEffect, useState, useCallback } from 'react'

/**
 * SubAgentsPanel — Sprint 4C
 * Shows active sub-agents spawned via spawn_agent tool.
 * Polls /api/agent/jobs/:parentJobId/children every 3 seconds.
 */

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

function statusEmoji(status) {
  return { succeeded: '✓', failed: '✗', cancelled: '⊘', running: '⏳', queued: '⌛', waiting: '⌛' }[status] || '•'
}
function statusColor(status) {
  return {
    succeeded: 'text-green-400', failed: 'text-red-400', cancelled: 'text-gray-400',
    running: 'text-blue-400', queued: 'text-yellow-400', waiting: 'text-yellow-400',
  }[status] || 'text-gray-400'
}

async function fetchChildren(parentJobId) {
  try {
    const r = await fetch(`/api/agent/jobs/${encodeURIComponent(parentJobId)}/children`, { credentials: 'include' })
    if (!r.ok) return []
    const d = await r.json()
    return d.jobs || []
  } catch { return [] }
}

async function cancelSubJob(jobId) {
  try { await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', credentials: 'include' }) }
  catch { /* best-effort */ }
}

function SubAgentCard({ job, onCancel }) {
  const title = (job.title || job.type).replace(/^🤖\s*/, '')
  const done = TERMINAL.has(job.status)
  return (
    <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px]">
      <span className={`mt-0.5 flex-shrink-0 ${statusColor(job.status)}`}>{statusEmoji(job.status)}</span>
      <div className="flex-1 min-w-0">
        <div className="truncate text-cream-soft font-medium" title={title}>{title}</div>
        {!done && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-blue-500/60 transition-all duration-500" style={{ width: `${Math.max(5, job.progress || 0)}%` }} />
          </div>
        )}
        {job.status === 'failed' && job.error && (
          <div className="mt-1 truncate text-red-400/80" title={job.error}>{job.error.slice(0, 80)}</div>
        )}
        {job.status === 'succeeded' && job.result?.content && (
          <div className="mt-1 truncate text-green-400/80">{String(job.result.content).slice(0, 80)}</div>
        )}
      </div>
      {!done && (
        <button onClick={() => onCancel(job.id)}
          className="ml-1 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-red-500/20 hover:text-red-400 transition-colors"
          title="Отменить суб-агент">✕</button>
      )}
    </div>
  )
}

export default function SubAgentsPanel({ parentJobId, className = '' }) {
  const [jobs, setJobs] = useState([])
  const [collapsed, setCollapsed] = useState(false)

  const refresh = useCallback(async () => {
    if (!parentJobId) return
    const kids = await fetchChildren(parentJobId)
    setJobs(kids)
  }, [parentJobId])

  useEffect(() => {
    if (!parentJobId) return
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [parentJobId, refresh])

  if (!parentJobId || jobs.length === 0) return null

  const activeCount = jobs.filter(j => !TERMINAL.has(j.status)).length
  const allDone = activeCount === 0

  return (
    <div className={`rounded-xl border border-white/10 bg-graphite-900/60 p-3 ${className}`}>
      <button onClick={() => setCollapsed(v => !v)} className="flex w-full items-center gap-2 text-left">
        <span className="text-[13px] font-medium text-cream-soft">🤖 Суб-агенты</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${allDone ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
          {allDone ? `${jobs.length} завершено` : `${activeCount} активно`}
        </span>
        <span className="ml-auto text-gray-500 text-[11px]">{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div className="mt-2 flex flex-col gap-1.5">
          {jobs.map(job => (
            <SubAgentCard key={job.id} job={job} onCancel={async (id) => { await cancelSubJob(id); refresh() }} />
          ))}
        </div>
      )}
    </div>
  )
}
