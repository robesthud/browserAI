import { useEffect, useRef, useState } from 'react'

/**
 * Compact center-of-header model selector, mobile-style. Mimics the Arena
 * top bar: small pill with ✱ + model name + chevron, opens a bottom sheet
 * (well, top-sheet) with model list and an Auto toggle.
 *
 * Designed to fit between the sidebar toggle and the workspace icon in
 * the mobile top bar. Hidden on desktop (md+) where we keep the bigger
 * ModelBar above the composer.
 */

function shortName(model) {
  if (!model) return 'Модель'
  let s = String(model)
    .replace(/[-_]?\d{4}[-_]\d{2}[-_]\d{2}.*$/i, '')
    .replace(/[-_]?\d{8}$/i, '')
    .replace(/[-_]v\d+(\.\d+)*/i, '')
    .replace(/[-_]latest$/i, '')
  const parts = s.split(/[-_]/).filter(Boolean)
  if (s.length > 18 && parts.length > 2) s = parts.slice(0, 2).join('-')
  return s.length > 20 ? s.slice(0, 18) + '…' : s
}

export default function MobileHeaderModelPicker({
  models = [],
  selectedModel,
  autoMode,
  onSelectModel,
  onToggleAuto,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)

  // Close on outside tap / Escape
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
  const label = autoMode ? 'Авто' : shortName(selectedModel)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full bg-graphite-800/80 px-3 py-1.5 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
        title="Выбор модели"
      >
        <span className={`leading-none ${autoMode ? 'text-violet-300' : 'text-cream-faint'}`}>✱</span>
        <span className="max-w-[140px] truncate font-medium text-cream">{label}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" className="opacity-60">
          <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed left-2 right-2 top-[64px] z-50 max-h-[70vh] overflow-hidden rounded-2xl border border-white/10 bg-graphite-850 shadow-2xl md:absolute md:left-1/2 md:right-auto md:top-full md:mt-1 md:w-[300px] md:-translate-x-1/2"
        >
          {/* Auto-mode toggle */}
          <button
            type="button"
            onClick={() => { onToggleAuto?.(); }}
            className={`flex w-full items-center justify-between border-b border-white/5 px-3 py-2.5 text-[13px] transition-colors ${
              autoMode ? 'bg-violet-500/10 text-violet-200' : 'text-cream-soft hover:bg-graphite-750'
            }`}
          >
            <span className="flex items-center gap-2">
              <span>✦</span>
              <span>Авторежим</span>
            </span>
            <span className={`text-[11px] font-medium ${autoMode ? 'text-violet-300' : 'text-cream-faint'}`}>
              {autoMode ? 'Вкл' : 'Выкл'}
            </span>
          </button>

          {/* Search */}
          <div className="border-b border-white/5 px-2 py-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск модели"
              className="w-full rounded-lg bg-graphite-900 px-3 py-1.5 text-[12px] text-cream placeholder:text-cream-faint focus:outline-none"
            />
          </div>

          {/* Models list */}
          <div className="thin-scroll max-h-[50vh] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-cream-faint">
                {models.length === 0 ? 'Нет доступных моделей. Добавь ключ в настройках.' : 'Ничего не найдено'}
              </div>
            ) : (
              filtered.map((m) => {
                const active = !autoMode && m === selectedModel
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
