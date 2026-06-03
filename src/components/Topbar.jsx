import { useEffect, useMemo, useRef, useState } from 'react'
import { IconFolder, IconSettings } from '../icons.jsx'

// Короткое имя модели для отображения на кнопке
function shortModelName(model) {
  if (!model) return 'Модель'
  // Убираем длинные версии вида -20241022, -2024-10, v1.5 и т.п.
  let s = model
    .replace(/[-_]?\d{4}[-_]\d{2}[-_]\d{2}.*$/i, '')
    .replace(/[-_]?\d{8}$/i, '')
    .replace(/[-_]v\d+(\.\d+)*/i, '')
    .replace(/[-_]latest$/i, '')
  // Если осталось длинным — берём последний значимый сегмент
  const parts = s.split(/[-_]/).filter(Boolean)
  if (s.length > 22 && parts.length > 2) {
    s = parts.slice(0, 3).join('-')
  }
  return s.length > 24 ? s.slice(0, 22) + '…' : s
}

function ModelPicker({ models = [], selectedModel, autoMode, onSelectModel, onToggleAuto }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)
  const hasModels = models.length > 0

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((model) => model.toLowerCase().includes(q))
  }, [models, query])

  useEffect(() => {
    if (!open) return
    const onClickOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-1">
      {/* Кнопка Авто */}
      {hasModels && (
        <button
          type="button"
          onClick={onToggleAuto}
          className={`rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
            autoMode
              ? 'border-violet-400/40 bg-violet-500/20 text-violet-300'
              : 'border-white/10 bg-graphite-800 text-cream-faint hover:bg-graphite-750 hover:text-cream-soft'
          }`}
          title={autoMode ? 'Авторежим включён — модель выбирается по запросу' : 'Включить авторежим выбора модели'}
        >
          {autoMode ? '✦ Авто' : 'Авто'}
        </button>
      )}

      {/* Кнопка выбора модели */}
      <button
        type="button"
        onClick={() => hasModels && !autoMode && setOpen((v) => !v)}
        disabled={!hasModels}
        className={`flex items-center justify-between gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-50
          max-w-[140px] sm:max-w-[200px] md:max-w-[260px]
          ${autoMode
            ? 'border-violet-400/20 bg-graphite-800/60 text-cream-faint cursor-default'
            : 'border-white/10 bg-graphite-800 text-cream hover:bg-graphite-750'
          }`}
        title={
          autoMode
            ? `Авторежим: модель выбирается автоматически (сейчас ${selectedModel})`
            : hasModels ? 'Выберите модель' : 'Сначала добавьте API-ключ'
        }
      >
        <span className="truncate leading-none">
          {autoMode
            ? <span className="flex items-center gap-1"><span className="text-violet-400">✦</span>{shortModelName(selectedModel)}</span>
            : (shortModelName(selectedModel) || 'Нет моделей')
          }
        </span>
        {!autoMode && (
          <span className={`shrink-0 text-[9px] text-cream-faint transition-transform ${open ? 'rotate-180' : ''}`}>
            ▼
          </span>
        )}
      </button>

      {/* Дропдаун */}
      {open && hasModels && !autoMode && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[300px] overflow-hidden rounded-xl border border-white/10 bg-graphite-800 shadow-2xl">
          {/* Авто в начале списка */}
          <div className="border-b border-white/5 p-2">
            <button
              type="button"
              onClick={() => { onToggleAuto(); close() }}
              className="mb-2 flex w-full items-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-left text-[12px] text-violet-300 transition-colors hover:bg-violet-500/20"
            >
              <span className="text-[14px]">✦</span>
              <div>
                <div className="font-medium">Авторежим</div>
                <div className="text-[11px] text-violet-300/70">Модель выбирается по запросу автоматически</div>
              </div>
            </button>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск модели…"
              className="w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-[13px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
            />
          </div>

          <div className="thin-scroll max-h-64 overflow-y-auto p-1.5">
            {filtered.length > 0 ? (
              filtered.map((model) => {
                const active = model === selectedModel
                return (
                  <button
                    key={model}
                    type="button"
                    onClick={() => {
                      onSelectModel?.(model)
                      close()
                    }}
                    className={`mb-0.5 flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors last:mb-0
                      ${active ? 'bg-graphite-700 text-cream' : 'text-cream-soft hover:bg-graphite-750 hover:text-cream'}`}
                  >
                    <span className="truncate text-[13px]">{model}</span>
                  </button>
                )
              })
            ) : (
              <div className="px-3 py-3 text-[12px] text-cream-faint">
                Ничего не найдено.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function WorkingSpinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cream/25 border-t-cream"
      aria-label="AI работает"
      title="AI работает"
    />
  )
}

export default function Topbar({
  title,
  configured,
  aiWorking,
  useWebAI,
  onToggleWebAI,
  models,
  selectedModel,
  onSelectModel,
  autoMode,
  onToggleAuto,
  autoModelHint,
  workspaceOpen,
  onToggleWorkspace,
  onOpenSettings,
  user,
  onLogout,
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-3 pb-3 pt-10 md:gap-3 md:px-5 md:py-3.5">
      <div className="min-w-0 flex items-center gap-2 pl-11 md:pl-12">
        <span className="truncate text-[14px] text-cream-soft">{title}</span>
        {aiWorking && <WorkingSpinner />}
        {/* Подсказка об авторежиме */}
        {autoModelHint && !aiWorking && (
          <span className="hidden shrink-0 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300 sm:inline-flex">
            {autoModelHint}
          </span>
        )}
        {!configured && !autoModelHint && (
          <button
            onClick={onOpenSettings}
            className="hidden shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-[11px] text-amber-300 transition-colors hover:bg-amber-400/20 sm:inline-flex"
            title="Введите API-ключ и выберите модель, чтобы начать чат"
          >
            API не настроен
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 md:gap-1.5">
        <button
          onClick={() => onToggleWebAI?.(!useWebAI)}
          className={`rounded-lg border px-2 py-2 text-[11px] transition-colors md:px-3 md:text-[12px] ${
            useWebAI
              ? 'border-cream/30 bg-graphite-700 text-cream'
              : 'border-white/10 bg-graphite-800 text-cream-dim hover:bg-graphite-750 hover:text-cream'
          }`}
          title="Включить или выключить Web AI режим"
        >
          Web AI {useWebAI ? 'On' : 'Off'}
        </button>

        <ModelPicker
          models={models}
          selectedModel={selectedModel}
          autoMode={autoMode}
          onSelectModel={onSelectModel}
          onToggleAuto={onToggleAuto}
        />

        <button
          onClick={onOpenSettings}
          className="grid h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream"
          title={`Настройки${user?.email ? ` · ${user.email}` : ''}`}
        >
          <IconSettings />
        </button>
        <button
          onClick={onLogout}
          className="hidden rounded-lg border border-white/10 px-2.5 py-2 text-[12px] text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream sm:block"
          title="Выйти из аккаунта"
        >
          Выйти
        </button>
        <button
          onClick={onToggleWorkspace}
          className={`grid h-9 w-9 place-items-center rounded-lg transition-colors
                      ${
                        workspaceOpen
                          ? 'bg-graphite-700 text-cream'
                          : 'text-cream-dim hover:bg-graphite-800 hover:text-cream'
                      }`}
          title={workspaceOpen ? 'Скрыть workspace' : 'Показать workspace'}
          aria-pressed={workspaceOpen}
        >
          <IconFolder />
        </button>
      </div>
    </header>
  )
}
