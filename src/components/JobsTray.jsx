import { useEffect, useState } from 'react'
import { listJobs } from '../lib/jobs.js'

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
  }[type] || type
}

export default function JobsTray() {
  const [jobs, setJobs] = useState([])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const data = await listJobs('')
        if (cancelled) return
        const now = Date.now()
        const filtered = (data?.jobs || []).filter((j) => {
          if (!TERMINAL.includes(j.status)) return true        // running/queued
          const t = j.finishedAt || j.updatedAt
          return t && now - t < RECENT_MS
        })
        setJobs(filtered.slice(0, 5))
      } catch { /* ignore — try next tick */ }
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
              {term && j.status === 'failed' && (
                <span className="ml-auto shrink-0 truncate text-[10px] text-rose-300" title={j.error}>
                  ошибка
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
