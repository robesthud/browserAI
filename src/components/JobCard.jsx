import { useEffect, useState } from 'react'
import { getJob, retryVideoJob } from '../lib/jobs.js'

function downloadHref(path, chatId, { inline = false } = {}) {
  const params = [
    `path=${encodeURIComponent(path)}`,
    chatId ? `chatId=${encodeURIComponent(chatId)}` : null,
    inline ? 'inline=1' : null,
  ].filter(Boolean).join('&')
  return `/api/workspace/download?${params}`
}

function statusText(status) {
  return {
    queued: 'В очереди', running: 'Выполняется', waiting: 'Ожидание',
    succeeded: 'Готово', failed: 'Ошибка', cancelled: 'Отменено',
  }[status] || status
}

const TERMINAL = ['succeeded', 'failed', 'cancelled']

function extOf(p = '') {
  const m = String(p).match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ''
}
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a'])

function kindOf(path) {
  const ext = extOf(path)
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return 'file'
}

function FileTile({ path, chatId }) {
  const kind = kindOf(path)
  const inlineHref = downloadHref(path, chatId, { inline: true })
  const downloadH = downloadHref(path, chatId)
  const name = path.split('/').pop()
  return (
    <div className="rounded-lg border border-white/10 bg-graphite-900/60 p-2">
      {kind === 'video' && (
        <video
          src={inlineHref}
          controls
          playsInline
          preload="metadata"
          className="mb-2 w-full rounded-md bg-black"
          style={{ maxHeight: 360 }}
        />
      )}
      {kind === 'image' && (
        // Lazy load so the chat scroll is snappy when the user has many cards.
        // eslint-disable-next-line jsx-a11y/img-redundant-alt
        <img
          src={inlineHref}
          alt={name}
          loading="lazy"
          className="mb-2 w-full rounded-md bg-graphite-950 object-contain"
          style={{ maxHeight: 360 }}
        />
      )}
      {kind === 'audio' && (
        <audio src={inlineHref} controls preload="metadata" className="mb-2 w-full" />
      )}
      <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-emerald-300">
        <span className="break-all">📁 {name}</span>
        <a
          href={downloadH}
          download={name}
          className="rounded border border-emerald-400/30 px-2 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-400/10"
        >
          Скачать
        </a>
        <a
          href={inlineHref}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-cream-soft hover:bg-white/5"
        >
          Открыть
        </a>
      </div>
    </div>
  )
}

export default function JobCard({ job: initial, onJobDone }) {
  const [job, setJob] = useState(initial)
  const [retryBusy, setRetryBusy] = useState(false)
  const [retryNewId, setRetryNewId] = useState(null)
  const [retryError, setRetryError] = useState('')

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
  const retryable = Boolean(job.result?.retryable) && (job.result?.kind === 'video' || job.type === 'gemini_video')

  const onRetry = async () => {
    setRetryBusy(true)
    setRetryError('')
    try {
      const data = await retryVideoJob(job.id)
      setRetryNewId(data?.job?.id || null)
    } catch (e) {
      setRetryError(e?.message || 'Не удалось перезапустить')
    } finally {
      setRetryBusy(false)
    }
  }

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

      {retryable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={retryBusy || Boolean(retryNewId)}
            onClick={() => void onRetry()}
            className="rounded-md border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[12px] text-violet-200 hover:bg-violet-500/20 disabled:opacity-50"
          >
            {retryBusy ? 'Перезапуск…' : retryNewId ? 'Запущена новая задача' : '🔁 Повторить запрос видео'}
          </button>
          {retryNewId && (
            <span className="text-[11px] text-cream-faint">new job: {retryNewId.slice(-8)}</span>
          )}
          {retryError && (
            <span className="text-[11px] text-red-300">{retryError}</span>
          )}
        </div>
      )}

      {job.result?.content && (
        <div className="mt-2 whitespace-pre-wrap text-cream-soft">
          {String(job.result.content).slice(0, 1500)}
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-3 grid gap-2">
          {files.map((f) => <FileTile key={f} path={f} chatId={job.chatId} />)}
        </div>
      )}

      {job.logs?.length > 0 && (
        <details className="mt-2 text-[11px] text-cream-faint">
          <summary>Логи</summary>
          <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
            {job.logs.slice(-12).map((l, i) => <div key={i}>• {l.message}</div>)}
          </div>
        </details>
      )}
    </div>
  )
}
