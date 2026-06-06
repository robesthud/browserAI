import { IconFolder, IconSettings } from '../icons.jsx'

export default function Topbar({
  title,
  configured,
  aiWorking,
  useWebAI,
  onToggleWebAI,
  autoMode,
  autoModelHint,
  workspaceOpen,
  onToggleWorkspace,
  onOpenSettings,
  user,
  onLogout,
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-3 pb-3 pt-10 md:gap-3 md:px-5 md:py-3.5">
      {/* Левая часть: заголовок чата + спиннер + подсказка авторежима */}
      <div className="min-w-0 flex items-center gap-2 pl-11 md:pl-12">
        <span className="truncate text-[14px] text-cream-soft">{title}</span>

        {/* Подсказка об авторежиме — отображается после автовыбора */}
        {autoModelHint && !aiWorking && (
          <span className="hidden shrink-0 animate-pulse rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300 sm:inline-flex">
            {autoModelHint}
          </span>
        )}

        {/* Предупреждение если API не настроен */}
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

      {/* Правая часть: Web AI, авто-бейдж, настройки, workspace */}
      <div className="flex shrink-0 items-center gap-1 md:gap-1.5">
        {/* Web AI toggle */}
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

        {/* Бейдж авторежима в топбаре */}
        {autoMode && (
          <span className="hidden items-center gap-1 rounded-lg border border-violet-400/30 bg-violet-500/15 px-2.5 py-1.5 text-[11px] text-violet-300 sm:flex">
            <span>✦</span>
            <span>Авто</span>
          </span>
        )}

        {/* Настройки */}
        <button
          onClick={onOpenSettings}
          className="grid h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream"
          title={`Настройки${user?.email ? ` · ${user.email}` : ''}`}
        >
          <IconSettings />
        </button>

        {/* Выход */}
        <button
          onClick={onLogout}
          className="rounded-lg border border-white/10 px-2.5 py-2 text-[12px] text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream"
          title="Выйти из аккаунта"
        >
          Выйти
        </button>

        {/* Workspace */}
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
