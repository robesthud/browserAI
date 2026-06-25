import { useEffect, useRef, useState } from 'react'

function shortName(model) {
  if (!model) return 'Модель'
  const raw = String(model)
  const known = [
    [/deepseek[_-]?chat/i, 'DeepSeek Chat'],
    [/deepseek[_-]?reasoner/i, 'DeepSeek Reasoner'],
    [/glm[-_ ]?4\.5[-_ ]?air/i, 'GLM 4.5 Air'],
    [/gemini[-_ ]?2\.5[-_ ]?pro/i, 'Gemini 2.5 Pro'],
    [/gemini[-_ ]?2\.5[-_ ]?flash/i, 'Gemini 2.5 Flash'],
    [/claude.*sonnet/i, 'Claude Sonnet'],
    [/gpt[-_ ]?4\.1/i, 'GPT-4.1'],
    [/gpt[-_ ]?4o/i, 'GPT-4o'],
  ]
  for (const [re, label] of known) if (re.test(raw)) return label
  let s = raw
    .replace(/[-_]?\d{4}[-_]\d{2}[-_]\d{2}.*$/i, '')
    .replace(/[-_]?\d{8}$/i, '')
    .replace(/[-_]v\d+(\.\d+)*/i, '')
    .replace(/[-_]latest$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
  return s.length > 20 ? s.slice(0, 18) + '…' : s
}

export default function MobileHeaderModelPicker({
  models = [],
  selectedModel,
  onSelectModel,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const filtered = models.filter((m) => !query || m.toLowerCase().includes(query.toLowerCase()))
  const label = shortName(selectedModel)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full bg-graphite-800/80 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
        title="Выбор модели"
      >
        <span className="max-w-[140px] truncate font-medium text-cream">{label}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" className="opacity-60">
          <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed left-2 right-2 top-[64px] z-50 max-h-[70vh] overflow-hidden rounded-2xl border border-white/10 bg-graphite-850 shadow-2xl md:absolute md:left-0 md:right-auto md:top-full md:mt-1 md:w-[300px] md:translate-x-0"
        >
          <div className="border-b border-white/5 px-2 py-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск модели"
              className="w-full rounded-lg bg-graphite-900 px-3 py-1.5 text-[12px] text-cream placeholder:text-cream-faint focus:outline-none"
            />
          </div>

          <div className="thin-scroll max-h-[50vh] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-cream-faint">
                {models.length === 0 ? 'Нет доступных моделей. Добавь ключ в настройках.' : 'Ничего не найдено'}
              </div>
            ) : (
              filtered.map((m) => {
                const active = m === selectedModel
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { onSelectModel?.(m); setOpen(false); setQuery('') }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                      active ? 'bg-graphite-700 text-cream' : 'text-cream-soft hover:bg-graphite-750 hover:text-cream'
                    }`}
                  >
                    <span className="truncate font-mono text-[12px]">{m}</span>
                    {active && <span className="text-emerald-400">●</span>}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
