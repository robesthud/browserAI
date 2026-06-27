import { useEffect, useState } from 'react'
import { cancelJob, listJobs, retryJob } from '../lib/jobs.js'

/**
 * Lightweight tray that polls /api/jobs and shows the user every job
 * currently running OR finished in the last few minutes. Lives in the
 * sidebar so it's visible while the user is in any chat (even a fresh
 * one) — solves "I closed the tab, where did my video go?".
 *
 * Only renders when there's at least one job worth showing.
 */
const TERMINAL = ['succeeded', 'failed', 'cancelled']
const RECENT_MS = 5 * 60 * 1000   // show terminal jobs for 5 min after finish

function statusEmoji(status) {
  return {
    succeeded: '✓',
    failed:    '✗',
    cancelled: '⊘',
    running:   '⏳',
    queued:    '⌛',
    waiting:   '⌛',
  }[status] || '•'
}

function typeLabel(type) {
  return {
    gemini_video: 'Видео',
    gemini_image: 'Изображение',
    generate_pdf: 'PDF',
    generate_docx: 'Документ',
    generate_xlsx: 'Таблица',
    generate_presentation: 'Презентация',
    agent_run: 'Фоновый агент',
    tool_verify_task: 'Проверка',
    tool_secret_scan: 'Секреты',
    tool_zip_files: 'ZIP',
  }[type] || type
}

export default function JobsTray({ onOpenChat } = {}) {
  const [jobs, setJobs] = useState([])

  const refresh = async () => {
    const data = await listJobs('')
    const now = Date.now()
    const filtered = (data?.jobs || []).filter((j) => {
      if (!TERMINAL.includes(j.status)) return true
      const t = j.finishedAt || j.updatedAt
      return t && now - t < RECENT_MS
    })
    setJobs(filtered.slice(0, 5))
  }

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try { if (!cancelled) await refresh() } catch { /* ignore — try next tick */ }
    }
    tick()
    const id = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (jobs.length === 0) return null

  return (
    <div className="my-2 rounded-lg border border-white/10 bg-graphite-900/40 p-2 text-[12px]">
      <div className="mb-1 px-1 text-[11px] uppercase tracking-wide text-cream-faint">
        Задачи
      </div>
      <div className="space-y-1">
        {jobs.map((j) => {
          const term = TERMINAL.includes(j.status)
          return (
            <div key={j.id} className="flex items-center gap-1.5 px-1 text-cream-soft">
              <span className={`shrink-0 ${j.status === 'failed' ? 'text-rose-300' : j.status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300'}`}>
                {statusEmoji(j.status)}
              </span>
              <span className="truncate font-medium text-cream">{typeLabel(j.type)}</span>
              {!term && (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-cream-faint">{j.progress || 0}%</span>
              )}
              {!term && j.chatId && (
                <button
                  onClick={() => onOpenChat?.(j.chatId, j.id)}
                  className="ml-1 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/25"
                  title="Открыть job в чате"
                >↗</button>
              )}
              {!term && (
                <button
                  onClick={async () => { try { await cancelJob(j.id); await refresh() } catch { /* ignore */ } }}
                  className="ml-1 rounded bg-rose-500/15 px-1 py-0.5 text-[10px] text-rose-200 hover:bg-rose-500/25"
                  title="Отменить задачу"
                >×</button>
              )}
              {term && j.chatId && (
                <button
                  onClick={() => onOpenChat?.(j.chatId, j.id)}
                  className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/25"
                  title="Открыть результат job в чате"
                >в чат</button>
              )}
              {term && j.status === 'failed' && (
                <button
                  onClick={async () => { try { await retryJob(j.id); await refresh() } catch { /* ignore */ } }}
                  className="ml-auto shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-200 hover:bg-violet-500/25"
                  title={j.error}
                >retry</button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
