import {
  IconColumns,
  IconNewChat,
  IconChat,
  IconTrash,
  IconSettings,
} from '../icons.jsx'
import SidebarUserPrefs from './SidebarUserPrefs.jsx'
import JobsTray from './JobsTray.jsx'
import AgentTasksTray from './AgentTasksTray.jsx'
import PushToggle from './PushToggle.jsx'
import NotificationBadge from './NotificationBadge.jsx'

export default function Sidebar({
  collapsed,
  onToggle,
  onNewChat,
  chats,
  activeId,
  onSelect,
  onDelete,
  onOpenSettings,
  // Перенесённые из Topbar тогглы — все «глобальные» переключатели режима
  // должны жить в одном месте, иначе на мобилке шапка переполняется
  // и часть кнопок уходит за край экрана.
  agentMode,
  onToggleAgentMode,
  useWebAI,
  onToggleWebAI,
  onResumeAgentTask,
  onFlash,
  onOpenJobChat,
}) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex h-full shrink-0 flex-col overflow-hidden border-r border-white/5 bg-graphite-800
                  transition-[width,transform] duration-300 ease-in-out md:relative md:translate-x-0
                  ${collapsed ? 'w-0 -translate-x-full border-r-0 md:translate-x-0' : 'w-[82vw] max-w-[300px] translate-x-0 md:w-[260px]'}`}
    >
      <div className="flex h-full w-[82vw] max-w-[300px] flex-col pt-8 md:w-[260px] md:pt-0">
        {/* верх: кнопка collapse */}
        <div className="flex items-center justify-end px-4 py-3.5">
          <button
            onClick={onToggle}
            className="text-cream-dim transition-colors hover:text-cream"
            title="Свернуть панель"
          >
            <IconColumns />
          </button>
        </div>

        {/* New Chat */}
        <div className="px-2.5">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px]
                       text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
          >
            <span className="text-cream">
              <IconNewChat />
            </span>
            <span>Новый чат</span>
          </button>
        </div>

        {/* список чатов */}
        <div className="thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto px-2.5">
          {chats.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] text-cream-faint">
              Пока нет чатов
            </p>
          ) : (
            <ul className="space-y-0.5">
              {chats.map((c) => {
                const active = c.id === activeId
                return (
                  <li key={c.id} className="group relative">
                    <button
                      onClick={() => onSelect(c.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-8 text-left text-[13px] transition-colors
                        ${
                          active
                            ? 'bg-graphite-750 text-cream'
                            : 'text-cream-dim hover:bg-graphite-750/60 hover:text-cream-soft'
                        }`}
                      title={c.title}
                    >
                      <span className="shrink-0 text-cream-faint">
                        <IconChat />
                      </span>
                      <span className="truncate">{c.title}</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (window.confirm(`Удалить чат «${c.title}»?`)) onDelete(c.id)
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded-md
                                 text-cream-faint opacity-0 transition-opacity hover:bg-graphite-700 hover:text-cream
                                 group-hover:opacity-100"
                      title="Удалить чат"
                    >
                      <IconTrash />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* низ: режимы + настройки */}
        <div className="space-y-1 border-t border-white/5 px-2.5 py-2.5">
          {/* Manual Agent toggle — always visible */}
            <button
              onClick={() => onToggleAgentMode?.(!agentMode)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 text-left text-[13px] transition-all duration-200 shadow-sm ${
                agentMode
                  ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300'
                  : 'bg-graphite-750/50 border border-white/5 text-cream-soft hover:bg-graphite-750 hover:text-cream'
              }`}
              title="Ручной агент: принудительно отправлять все запросы в полный агент с доступом к файлам, bash, git. Auto Mode работает автоматически."
            >
              <span className="flex items-center gap-3">
                <span className="text-lg leading-none">{agentMode ? '🤖' : '💬'}</span>
                <span className="font-medium">Ручной агент</span>
              </span>
              <div className={`relative h-5 w-9 rounded-full transition-colors ${agentMode ? 'bg-emerald-500' : 'bg-graphite-600'}`}>
                <div className={`absolute top-[2.5px] h-3.5 w-3.5 rounded-full bg-white transition-transform ${agentMode ? 'translate-x-[18px]' : 'translate-x-[2.5px]'}`} />
              </div>
            </button>

          {/* Web AI toggle — always visible */}
            <button
              onClick={() => onToggleWebAI?.(!useWebAI)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 text-left text-[13px] transition-all duration-200 ${
                useWebAI
                  ? 'bg-blue-500/20 border border-blue-500/30 text-blue-300'
                  : 'bg-graphite-750/50 border border-white/5 text-cream-soft hover:bg-graphite-750 hover:text-cream'
              }`}
              title="Подмешивать результаты веб-поиска к ответам модели"
            >
              <span className="flex items-center gap-3">
                <span className="text-lg leading-none">{useWebAI ? '🌐' : '📵'}</span>
                <span className="font-medium">Web AI</span>
              </span>
              <div className={`relative h-5 w-9 rounded-full transition-colors ${useWebAI ? 'bg-blue-500' : 'bg-graphite-600'}`}>
                <div className={`absolute top-[2.5px] h-3.5 w-3.5 rounded-full bg-white transition-transform ${useWebAI ? 'translate-x-[18px]' : 'translate-x-[2.5px]'}`} />
              </div>
            </button>

          {/* Agent Lab — Always visible now */}
          <button
            onClick={() => { window.location.href = '/admin/agent' }}
            className="flex w-full items-center gap-3 rounded-lg border border-white/5 bg-graphite-750/30 px-2.5 py-2 text-left text-[13px]
                       text-cream-soft transition-all hover:bg-graphite-750 hover:text-cream hover:border-white/15"
            title="Agent Lab: self-test, runtime diagnostics, workspace metadata"
          >
            <span className="text-lg leading-none">🧪</span>
            <span className="font-medium">Лаборатория Агента</span>
          </button>

          {/* Settings */}
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px]
                       text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
          >
            <span className="text-cream-dim">
              <IconSettings />
            </span>
            <span>Настройки</span>
          </button>
        </div>

        {/* Live background jobs (video / image / document generation) —
            shown here so they stay visible even when the user switches
            to a different chat. */}
        <NotificationBadge />
        <AgentTasksTray chatId={activeId || ''} onResume={onResumeAgentTask} onFlash={onFlash} />
        <JobsTray onOpenChat={onOpenJobChat || onSelect} />

        {/* Web Push subscription toggle — invisible on browsers without
            ServiceWorker / PushManager support. */}
        <PushToggle />

        {/* UI preferences: theme / font-size / haptics */}
        <SidebarUserPrefs />
      </div>
    </aside>
  )
}
