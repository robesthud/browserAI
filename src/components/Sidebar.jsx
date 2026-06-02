import {
  IconColumns,
  IconNewChat,
  IconChat,
  IconTrash,
  IconSettings,
} from '../icons.jsx'

export default function Sidebar({
  collapsed,
  onToggle,
  onNewChat,
  chats,
  activeId,
  onSelect,
  onDelete,
  onOpenSettings,
}) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex h-full shrink-0 flex-col overflow-hidden border-r border-white/5 bg-graphite-800
                  transition-[width,transform] duration-300 ease-in-out md:relative md:translate-x-0
                  ${collapsed ? 'w-0 -translate-x-full border-r-0 md:translate-x-0' : 'w-[82vw] max-w-[300px] translate-x-0 md:w-[260px]'}`}
    >
      <div className="flex h-full w-[82vw] max-w-[300px] flex-col md:w-[260px]">
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
            <span>New Chat</span>
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
                        onDelete(c.id)
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

        {/* низ: настройки */}
        <div className="border-t border-white/5 px-2.5 py-2.5">
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
      </div>
    </aside>
  )
}
