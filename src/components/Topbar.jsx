import { IconFolder } from '../icons.jsx'

/**
 * Top bar of the chat view.
 *
 * Mode toggles (🤖 Агент, 🌐 Web AI) and the Settings button now live
 * in the Sidebar — see Sidebar.jsx. The top bar is intentionally
 * minimal so it does not overflow on mobile:
 *   left  : chat title + optional auto-model hint + "API не настроен" badge
 *   right : "Агент" status pill (read-only), Workspace toggle, Logout
 */
export default function Topbar({
  title,
  configured,
  aiWorking,
  autoMode,
  autoModelHint,
  agentMode,
  workspaceOpen,
  onToggleWorkspace,
  onOpenSettings,
  user,
  onLogout,
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-3 pb-3 pt-10 md:gap-3 md:px-5 md:py-3.5">
      {/* Левая часть: заголовок чата + подсказка авторежима + предупреждение */}
      <div className="min-w-0 flex items-center gap-2 pl-11 md:pl-12">
        <span className="truncate text-[14px] text-cream-soft">{title}</span>

        {/* Подсказка об авторежиме */}
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

      {/* Правая часть: статусы + workspace + выход */}
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {/* Бейдж агентского режима — read-only индикатор, переключается в Sidebar */}
        {agentMode && (
          <span
            className="hidden items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300 sm:inline-flex"
            title="Агентский режим активен (переключается в боковой панели)"
          >
            🤖 Агент
          </span>
        )}

        {/* Бейдж авторежима */}
        {autoMode && (
          <span className="hidden items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-300 sm:inline-flex">
            ✦ Авто
          </span>
        )}

        {/* Workspace */}
        <button
          onClick={onToggleWorkspace}
          className={`grid h-9 w-9 place-items-center rounded-lg transition-colors
                      ${
                        workspaceOpen
                          ? 'bg-graphite-700 text-cream'
                          : 'text-cream-dim hover:bg-graphite-800 hover:text-cream'
                      }`}
          title={workspaceOpen ? 'Скрыть рабочую область' : 'Показать рабочую область'}
          aria-pressed={workspaceOpen}
        >
          <IconFolder />
        </button>

        {/* Выход */}
        <button
          onClick={onLogout}
          className="rounded-lg border border-white/10 px-2.5 py-2 text-[12px] text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream"
          title={user?.email ? `Выйти из аккаунта (${user.email})` : 'Выйти из аккаунта'}
        >
          Выйти
        </button>
      </div>
    </header>
  )
}
