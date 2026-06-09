import { useMemo, useState } from 'react'

/**
 * Multi-select question card rendered when the agent emits an
 * `ask_user` event. Mirrors the same look-and-feel used by the Arena
 * agent's clarification UI: bold question, list of options with
 * checkboxes (or radio when !multi), optional custom text field at the
 * bottom, single 'Отправить' button.
 *
 * Calls `onSubmit({ selected: string[], custom?: string })` which the
 * parent (useChats) POSTs to /api/agent/answer.
 *
 * If `answered` is true (the user already replied earlier in this
 * conversation), the card switches to a read-only summary so the
 * history stays understandable.
 */
export default function AgentAskUser({
  question,
  options = [],
  multi = true,
  allowCustom = true,
  answered = false,
  answer = null,        // { selected, custom } when answered
  expiresAt = null,
  onSubmit,
  onCancel,
  // ── approval-mode extras (set when kind === 'approval') ────────────
  kind = 'question',    // 'question' | 'approval'
  tool = '',
  category = '',
  args = null,
}) {
  const [selected, setSelected] = useState(answered ? (answer?.selected || []) : [])
  const [custom, setCustom] = useState(answered ? (answer?.custom || '') : '')
  const [sending, setSending] = useState(false)
  const isApproval = kind === 'approval'
  const expiresLabel = useMemo(() => {
    if (!expiresAt || answered) return ''
    const ms = Number(expiresAt) - Date.now()
    if (!Number.isFinite(ms) || ms <= 0) return 'истекает сейчас'
    const min = Math.floor(ms / 60000)
    const sec = Math.floor((ms % 60000) / 1000)
    return min > 0 ? `истекает через ${min}м ${sec}с` : `истекает через ${sec}с`
  }, [expiresAt, answered])

  // For approval mode: one-click submit (no checkbox dance, no custom text).
  const quickSubmit = async (verdict /* 'approve' | 'deny' */) => {
    if (answered || sending) return
    setSelected([verdict])
    setSending(true)
    try {
      await onSubmit?.({ selected: [verdict] })
    } finally {
      setSending(false)
    }
  }

  const toggle = (id) => {
    if (answered) return
    setSelected((cur) => {
      if (multi) {
        return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      } else {
        return cur.includes(id) ? [] : [id]
      }
    })
  }

  const canSubmit = !answered && !sending && (selected.length > 0 || (allowCustom && custom.trim()))

  const submit = async () => {
    if (!canSubmit) return
    setSending(true)
    try {
      await onSubmit?.({
        selected,
        custom: allowCustom && custom.trim() ? custom.trim() : undefined,
      })
    } finally {
      setSending(false)
    }
  }

  // ── APPROVAL UI: streamlined two-button card ─────────────────────────
  if (isApproval) {
    const argPreview = (() => {
      if (!args || typeof args !== 'object') return ''
      const compact = {}
      for (const [k, v] of Object.entries(args)) {
        if (k.startsWith('_')) continue
        const s = typeof v === 'string' ? v : JSON.stringify(v)
        compact[k] = s.length > 180 ? s.slice(0, 180) + '…' : s
      }
      return JSON.stringify(compact, null, 2)
    })()
    const catColor = {
      bash: 'border-amber-500/40 bg-amber-900/15',
      git: 'border-sky-500/40 bg-sky-900/15',
      deploy: 'border-red-500/40 bg-red-900/15',
      mcp: 'border-violet-500/40 bg-violet-900/15',
      write: 'border-emerald-500/40 bg-emerald-900/15',
      net: 'border-cyan-500/40 bg-cyan-900/15',
    }[category] || 'border-cream/15 bg-graphite-800/80'

    return (
      <div className={`my-2 rounded-xl border p-3 text-[13px] md:text-[14px] ${catColor}`}>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
            🔐 запрошено разрешение
          </span>
          {expiresLabel && <span className="text-[10px] text-amber-300">{expiresLabel}</span>}
          <span className="rounded-full border border-white/15 bg-graphite-900/60 px-1.5 py-0.5 font-mono text-[10px] text-cream-soft">
            {category}
          </span>
        </div>
        <div className="mb-2 font-medium text-cream">
          Вызвать <code className="rounded bg-graphite-900/70 px-1 py-0.5 font-mono text-[12px] text-cream">{tool}</code>?
        </div>
        {argPreview && (
          <pre className="mb-2 max-h-48 overflow-auto rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 font-mono text-[11px] leading-snug text-cream-soft">
{argPreview}
          </pre>
        )}
        {!answered ? (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onCancel?.()}
              disabled={sending}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] font-medium text-cream-faint transition hover:bg-graphite-700 hover:text-cream disabled:opacity-40"
            >Отмена</button>
            <button
              type="button"
              onClick={() => quickSubmit('deny')}
              disabled={sending}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] font-medium text-cream-soft transition hover:bg-graphite-700 hover:text-cream disabled:opacity-40"
            >Отклонить</button>
            <button
              type="button"
              onClick={() => quickSubmit('approve')}
              disabled={sending}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition hover:bg-emerald-400 disabled:opacity-40"
            >{sending ? '…' : '✓ Разрешить'}</button>
          </div>
        ) : (
          <div className={`text-[11px] ${selected[0] === 'approve' ? 'text-emerald-300' : 'text-amber-300'}`}>
            {selected[0] === 'approve' ? '✓ Разрешено' : '✕ Отклонено'}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="my-2 rounded-xl border border-cream/15 bg-graphite-800/80 p-3 text-[13px] md:text-[14px]">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="font-medium text-cream">❓ {question}</div>
        {expiresLabel && <div className="shrink-0 text-[10px] text-amber-300">{expiresLabel}</div>}
      </div>

      <div className="space-y-1">
        {options.map((opt) => {
          const checked = selected.includes(opt.id)
          return (
            <button
              key={opt.id}
              type="button"
              disabled={answered}
              onClick={() => toggle(opt.id)}
              className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                checked
                  ? 'border-cream/40 bg-cream/10 text-cream'
                  : 'border-white/10 text-cream-soft hover:bg-graphite-750 hover:text-cream'
              } ${answered ? 'cursor-default opacity-80' : ''}`}
            >
              <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center ${multi ? 'rounded' : 'rounded-full'} border ${
                checked ? 'border-cream bg-cream text-graphite-900' : 'border-white/30'
              }`}>
                {checked && (multi ? '✓' : '●')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{opt.label}</span>
                {opt.description && <span className="block text-[11px] text-cream-faint">{opt.description}</span>}
              </span>
            </button>
          )
        })}
      </div>

      {allowCustom && (
        <div className="mt-2">
          <textarea
            value={custom}
            disabled={answered}
            onChange={(e) => setCustom(e.target.value)}
            placeholder={answered ? '' : 'Свой вариант (опционально)…'}
            rows={2}
            className="w-full resize-none rounded-lg border border-white/10 bg-graphite-900 px-2.5 py-1.5 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none disabled:opacity-60"
          />
        </div>
      )}

      {!answered ? (
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-[11px] text-cream-faint">
            {multi ? `Выбрано: ${selected.length}` : (selected.length ? 'Выбран 1' : 'Не выбрано')}
          </span>
          <button
            type="button"
            disabled={sending}
            onClick={() => onCancel?.()}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-cream-soft transition hover:bg-graphite-700 disabled:opacity-40"
          >Отмена</button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition disabled:opacity-40"
          >
            {sending ? 'Отправка…' : 'Отправить ответ'}
          </button>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-emerald-300">✓ Ответ отправлен</div>
      )}
    </div>
  )
}
