import { IconFolder } from '../icons.jsx'
import MobileHeaderModelPicker from './MobileHeaderModelPicker.jsx'

/**
 * Top bar of the chat view.
 *
 * Mobile (< md):
 *   left   : burger (rendered by App.jsx outside this component)
 *   center : compact MobileHeaderModelPicker (✱ model name ▾)
 *   right  : workspace toggle
 *
 * Desktop (>= md):
 *   left   : chat title + optional auto-model hint + "API не настроен" badge
 *   right  : status pills (Агент / Авто), workspace toggle, logout
 *
 * Mode toggles (🤖 Агент, 🌐 Web AI) and Settings live in the Sidebar
 * (see Sidebar.jsx). On mobile the title is hidden so the model picker
 * has room — title is still available as the active sidebar item.
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
  // model picker
  availableModels = [],
  selectedModel,
  onSelectModel,
  onToggleAuto,
  onOpenSearch,
  onOpenCheckpoints,
  onExportChat,
  totalTokens = 0,
  costToday = 0,
  costCap = 0,
}) {
  const devtoolsEnabled = (() => {
    try { return localStorage.getItem('browserai.devtools') === '1' }
    catch { return false }
  })()

  return (
    <header className="flex items-center gap-2 px-3 pb-2 pt-10 md:gap-3 md:px-5 md:py-3.5">
      {/* Mobile: model picker takes center, hide title to save space */}
      <div className="flex flex-1 items-center justify-center md:hidden">
        <MobileHeaderModelPicker
          models={availableModels}
          selectedModel={selectedModel}
          autoMode={autoMode}
          onSelectModel={onSelectModel}
          onToggleAuto={onToggleAuto}
        />
      </div>

      {/* Desktop: classic title + badges */}
      <div className="hidden min-w-0 flex-1 items-center gap-2 pl-12 md:flex">
        <span className="truncate text-[14px] text-cream-soft">{title}</span>

        {devtoolsEnabled && autoModelHint && !aiWorking && (
          <span className="shrink-0 animate-pulse rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300">
            {autoModelHint}
          </span>
        )}

        {!configured && !autoModelHint && (
          <button
            onClick={onOpenSettings}
            className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-[11px] text-amber-300 transition-colors hover:bg-amber-400/20"
            title="Введите API-ключ и выберите модель, чтобы начать чат"
          >
            API не настроен
          </button>
        )}

        {devtoolsEnabled && agentMode && (
          <span className="ml-auto items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300 inline-flex">
            🤖 Агент
          </span>
        )}

        {devtoolsEnabled && autoMode && (
          <span className="items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-300 inline-flex">
            ✦ Авто
          </span>
        )}
      </div>

      {/* Right: search / export / tokens / workspace toggle + desktop-only logout */}
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {/* Token usage badge — only on desktop, only when there's something to show */}
        {devtoolsEnabled && totalTokens > 0 && (
          <span
            className="hidden rounded-full border border-white/10 bg-graphite-800/60 px-2 py-0.5 font-mono text-[11px] text-cream-faint md:inline"
            title={`Использовано токенов за чат: ${totalTokens}`}
          >
            {totalTokens > 9999 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tok
          </span>
        )}

        {/* USD spend today — turns amber > 50% of cap, red > 90% */}
        {devtoolsEnabled && costToday > 0 && (
          <span
            className={[
              'hidden rounded-full border px-2 py-0.5 font-mono text-[11px] md:inline',
              costCap && costToday > 0.9 * costCap
                ? 'border-red-500/40 bg-red-900/30 text-red-200'
                : costCap && costToday > 0.5 * costCap
                  ? 'border-amber-500/40 bg-amber-900/30 text-amber-200'
                  : 'border-white/10 bg-graphite-800/60 text-cream-faint',
            ].join(' ')}
            title={`Расход на LLM за сутки: $${costToday.toFixed(4)}${costCap ? ` из $${costCap.toFixed(2)} лимита` : ''}`}
          >
            ${costToday < 0.01 ? costToday.toFixed(4) : costToday.toFixed(3)}
          </span>
        )}

        {devtoolsEnabled && onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            className="hidden h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:grid"
            title="Поиск по чатам (Ctrl+K)"
          >🔎</button>
        )}

        {devtoolsEnabled && onOpenCheckpoints && (
          <button
            type="button"
            onClick={onOpenCheckpoints}
            className="hidden h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:grid"
            title="Контрольные точки — откатить ход агента"
          >💾</button>
        )}

        {devtoolsEnabled && onExportChat && (
          <button
            type="button"
            onClick={onExportChat}
            className="hidden h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:grid"
            title="Скачать чат как Markdown"
          >⬇</button>
        )}

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

        <button
          onClick={onLogout}
          className="hidden rounded-lg border border-white/10 px-2.5 py-2 text-[12px] text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:inline-block"
          title={user?.email ? `Выйти из аккаунта (${user.email})` : 'Выйти из аккаунта'}
        >
          Выйти
        </button>
      </div>
    </header>
  )
}
