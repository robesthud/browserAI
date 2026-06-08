import { useEffect, useState } from 'react'
import { getJob } from '../lib/jobs.js'

function downloadHref(path, chatId) {
  return `/api/workspace/download?path=${encodeURIComponent(path)}${chatId ? `&chatId=${encodeURIComponent(chatId)}` : ''}`
}

function statusText(status) {
  return {
    queued: 'В очереди', running: 'Выполняется', waiting: 'Ожидание', succeeded: 'Готово', failed: 'Ошибка', cancelled: 'Отменено'
  }[status] || status
}

const TERMINAL = ['succeeded', 'failed', 'cancelled']

export default function JobCard({ job: initial, onJobDone }) {
  const [job, setJob] = useState(initial)

  useEffect(() => {
    if (!initial?.id) return undefined
    let cancelled = false
    // Poll on a fixed interval, reading fresh status from the response itself
    // (not stale closure state) so a job can never get stuck visually
    // "Выполняется". On a terminal state, stop and notify the parent.
    const id = setInterval(async () => {
      try {
        const data = await getJob(initial.id)
        if (cancelled) return
        setJob(data.job)
        if (data.job && TERMINAL.includes(data.job.status)) {
          clearInterval(id)
          onJobDone?.(initial.id)
        }
      } catch { /* ignore polling errors, keep trying */ }
    }, 2500)
    return () => { cancelled = true; clearInterval(id) }
  }, [initial?.id, onJobDone])

  useEffect(() => {
    if (initial?.id && TERMINAL.includes(initial?.status)) onJobDone?.(initial.id)
  }, [initial?.id, initial?.status, onJobDone])

  if (!job) return null
  const done = job.status === 'succeeded'
  const failed = job.status === 'failed' || job.status === 'cancelled'
  const running = !TERMINAL.includes(job.status)
  const files = job.result?.files || []

  return (
    <div className={`my-2 rounded-xl border p-3 text-[13px] ${failed ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-white/10 bg-graphite-800/60 text-cream-soft'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-cream">
          {running && (
            <svg className="h-3.5 w-3.5 animate-spin text-violet-300" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {job.title || job.type}
        </div>
        <div className="text-[11px] text-cream-faint">{statusText(job.status)}</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-graphite-900">
        <div className={`h-full ${failed ? 'bg-red-400' : done ? 'bg-emerald-400' : 'bg-violet-400'}`} style={{ width: `${Math.max(3, job.progress || 0)}%` }} />
      </div>
      {job.error && <div className="mt-2 text-red-300">{job.error}</div>}
      {job.result?.content && <div className="mt-2 whitespace-pre-wrap">{String(job.result.content).slice(0, 1500)}</div>}
      {files.length > 0 && (
        <div className="mt-2 space-y-1">
          {files.map((f) => (
            <div key={f} className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-emerald-300">
              <span>📁 {f}</span>
              <a href={downloadHref(f, job.chatId)} className="rounded border border-emerald-400/30 px-2 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-400/10">Скачать</a>
            </div>
          ))}
        </div>
      )}
      {job.logs?.length > 0 && (
        <details className="mt-2 text-[11px] text-cream-faint">
          <summary>Логи</summary>
          <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">
            {job.logs.slice(-8).map((l, i) => <div key={i}>• {l.message}</div>)}
          </div>
        </details>
      )}
    </div>
  )
}
