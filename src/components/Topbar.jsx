import { useEffect, useMemo, useRef, useState } from 'react'
import { IconFolder, IconSettings } from '../icons.jsx'

function ModelPicker({ models = [], selectedModel, onSelectModel }) {
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
    <div ref={rootRef} className="relative hidden sm:block">
      <button
        type="button"
        onClick={() => hasModels && setOpen((v) => !v)}
        disabled={!hasModels}
        className="flex min-w-[160px] max-w-[220px] items-center justify-between gap-2 rounded-lg border border-white/10 bg-graphite-800 px-3 py-2 text-left text-[13px] text-cream transition-colors disabled:opacity-50 md:min-w-[220px] md:max-w-[260px]"
        title={hasModels ? 'Выберите модель' : 'Сначала добавьте и сохраните API-ключ'}
      >
        <span className="truncate">
          {selectedModel || 'Модели недоступны'}
        </span>
        <span className={`text-[10px] text-cream-faint transition-transform ${open ? 'rotate-180' : ''}`}>
          ▼
        </span>
      </button>

      {open && hasModels && (
        <div className="absolute right-0 top-full z-20 mt-2 w-[300px] overflow-hidden rounded-xl border border-white/10 bg-graphite-800 shadow-2xl">
          <div className="border-b border-white/5 p-2">
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
                    className={`mb-1 flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] transition-colors last:mb-0
                      ${
                        active
                          ? 'bg-graphite-700 text-cream'
                          : 'text-cream-soft hover:bg-graphite-750 hover:text-cream'
                      }`}
                  >
                    <span className="truncate">{model}</span>
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
  workspaceOpen,
  onToggleWorkspace,
  onOpenSettings,
  user,
  onLogout,
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-3 py-3 md:gap-3 md:px-5 md:py-3.5">
      <div className="min-w-0 flex items-center gap-2 pl-11 md:pl-12">
        <span className="truncate text-[14px] text-cream-soft">{title}</span>
        {aiWorking && <WorkingSpinner />}
        {!configured && (
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
          onSelectModel={onSelectModel}
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
