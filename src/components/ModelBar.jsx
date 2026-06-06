/**
 * ModelBar — полоска выбора модели, отображается над полем ввода.
 * Показывает текущую модель, позволяет переключить или включить авторежим.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconStar, IconStarFilled } from '../icons.jsx'

// Короткое имя модели для кнопки
function shortName(model) {
  if (!model) return 'Модель'
  let s = model
    .replace(/[-_]?\d{4}[-_]\d{2}[-_]\d{2}.*$/i, '')
    .replace(/[-_]?\d{8}$/i, '')
    .replace(/[-_]v\d+(\.\d+)*/i, '')
    .replace(/[-_]latest$/i, '')
  const parts = s.split(/[-_]/).filter(Boolean)
  if (s.length > 22 && parts.length > 2) s = parts.slice(0, 3).join('-')
  return s.length > 26 ? s.slice(0, 24) + '…' : s
}

// Иконка для типа задачи (авторежим)
const TASK_ICONS = {
  code: '💻',
  image: '🎨',
  reasoning: '🧠',
  creative: '✍️',
  fast: '⚡',
  translation: '🌐',
  general: '✨',
}

export default function ModelBar({
  models = [],
  selectedModel,
  autoMode,
  autoHint,        // { taskType, reason } | null
  onSelectModel,
  onToggleAuto,
  dropUp = true,   // true = вверх (над чатом), false = вниз (стартовый экран)
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [favorites, setFavorites] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('browserai_favorites') || '[]')
    } catch { return [] }
  })
  const rootRef = useRef(null)
  const inputRef = useRef(null)

  const toggleFavorite = (m, e) => {
    e.stopPropagation()
    const next = favorites.includes(m) ? favorites.filter(x => x !== m) : [...favorites, m]
    setFavorites(next)
    localStorage.setItem('browserai_favorites', JSON.stringify(next))
  }

  const hasModels = models.length > 0

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = models
    if (q) list = models.filter((m) => m.toLowerCase().includes(q))
    
    // Сортировка: сначала избранные
    return list.sort((a, b) => {
      const aFav = favorites.includes(a)
      const bFav = favorites.includes(b)
      if (aFav && !bFav) return -1
      if (!aFav && bFav) return 1
      return 0
    })
  }, [models, query, favorites])

  // Закрытие при клике вне
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!rootRef.current?.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Фокус на поиск при открытии
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  const select = (model) => {
    onSelectModel?.(model)
    close()
  }

  if (!hasModels) return null

  const taskIcon = autoHint?.taskType ? TASK_ICONS[autoHint.taskType] : null

  return (
    <div ref={rootRef} className="relative mx-auto mb-2 flex w-full max-w-2xl items-center gap-2 px-4">
      {/* Кнопка Авто */}
      <button
        type="button"
        onClick={onToggleAuto}
        title={autoMode ? 'Авторежим включён — отключить' : 'Включить авторежим выбора модели по запросу'}
        className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12px] font-medium transition-all
          ${autoMode
            ? 'border-violet-400/50 bg-violet-500/20 text-violet-300 hover:bg-violet-500/30'
            : 'border-white/10 bg-graphite-800/60 text-cream-faint hover:border-white/20 hover:bg-graphite-800 hover:text-cream-soft'
          }`}
      >
        <span className="text-[13px]">{autoMode ? '✦' : '⚡'}</span>
        <span>Авто</span>
      </button>

      {/* Кнопка выбора модели */}
      <button
        type="button"
        onClick={() => !autoMode && setOpen((v) => !v)}
        disabled={autoMode}
        title={
          autoMode
            ? `Авторежим: модель выбирается автоматически`
            : 'Выбрать модель'
        }
        className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-[13px] transition-all
          ${autoMode
            ? 'cursor-default border-violet-400/20 bg-graphite-800/40 text-cream-soft'
            : 'cursor-pointer border-white/10 bg-graphite-800/60 text-cream hover:border-white/20 hover:bg-graphite-800'
          }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {autoMode && taskIcon && (
            <span className="shrink-0 text-[14px]">{taskIcon}</span>
          )}
          {autoMode && (
            <span className="shrink-0 text-violet-400 text-[11px]">✦</span>
          )}
          <span className="truncate font-medium">
            {shortName(selectedModel) || 'Нет модели'}
          </span>
          {autoMode && autoHint?.reason && (
            <span className="hidden shrink-0 text-[11px] text-violet-300/70 sm:inline">
              — {autoHint.reason}
            </span>
          )}
        </span>

        {!autoMode && (
          <span className={`shrink-0 text-[10px] text-cream-faint transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
            ▼
          </span>
        )}
      </button>

      {/* Подсказка авторежима — только на мобиле (т.к. в кнопке её не видно) */}
      {autoMode && autoHint?.reason && (
        <span className="flex shrink-0 items-center gap-1 sm:hidden rounded-lg bg-violet-500/10 border border-violet-400/20 px-2 py-1 text-[11px] text-violet-300">
          {taskIcon} {autoHint.reason}
        </span>
      )}

      {/* БАГ 4 ИСПРАВЛЕН: дропдаун открывается вверх или вниз в зависимости от dropUp */}
      {open && (
        <div className={`absolute left-0 right-0 z-40 overflow-hidden rounded-2xl border border-white/10 bg-graphite-800 shadow-2xl ${dropUp ? 'bottom-full mb-2' : 'top-full mt-2'}`}>
          {/* Шапка — авторежим */}
          <div className="border-b border-white/5 p-3 space-y-2">
            <button
              type="button"
              onClick={() => { onToggleAuto(); close() }}
              className="flex w-full items-start gap-3 rounded-xl border border-violet-400/25 bg-violet-500/10 px-3 py-2.5 text-left transition-colors hover:bg-violet-500/20"
            >
              <span className="mt-0.5 text-[18px]">✦</span>
              <div>
                <div className="text-[13px] font-medium text-violet-200">Авторежим</div>
                <div className="text-[11px] text-violet-300/70 mt-0.5">
                  Модель выбирается автоматически по смыслу запроса
                  <br/>
                  <span className="text-violet-300/50">💻 код · 🎨 картинки · 🧠 рассуждения · ✍️ творчество</span>
                </div>
              </div>
            </button>

            {/* Поиск */}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск модели…"
              className="w-full rounded-xl border border-white/10 bg-graphite-900/60 px-3 py-2 text-[13px] text-cream placeholder:text-cream-faint focus:border-cream/25 focus:outline-none"
            />
          </div>

          {/* Список моделей */}
          <div className="thin-scroll max-h-60 overflow-y-auto p-2">
            {filtered.length > 0 ? (
              filtered.map((model) => {
                const active = model === selectedModel
                const isFav = favorites.includes(model)
                return (
                  <button
                    key={model}
                    type="button"
                    onClick={() => select(model)}
                    className={`mb-0.5 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors last:mb-0
                      ${active
                        ? 'bg-graphite-700 text-cream'
                        : 'text-cream-soft hover:bg-graphite-750 hover:text-cream'
                      }`}
                  >
                    <button
                      onClick={(e) => toggleFavorite(model, e)}
                      className={`shrink-0 p-1 hover:scale-110 transition-transform ${isFav ? 'text-amber-400' : 'text-white/10 hover:text-white/30'}`}
                      title={isFav ? 'Убрать из избранного' : 'Добавить в избранное'}
                    >
                      {isFav ? <IconStarFilled /> : <IconStar />}
                    </button>
                    {active && (
                      <span className="shrink-0 text-[12px] text-green-400">●</span>
                    )}
                    <span className="truncate text-[13px]">{model}</span>
                    {active && (
                      <span className="ml-auto shrink-0 rounded-full bg-graphite-600 px-2 py-0.5 text-[10px] text-cream-faint">
                        активна
                      </span>
                    )}
                  </button>
                )
              })
            ) : (
              <div className="px-3 py-4 text-center text-[12px] text-cream-faint">
                Ничего не найдено
              </div>
            )}
          </div>

          <div className="border-t border-white/5 px-3 py-2 text-[11px] text-cream-faint">
            {models.length} {models.length === 1 ? 'модель' : models.length < 5 ? 'модели' : 'моделей'} доступно
          </div>
        </div>
      )}
    </div>
  )
}
