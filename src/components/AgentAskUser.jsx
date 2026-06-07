import { useState } from 'react'

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
  onSubmit,
}) {
  const [selected, setSelected] = useState(answered ? (answer?.selected || []) : [])
  const [custom, setCustom] = useState(answered ? (answer?.custom || '') : '')
  const [sending, setSending] = useState(false)

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

  return (
    <div className="my-2 rounded-xl border border-cream/15 bg-graphite-800/80 p-3 text-[13px] md:text-[14px]">
      <div className="mb-2 font-medium text-cream">❓ {question}</div>

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
