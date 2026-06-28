import { useMemo, useState } from 'react'
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

function formatChatTime(ts) {
  if (!ts) return ''
  const d = new Date(Number(ts))
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diffMs = now - d
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'вчера'
  if (diffDays < 7) return `${diffDays}д`
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}

function lastMessagePreview(chat) {
  const msgs = chat.messages || []
  if (!msgs.length) return ''
  const last = [...msgs].reverse().find(m => (m.content || '').trim())
  if (!last) return ''
  return String(last.content).replace(/\s+/g, ' ').slice(0, 80)
}

export default function Sidebar({
  collapsed,
  onToggle,
  onNewChat,
  chats,
  activeId,
  onSelect,
  onDelete,
  onRename,
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
  devtoolsEnabled = false,
}) {
  const [query, setQuery] = useState('')

  const filteredChats = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chats
    return chats.filter(c => {
      const title = String(c.title || '').toLowerCase()
      const preview = lastMessagePreview(c).toLowerCase()
      const id = String(c.id || '').toLowerCase()
      return title.includes(q) || preview.includes(q) || id.includes(q)
    })
  }, [chats, query])
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

        {/* поиск по чатам */}
        <div className="px-2.5 mt-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск чатов…"
            className="w-full rounded-lg border border-white/10 bg-graphite-900 px-2.5 py-1.5 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/20 focus:outline-none"
          />
        </div>

        {/* счётчик / источник */}
        <div className="px-4 mt-2 flex items-center justify-between text-[10px] text-cream-faint">
          <span>{filteredChats.length} / {chats.length}</span>
          <span className="font-mono">OH • live</span>
        </div>

        {/* список чатов */}
        <div className="thin-scroll mt-2 min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
          {filteredChats.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] text-cream-faint">
              {chats.length === 0 ? 'Пока нет чатов' : 'Ничего не найдено'}
            </p>
          ) : (
            <ul className="space-y-1">
              {filteredChats.map((c) => {
                const active = c.id === activeId
                const preview = lastMessagePreview(c)
                const time = formatChatTime(c.updatedAt || c.updated_at || c.createdAt)
                                return (
                  <li key={c.id} className="group relative">
                    <button
                      onClick={() => onSelect(c.id)}
                      className={`flex w-full flex-col rounded-lg px-2.5 py-2 text-left transition-colors border ${
                        active
                          ? 'bg-graphite-750 text-cream border-white/10'
                          : 'text-cream-dim hover:bg-graphite-750/60 hover:text-cream-soft border-transparent hover:border-white/5'
                      }`}
                      title={c.title}
                    >
                      <div className="flex w-full items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="shrink-0 text-cream-faint mt-0.5">
                            <IconChat />
                          </span>
                          <span className="truncate text-[13px] font-medium">{c.title || 'Новый чат'}</span>
                        </div>
                        <span className="text-[10px] text-cream-faint/80 shrink-0 mt-0.5">{time}</span>
                      </div>
                      {preview && (
                        <div className="mt-1 text-[11px] text-cream-faint truncate w-full pr-6">
                          {preview}
                        </div>
                      )}

                    </button>
                    <div className="absolute right-8 top-2 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const next = window.prompt('Новое название чата', c.title || '')
                          if (next && next.trim() && next.trim() !== c.title) {
                            onRename?.(c.id, next.trim()).catch(err => alert('Переименование не удалось: ' + (err.message || err)))
                          }
                        }}
                        className="grid h-6 w-6 place-items-center rounded-md text-cream-faint hover:bg-graphite-700 hover:text-cream"
                        title="Переименовать"
                      >
                        <span className="text-[12px]">✎</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm(`Удалить чат «${c.title}»?`)) onDelete(c.id)
                        }}
                        className="grid h-6 w-6 place-items-center rounded-md text-cream-faint hover:bg-graphite-700 hover:text-red-300"
                        title="Удалить чат"
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* низ: основной продуктовый UX — только настройки; Dev Lab скрыт за devtools */}
        <div className="space-y-1 border-t border-white/5 px-2.5 py-2.5">
          {devtoolsEnabled && (
            <>
              <button
                onClick={() => onToggleAgentMode?.(!agentMode)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 text-left text-[13px] transition-all duration-200 shadow-sm ${
                  agentMode
                    ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300'
                    : 'bg-graphite-750/50 border border-white/5 text-cream-soft hover:bg-graphite-750 hover:text-cream'
                }`}
                title="Devtools override: принудительно включить/выключить Agent Mode. В обычном интерфейсе Agent Mode всегда основной режим."
              >
                <span className="flex items-center gap-3">
                  <span className="text-lg leading-none">{agentMode ? '🤖' : '💬'}</span>
                  <span className="font-medium">Agent override</span>
                </span>
                <div className={`relative h-5 w-9 rounded-full transition-colors ${agentMode ? 'bg-emerald-500' : 'bg-graphite-600'}`}>
                  <div className={`absolute top-[2.5px] h-3.5 w-3.5 rounded-full bg-white transition-transform ${agentMode ? 'translate-x-[18px]' : 'translate-x-[2.5px]'}`} />
                </div>
              </button>

              <button
                onClick={() => onToggleWebAI?.(!useWebAI)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 text-left text-[13px] transition-all duration-200 ${
                  useWebAI
                    ? 'bg-blue-500/20 border border-blue-500/30 text-blue-300'
                    : 'bg-graphite-750/50 border border-white/5 text-cream-soft hover:bg-graphite-750 hover:text-cream'
                }`}
                title="Devtools: подмешивать результаты веб-поиска к ответам модели"
              >
                <span className="flex items-center gap-3">
                  <span className="text-lg leading-none">{useWebAI ? '🌐' : '📵'}</span>
                  <span className="font-medium">Web AI</span>
                </span>
                <div className={`relative h-5 w-9 rounded-full transition-colors ${useWebAI ? 'bg-blue-500' : 'bg-graphite-600'}`}>
                  <div className={`absolute top-[2.5px] h-3.5 w-3.5 rounded-full bg-white transition-transform ${useWebAI ? 'translate-x-[18px]' : 'translate-x-[2.5px]'}`} />
                </div>
              </button>

              <button
                onClick={() => { window.location.href = '/admin/agent' }}
                className="flex w-full items-center gap-3 rounded-lg border border-white/5 bg-graphite-750/30 px-2.5 py-2 text-left text-[13px]
                           text-cream-soft transition-all hover:bg-graphite-750 hover:text-cream hover:border-white/15"
                title="Dev Lab: operator panels, diagnostics, deploys, automation"
              >
                <span className="text-lg leading-none">🧪</span>
                <span className="font-medium">Dev Lab</span>
              </button>
            </>
          )}

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

        {devtoolsEnabled && (
          <>
            {/* Live background jobs and technical trays live in Dev Lab/devtools,
                not in the clean Agent Mode surface. */}
            <NotificationBadge />
            <AgentTasksTray chatId={activeId || ''} onResume={onResumeAgentTask} onFlash={onFlash} />
            <JobsTray onOpenChat={onOpenJobChat || onSelect} />
            <PushToggle />
            <SidebarUserPrefs />
          </>
        )}
      </div>
    </aside>
  )
}
