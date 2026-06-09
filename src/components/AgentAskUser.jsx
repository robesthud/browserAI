import { useMemo, useState } from 'react'

function devtoolsEnabled() {
  try { return localStorage.getItem('browserai.devtools') === '1' }
  catch { return false }
}

function normalizeOptions(options = []) {
  return (options || []).map((opt, idx) => {
    if (typeof opt === 'string') return { id: opt, label: opt, description: '' }
    const id = String(opt?.id || opt?.value || opt?.label || `option-${idx + 1}`)
    return {
      id,
      label: String(opt?.label || opt?.title || id),
      description: String(opt?.description || opt?.hint || ''),
    }
  })
}

const CATEGORY_LABELS = {
  read: 'Чтение',
  write: 'Запись файлов',
  net: 'Сеть / браузер',
  bash: 'Shell-команда',
  git: 'Git-действие',
  deploy: 'Деплой / сервер',
  mcp: 'MCP-инструмент',
}

export default function AgentAskUser({
  question,
  options = [],
  multi = true,
  allowCustom = true,
  answered = false,
  answer = null,
  expiresAt = null,
  onSubmit,
  onCancel,
  kind = 'question',
  tool = '',
  category = '',
  args = null,
}) {
  const normalizedOptions = useMemo(() => normalizeOptions(options), [options])
  const initialSelected = Array.isArray(answer?.selected)
    ? answer.selected
    : (answer?.value ? [answer.value] : [])
  const [selected, setSelected] = useState(answered ? initialSelected : [])
  const [custom, setCustom] = useState(answered ? (answer?.custom || '') : '')
  const [sending, setSending] = useState(false)
  const isApproval = kind === 'approval'
  const isDev = devtoolsEnabled()

  const expiresLabel = useMemo(() => {
    if (!expiresAt || answered) return ''
    const ms = Number(expiresAt) - Date.now()
    if (!Number.isFinite(ms) || ms <= 0) return 'истекает сейчас'
    const min = Math.floor(ms / 60000)
    const sec = Math.floor((ms % 60000) / 1000)
    return min > 0 ? `${min}м ${sec}с` : `${sec}с`
  }, [expiresAt, answered])

  const quickSubmit = async (verdict) => {
    if (answered || sending) return
    setSelected([verdict])
    setSending(true)
    try { await onSubmit?.({ selected: [verdict] }) }
    finally { setSending(false) }
  }

  const toggle = (id) => {
    if (answered) return
    setSelected((cur) => {
      if (multi) return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      return cur.includes(id) ? [] : [id]
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
    } finally { setSending(false) }
  }

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
    const catLabel = CATEGORY_LABELS[category] || category || 'Действие'
    const dangerCls = category === 'deploy'
      ? 'border-red-500/40 bg-red-900/15'
      : category === 'bash' || category === 'git'
        ? 'border-amber-500/40 bg-amber-900/15'
        : 'border-cream/15 bg-graphite-800/80'

    return (
      <div className={`my-2 rounded-xl border p-3 text-[13px] md:text-[14px] ${dangerCls}`}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
            🔐 Требуется подтверждение
          </span>
          {expiresLabel && <span className="rounded-full bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">{expiresLabel}</span>}
        </div>

        <div className="mb-1 font-medium text-cream">
          Агент хочет выполнить действие
        </div>
        <div className="mb-2 text-[12px] text-cream-soft">
          <span className="rounded-full border border-white/15 bg-graphite-900/60 px-1.5 py-0.5 text-[11px] text-cream-faint">{catLabel}</span>
          {tool && <code className="ml-2 rounded bg-graphite-900/70 px-1 py-0.5 font-mono text-[11px] text-cream">{tool}</code>}
        </div>

        {isDev && argPreview && (
          <details className="mb-2">
            <summary className="cursor-pointer text-[11px] text-cream-faint">Аргументы</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 font-mono text-[11px] leading-snug text-cream-soft">
{argPreview}
            </pre>
          </details>
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
            >{sending ? '…' : 'Разрешить'}</button>
          </div>
        ) : (
          <div className={`text-[11px] ${selected[0] === 'approve' ? 'text-emerald-300' : 'text-amber-300'}`}>
            {selected[0] === 'approve' ? '✓ Разрешено' : selected[0] === 'cancelled' ? 'Отменено' : '✕ Отклонено'}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="my-2 rounded-xl border border-cream/15 bg-graphite-800/80 p-3 text-[13px] md:text-[14px]">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-cream-faint">❓ Агенту нужно уточнение</div>
          <div className="mt-1 font-medium text-cream">{question}</div>
        </div>
        {expiresLabel && <div className="shrink-0 rounded-full bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">{expiresLabel}</div>}
      </div>

      {normalizedOptions.length > 0 && (
        <div className="space-y-1">
          {normalizedOptions.map((opt) => {
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
                <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center ${multi ? 'rounded' : 'rounded-full'} border ${checked ? 'border-cream bg-cream text-graphite-900' : 'border-white/30'}`}>
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
      )}

      {allowCustom && (
        <div className="mt-2">
          <textarea
            value={custom}
            disabled={answered}
            onChange={(e) => setCustom(e.target.value)}
            placeholder={answered ? '' : 'Свой вариант…'}
            rows={2}
            className="w-full resize-none rounded-lg border border-white/10 bg-graphite-900 px-2.5 py-1.5 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none disabled:opacity-60"
          />
        </div>
      )}

      {!answered ? (
        <div className="mt-2 flex items-center justify-end gap-2">
          {normalizedOptions.length > 0 && <span className="mr-auto text-[11px] text-cream-faint">{multi ? `Выбрано: ${selected.length}` : (selected.length ? 'Выбран 1' : 'Не выбрано')}</span>}
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
          >{sending ? 'Отправка…' : 'Ответить'}</button>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-emerald-300">✓ Ответ отправлен</div>
      )}
    </div>
  )
}
