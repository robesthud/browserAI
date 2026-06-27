import { IconFolder, IconExpand } from '../icons.jsx'
import MobileHeaderModelPicker from './MobileHeaderModelPicker.jsx'
import ProviderStatusBadge from './ProviderStatusBadge.jsx'

export default function Topbar({
  collapsed,
  onToggleSidebar,
  title,
  configured,
  aiWorking,
  agentMode,
  agentContext = null,
  workspaceOpen,
  onToggleWorkspace,
  onOpenSettings,
  user,
  onLogout,
  // model picker
  availableModels = [],
  selectedModel,
  onSelectModel,
  onOpenSearch,
  onOpenCheckpoints,
  onExportChat,
  totalTokens = 0,
  costToday = 0,
  costCap = 0,
  devtoolsEnabled: devtoolsEnabledProp = false,
}) {
  const devtoolsEnabled = devtoolsEnabledProp || (() => {
    try { return localStorage.getItem('browserai.devtools') === '1' }
    catch { return false }
  })()

  return (
    <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-safe md:gap-3 md:px-5 md:py-3.5">
      <div className="flex min-w-0 flex-1 items-center justify-start gap-2 md:pl-12">
        {collapsed && (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Открыть меню"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-cream-dim hover:bg-graphite-800"
            title="Открыть меню"
          >
            <IconExpand />
          </button>
        )}
        <MobileHeaderModelPicker
          models={availableModels}
          selectedModel={selectedModel}
          onSelectModel={onSelectModel}
          devtoolsEnabled={devtoolsEnabled}
        />
        {/* Provider status badge — shows current model + fallback indicator */}
        <ProviderStatusBadge
          agentContext={agentContext}
          isBusy={aiWorking}
        />
        <span className="hidden truncate text-[14px] text-cream-soft md:inline-block">{title}</span>

        {!configured && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300 transition-colors hover:bg-amber-400/20 md:px-2.5"
            title="Введите API-ключ и выберите модель, чтобы начать чат"
            aria-label="API не настроен — открыть настройки"
          >
            <span className="md:hidden">API?</span>
            <span className="hidden md:inline">API не настроен</span>
          </button>
        )}

        {devtoolsEnabled && agentMode && (
          <span className="ml-auto hidden items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300 md:inline-flex">
            🤖 Агент
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {devtoolsEnabled && totalTokens > 0 && (
          <span
            className="hidden rounded-full border border-white/10 bg-graphite-800/60 px-2 py-0.5 font-mono text-[11px] text-cream-faint md:inline"
            title={`Использовано токенов за чат: ${totalTokens}`}
          >
            {totalTokens > 9999 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tok
          </span>
        )}

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
            aria-label="Поиск по чатам"
            className="hidden h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:grid"
            title="Поиск по чатам (Ctrl+K)"
          >🔎</button>
        )}

        {devtoolsEnabled && onOpenCheckpoints && (
          <button
            type="button"
            onClick={onOpenCheckpoints}
            aria-label="Контрольные точки"
            className="hidden h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:grid"
            title="Контрольные точки — откатить ход агента"
          >💾</button>
        )}

        {devtoolsEnabled && onExportChat && (
          <button
            type="button"
            onClick={onExportChat}
            aria-label="Скачать чат как Markdown"
            className="hidden h-9 w-9 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:grid"
            title="Скачать чат как Markdown"
          >⬇</button>
        )}

        <button
          type="button"
          onClick={onToggleWorkspace}
          aria-label={workspaceOpen ? 'Скрыть рабочую область' : 'Показать рабочую область'}
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
          type="button"
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
