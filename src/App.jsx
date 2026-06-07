import { useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Topbar from './components/Topbar.jsx'
import Composer from './components/Composer.jsx'
import Workspace from './components/Workspace.jsx'
import MessageList from './components/MessageList.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import AuthGate from './components/AuthGate.jsx'
import DeepSeekAdmin from './components/DeepSeekAdmin.jsx'
import ModelBar from './components/ModelBar.jsx'
import { IconExpand } from './icons.jsx'
import {
  findKeyForModel,
  getActiveKey,
  getAllAvailableModels,
  getAvailableModels,
  getSelectedModel,
  isConfigured,
} from './lib/settings.js'
import { useSettings } from './lib/useSettings.js'
import { useChats } from './lib/useChats.js'
import { backend } from './lib/backend.js'
import { pickBestModel } from './lib/autoModel.js'
import useEdgeSwipe from './lib/useEdgeSwipe.js'
import haptics from './lib/haptics.js'

// CloudSync работает только когда пользователь залогинен через аккаунт.
// Сохраняет чаты + настройки (без ключей — ключи идут через /api/keys отдельно).
function CloudSync({ settings, chats }) {
  const firstRun = useRef(true)
  const isLoggedIn = typeof localStorage !== 'undefined'
    && localStorage.getItem('browserai.auth.enabled') === '1'

  // Не синхронизируем пока идёт стриминг
  const hasPending = chats.some((chat) =>
    chat.messages.some((m) => m.pending === true),
  )

  useEffect(() => {
    if (!isLoggedIn) return undefined
    if (firstRun.current) {
      firstRun.current = false
      return undefined
    }
    if (hasPending) return undefined
    const timer = setTimeout(() => {
      // Сохраняем настройки (без ключей — они в /api/keys) + все чаты
      const settingsToSave = {
        systemPrompt: settings.systemPrompt,
        temperature: settings.temperature,
        stream: settings.stream,
        useWebAI: settings.useWebAI,
        activeKeyId: settings.activeKeyId,
        // Ключи тоже сохраняем в cloud как резервная копия
        keys: settings.keys,
      }
      void backend.saveCloud({ settings: settingsToSave, chats }).catch(() => {})
    }, 1500)
    return () => clearTimeout(timer)
  }, [settings, chats, hasPending, isLoggedIn])

  return null
}

function BrowserApp({ user, reloadAuth }) {
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  )
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspaceAiBusy, setWorkspaceAiBusy] = useState(false)

  // Авторежим выбора модели
  const [autoMode, setAutoMode] = useState(() => {
    try {
      return localStorage.getItem('browserai.autoMode') === '1'
    } catch {
      return false
    }
  })
  // Подсказка об авторежиме { reason, taskType, icon } | null
  const [autoHint, setAutoHint] = useState(null)

  // Сохраняем autoMode в localStorage
  useEffect(() => {
    try {
      localStorage.setItem('browserai.autoMode', autoMode ? '1' : '0')
    } catch {
      // localStorage may be unavailable
    }
  }, [autoMode])

  // Agent mode — model is allowed to call tools (workspace / web / bash)
  const [agentMode, setAgentMode] = useState(() => {
    try {
      return localStorage.getItem('browserai.agentMode') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('browserai.agentMode', agentMode ? '1' : '0')
    } catch {
      // localStorage may be unavailable
    }
  }, [agentMode])

  const {
    settings,
    online,
    vault,
    saveKey,
    deleteKey,
    activateKey,
    setActiveModel,
    setParams,
    importKeys,
    validateKey,
    vaultSetup,
    vaultUnlock,
    vaultLock,
    vaultChange,
    vaultDisable,
    vaultAutolock,
    vaultBackup,
    vaultRestore,
  } = useSettings()

  const {
    chats,
    activeChat,
    activeId,
    isStreaming,
    newChat,
    selectChat,
    deleteChat,
    updateChat,
    sendMessage,
    sendAgentMessage,
    answerAgentQuestion,
    stop,
  } = useChats(settings)

  // Unified "AI is busy" flag — true while streaming a chat answer OR
  // while a workspace AI operation is running. Used to gate Regenerate /
  // MessageList spinner / Topbar status. Previously this variable was
  // referenced in App but never declared (the inline expression existed
  // only in the Topbar prop), which produced a runtime ReferenceError
  // ('aiWorking is not defined') the moment a chat had any messages.
  const aiWorking = isStreaming || workspaceAiBusy

  const closeSidebarOnMobile = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setCollapsed(true)
    }
  }

  const handleNewChat = () => {
    const id = newChat()
    closeSidebarOnMobile()
    return id
  }

  const handleSelectChat = (id) => {
    selectChat(id)
    closeSidebarOnMobile()
  }

  const toggleSidebar = () => setCollapsed((v) => !v)

  // iOS-style edge swipe: from the left edge opens the sidebar when
  // collapsed. Only active on touch devices; harmless no-op on desktop.
  useEdgeSwipe({
    side: 'left',
    enabled: collapsed,
    onTrigger: () => { setCollapsed(false); haptics.tap() },
  })
  const toggleWorkspace = () => setWorkspaceOpen((v) => !v)
  const logout = async () => {
    await backend.saveCloud({ settings, chats }).catch(() => {})
    await backend.authLogout().catch(() => {})
    localStorage.removeItem('browserai.auth.enabled')
    await reloadAuth?.()
  }

  const handleEditMessage = (m) => {
    // Вставляем текст в Composer (сделать это можно через событие или стейт)
    // Но для простоты: Ищем Composer input
    const ta = document.querySelector('textarea')
    if (ta) {
      ta.value = m.content
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
      // Dispatch event to trigger React state update if needed, but easier is just value change + focus
      ta.focus()
    }
  }

  const handleRegenerate = (m) => {
    if (aiWorking || !activeChat) return
    // Находим индекс этого сообщения
    const idx = messages.findIndex(x => x.id === m.id)
    if (idx === -1) return
    // Удаляем это сообщение И ВСЕ после него
    const updatedMessages = messages.slice(0, idx)
    updateChat(activeChat.id, { messages: updatedMessages })
    
    // Запускаем перегенерацию на основе предыдущих сообщений (нужно отправить заново)
    // Последнее сообщение юзера:
    const lastUserMsg = updatedMessages.reverse().find(x => x.role === 'user')
    if (lastUserMsg) {
      // Инициируем запрос повторно
      sendMessage(lastUserMsg.content, lastUserMsg.attachments, selectedModel)
    }
  }

  const configured = isConfigured(settings)
  const activeKey = useMemo(() => getActiveKey(settings), [settings])
  const availableModels = useMemo(() => {
    const all = getAllAvailableModels(settings)
    return all.length ? all : getAvailableModels(activeKey)
  }, [settings, activeKey])
  const selectedModel = getSelectedModel(activeKey)
  const messages = activeChat?.messages ?? []
  const hasMessages = messages.length > 0

  // При смене чата — сбрасываем подсказку
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoHint(null)
  }, [activeId])

  const providerOverrideForModel = (model) => {
    const key = findKeyForModel(settings, model)
    if (!key) return null
    return {
      baseUrl: key.baseUrl,
      apiKey: key.apiKey,
      model,
      authType: key.authType || 'bearer',
      authHeader: key.authHeader || '',
      responsePath: key.responsePath || '',
      extraHeaders: key.extraHeaders || {},
      systemPrompt: settings.systemPrompt,
      temperature: settings.temperature,
      stream: settings.stream,
      useWebAI: settings.useWebAI,
    }
  }

  // Обёртка sendMessage с авторежимом
  // БАГ 3 ИСПРАВЛЕН: передаём выбранную модель напрямую в sendMessage (overrideModel),
  // не ждём пока React обновит settings — это устраняет гонку данных
  const handleSendMessage = async (text, attachments = []) => {
    // Agent mode short-circuits the regular chat flow. It streams /api/agent/chat
    // (tool calls + final answer) instead of a plain LLM completion.
    if (agentMode) {
      return sendAgentMessage(text, attachments)
    }

    let overrideModel = null

    if (autoMode && availableModels.length > 1 && text?.trim()) {
      const result = pickBestModel(text, availableModels, selectedModel)
      if (result.changed) {
        overrideModel = providerOverrideForModel(result.model) || result.model
        // Обновляем настройки в фоне (без await — не блокируем отправку)
        setActiveModel(result.model).catch(() => {})
        setAutoHint({
          reason: result.reason,
          taskType: result.taskType,
          icon: result.icon,
        })
        setTimeout(() => setAutoHint(null), 5000)
      } else {
        setAutoHint(null)
      }
    }

    return sendMessage(text, attachments, overrideModel)
  }

  const handleToggleAuto = () => {
    setAutoMode((v) => !v)
    setAutoHint(null)
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-graphite-900 text-cream">
      <CloudSync settings={settings} chats={chats} />
      <Sidebar
        collapsed={collapsed}
        onToggle={toggleSidebar}
        onNewChat={handleNewChat}
        chats={chats}
        activeId={activeId}
        onSelect={handleSelectChat}
        onDelete={deleteChat}
        onOpenSettings={() => setSettingsOpen(true)}
        agentMode={agentMode}
        onToggleAgentMode={setAgentMode}
        useWebAI={settings.useWebAI}
        onToggleWebAI={(next) => setParams({ useWebAI: next })}
      />

      {!collapsed && (
        <button
          className="fixed inset-0 z-30 bg-black/45 md:hidden"
          onClick={() => setCollapsed(true)}
          aria-label="Закрыть меню"
        />
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        {collapsed && (
          <button
            onClick={toggleSidebar}
            className="absolute left-3 top-10 z-10 grid h-9 w-9 place-items-center rounded-lg
                       text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream md:top-3.5"
            title="Развернуть панель"
          >
            <IconExpand />
          </button>
        )}

        <Topbar
          title={activeChat?.title ?? 'BrowserAI'}
          configured={configured}
          aiWorking={aiWorking}
          autoMode={autoMode}
          autoModelHint={autoHint ? `${autoHint.icon || ''} ${autoHint.reason}` : ''}
          agentMode={agentMode}
          workspaceOpen={workspaceOpen}
          onToggleWorkspace={toggleWorkspace}
          onOpenSettings={() => setSettingsOpen(true)}
          user={user}
          onLogout={logout}
          availableModels={availableModels}
          selectedModel={selectedModel}
          onSelectModel={setActiveModel}
          onToggleAuto={handleToggleAuto}
        />

        {hasMessages ? (
          <>
            <MessageList
              messages={messages}
              aiWorking={aiWorking}
              onEdit={handleEditMessage}
              onRegenerate={handleRegenerate}
              onRefresh={() => location.reload()}
              onAnswerAskUser={(messageId, questionId, payload) =>
                answerAgentQuestion(activeChat.id, messageId, questionId, payload)
              }
            />
            {/* ModelBar над полем ввода (когда есть сообщения) — только на десктопе.
                На мобиле выбор модели живёт в шапке (MobileHeaderModelPicker). */}
            {availableModels.length > 0 && (
              <div className="hidden md:block">
                <ModelBar
                  models={availableModels}
                  selectedModel={selectedModel}
                  autoMode={autoMode}
                  autoHint={autoHint}
                  onSelectModel={setActiveModel}
                  onToggleAuto={handleToggleAuto}
                  dropUp={true}
                />
              </div>
            )}
            <Composer
              hasMessages
              isStreaming={isStreaming}
              onSend={handleSendMessage}
              onStop={stop}
            />
          </>
        ) : (
          <>
            <Composer
              hasMessages={false}
              isStreaming={isStreaming}
              onSend={handleSendMessage}
              onStop={stop}
            />
            {/* ModelBar под полем ввода на стартовом экране — дропдаун открывается вниз */}
            {availableModels.length > 0 && (
              <div className="flex justify-center pb-4">
                <div className="w-full max-w-2xl px-4">
                  <ModelBar
                    models={availableModels}
                    selectedModel={selectedModel}
                    autoMode={autoMode}
                    autoHint={autoHint}
                    onSelectModel={setActiveModel}
                    onToggleAuto={handleToggleAuto}
                    dropUp={false}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <Workspace
        open={workspaceOpen}
        onClose={toggleWorkspace}
        settings={settings}
        chatId={activeId || ''}
        onSendToChat={handleSendMessage}
        onAiBusyChange={setWorkspaceAiBusy}
      />

      <SettingsModal
        key={settingsOpen ? 'open' : 'closed'}
        open={settingsOpen}
        settings={settings}
        online={online}
        vault={vault}
        onSaveKey={saveKey}
        onDeleteKey={deleteKey}
        onActivateKey={activateKey}
        onSetParams={setParams}
        onImportKeys={importKeys}
        onValidateKey={validateKey}
        onVaultSetup={vaultSetup}
        onVaultUnlock={vaultUnlock}
        onVaultLock={vaultLock}
        onVaultChange={vaultChange}
        onVaultDisable={vaultDisable}
        onVaultAutolock={vaultAutolock}
        onVaultBackup={vaultBackup}
        onVaultRestore={vaultRestore}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

export default function App() {
  // Admin routes use plain pathname matching to avoid pulling react-router
  // for a single page. AuthGate still guards access via cookie session.
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (pathname === '/admin/deepseek') {
    return (
      <AuthGate>
        {() => <DeepSeekAdmin />}
      </AuthGate>
    )
  }
  return (
    <AuthGate>
      {({ user, reloadAuth, renderKey }) => (
        <BrowserApp key={renderKey} user={user} reloadAuth={reloadAuth} />
      )}
    </AuthGate>
  )
}
