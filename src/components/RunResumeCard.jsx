import { useState } from 'react'

const COPY = {
  'max-steps': {
    title: 'Нужно ещё немного времени',
    text: 'Агент дошёл до лимита шагов. Работа и файлы сохранены — можно продолжить с текущего места.',
    action: 'Продолжить',
  },
  deadline: {
    title: 'Время выполнения истекло',
    text: 'Текущее состояние сохранено. Можно продолжить без старта заново.',
    action: 'Продолжить',
  },
  crash: {
    title: 'Выполнение прервалось',
    text: 'Состояние сохранено. Можно попробовать продолжить с последнего шага.',
    action: 'Продолжить',
  },
  'llm-error': {
    title: 'Модель прервала выполнение',
    text: 'Можно продолжить с текущего состояния или сменить модель в настройках.',
    action: 'Продолжить',
  },
}

export default function RunResumeCard({ chatId = '', reason = '', onResume = null, onDismiss = null }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  if (!COPY[reason]) return null
  const copy = COPY[reason]

  const handleResume = async () => {
    setLoading(true)
    setError(null)
    try {
      // Best-effort: ask the server for the last run summary so the resume
      // request can be grounded by persisted tool history/replay. If the API is
      // unavailable, still let the chat continue via onResume.
      let data = null
      try {
        const res = await fetch(`/api/agent/runs/${encodeURIComponent(chatId)}/resume`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (res.ok) data = await res.json()
      } catch { /* non-blocking */ }
      if (typeof onResume === 'function') await onResume(data)
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-3 text-[13px] text-cream-soft shadow-sm">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-amber-200">⏸</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-cream">{copy.title}</div>
          <div className="mt-1 leading-relaxed text-cream-faint">{copy.text}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-full bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition hover:opacity-90 disabled:opacity-50"
          onClick={handleResume}
          disabled={loading}
        >
          {loading ? 'Продолжаю…' : copy.action}
        </button>
        {typeof onDismiss === 'function' && (
          <button type="button" className="rounded-full border border-white/12 px-3 py-1.5 text-[12px] text-cream-faint hover:bg-white/5" onClick={onDismiss}>
            Скрыть
          </button>
        )}
      </div>
      {error && <div className="mt-2 text-[12px] text-red-200">{error}</div>}
    </div>
  )
}
