import { useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Topbar from './components/Topbar.jsx'
import Composer from './components/Composer.jsx'
import Workspace from './components/Workspace.jsx'
import MessageList from './components/MessageList.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import AuthGate from './components/AuthGate.jsx'
import DeepSeekAdmin from './components/DeepSeekAdmin.jsx'
import OpsAdmin from './components/OpsAdmin.jsx'
import ModelBar from './components/ModelBar.jsx'
import ChatSearchModal from './components/ChatSearchModal.jsx'
import CheckpointsTray from './components/CheckpointsTray.jsx'
import { downloadChatMarkdown } from './lib/chatExport.js'
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
import { getTaskType, pickBestModel } from './lib/autoModel.js'
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
  // ── LLM cost badge: poll daily total every 30 s ─────────────────────
  const [costInfo, setCostInfo] = useState({ dailyTotal: 0, cap: 0 })
  useEffect(() => {
    let alive = true
    async function refresh() {
      try {
        const r = await fetch('/api/cost/today', { credentials: 'include' })
        if (!r.ok) return
        const j = await r.json()
        if (alive) setCostInfo({ dailyTotal: Number(j.dailyTotal || 0), cap: Number(j.cap || 0) })
      } catch { /* ignore */ }
    }
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  )
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspaceAiBusy, setWorkspaceAiBusy] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  const [flash, setFlash] = useState(null) // { kind: 'ok'|'info'|'err', text: '...' }

  // Auto-dismiss flash after 6s.
  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 6000)
    return () => clearTimeout(id)
  }, [flash])

  // Slash-command hook bundle passed to Composer.
  const composerSlashHooks = {
    onSlashClear: () => { newChat() },
    onSlashSettings: () => setSettingsOpen(true),
    onSlashSearch: () => setSearchOpen(true),
    onSlashCheckpoints: () => setCheckpointsOpen(true),
    onSlashExport: () => { if (activeChat) downloadChatMarkdown(activeChat) },
    onSlashToggleAgent: (forceOn) => {
      // Persists per-chat — agentMode lives in chat object.
      if (!activeChat) return
      const cur = activeChat.agentMode !== false
      const next = forceOn == null ? !cur : Boolean(forceOn)
      updateChat(activeChat.id, { agentMode: next })
      setFlash({ kind: 'info', text: `Agent Mode: ${next ? 'включён' : 'выключен'}` })
    },
    onSlashSetModel: (modelId) => {
      // Returns true on success — Composer surfaces the verdict via flash.
      const all = availableModels || []
      const hit = all.find((m) => m.id === modelId || m.name === modelId || (m.id || '').endsWith(modelId))
      if (!hit) return false
      setActiveModel?.(hit.id)
      return true
    },
    onSlashFetchCost: async () => {
      try {
        const r = await fetch('/api/cost/today', { credentials: 'include' })
        return r.ok ? r.json() : null
      } catch { return null }
    },
    onFlash: setFlash,
  }

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

  // Global Ctrl/Cmd+K hotkey → open chat search modal. Ignored when
  // a text field is focused so users typing 'K' get no surprise modal.
  useEffect(() => {
    const onKey = (e) => {
      const isCmd = e.metaKey || e.ctrlKey
      if (!isCmd || e.key.toLowerCase() !== 'k') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      const isEditable = document.activeElement?.isContentEditable
      if (tag === 'input' || tag === 'textarea' || isEditable) return
      e.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Agent mode — model is allowed to call tools (workspace / web / bash /
  // github / download_url). Default ON: users overwhelmingly expect AI to
  // be able to download files / clone repos / read attachments etc., and
  // shouldUseAgentForText() routes only the right prompts through tools.
  const [agentMode, setAgentMode] = useState(() => {
    try {
      const saved = localStorage.getItem('browserai.agentMode')
      if (saved === '1') return true
      if (saved === '0') return false
      return true   // default for first-time users
    } catch {
      return true
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
    jobBusy,
    markJobDone,
    newChat,
    selectChat,
    deleteChat,
    branchFromMessage,
    updateChat,
    sendMessage,
    sendAgentMessage,
    answerAgentQuestion,
    cancelAgentQuestion,
    stop,
  } = useChats(settings)

  // Unified "AI is busy" flag — true while streaming a chat answer OR
  // while a workspace AI operation is running. Used to gate Regenerate /
  // MessageList spinner / Topbar status. Previously this variable was
  // referenced in App but never declared (the inline expression existed
  // only in the Topbar prop), which produced a runtime ReferenceError
  // ('aiWorking is not defined') the moment a chat had any messages.
  const aiWorking = isStreaming || workspaceAiBusy || jobBusy

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

  const shouldUseAgentForText = (text, taskType) => {
    if (!agentMode) return false
    const lower = String(text || '').toLowerCase()
    // Phrases that *unambiguously* need tools (download files, manage workspace,
    // run shell, hit GitHub, etc.). When any of these are present we ALWAYS
    // run the agent loop — even if the auto-router decided the task is a
    // 'chat' or 'image' (so the model wouldn't otherwise see its toolbox).
    // Without this, "Скачай файлы с гитхаб robesthud/browserai" would print
    // a Markdown instruction instead of actually downloading the repo.
    const NEEDS_TOOLS_RE = /(скачай|скачать|загруз|клонир|оживи фай|workspace|воркспейс|папк|файл|github|gitlab|gitea|bitbucket|git[\s_-]?clone|\.git\b|гитхаб|гитлаб|репозитор|repo\s|запусти|выполни\s+команд|исправь|измени файл|create file|создай файл|удали файл|delete file|переименуй)/i
    if (NEEDS_TOOLS_RE.test(lower)) return true
    // For "soft" non-tool tasks (just chat / image-gen / fast Q&A), keep
    // the conversation in plain chat mode so the user doesn't see the
    // tool-call UI noise.
    if (autoMode && ['image', 'chat', 'fast', 'creative', 'translation'].includes(taskType || '')) return false
    return (
      taskType === 'code' ||
      lower.includes('исправь') ||
      lower.includes('измени')
    )
  }

  // Обёртка sendMessage с авторежимом
  // БАГ 3 ИСПРАВЛЕН: передаём выбранную модель напрямую в sendMessage (overrideModel),
  // не ждём пока React обновит settings — это устраняет гонку данных
  const handleSendMessage = async (text, attachments = []) => {
    let overrideModel = null
    let routedTaskType = getTaskType(text || '')

    if (autoMode && availableModels.length > 1 && text?.trim()) {
      const result = pickBestModel(text, availableModels, selectedModel)
      routedTaskType = result.taskType || routedTaskType
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

    // Agent mode is for tool/code/workspace tasks. In Auto mode, simple chat,
    // greetings and image/media prompts go through the normal chat route.
    if (shouldUseAgentForText(text, routedTaskType)) {
      return sendAgentMessage(text, attachments, overrideModel)
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
          onOpenSearch={() => setSearchOpen(true)}
          onOpenCheckpoints={activeChat ? () => setCheckpointsOpen(true) : null}
          onExportChat={activeChat ? () => downloadChatMarkdown(activeChat) : null}
          totalTokens={(activeChat?.messages || []).reduce((s, m) => s + (m?.tokens?.total || 0), 0)}
          costToday={costInfo.dailyTotal}
          costCap={costInfo.cap}
        />

        <ChatSearchModal
          open={searchOpen}
          chats={chats}
          onSelectChat={selectChat}
          onClose={() => setSearchOpen(false)}
        />

        <CheckpointsTray
          open={checkpointsOpen}
          chatId={activeChat?.id || ''}
          onClose={() => setCheckpointsOpen(false)}
        />

        {hasMessages ? (
          <>
            <MessageList
              messages={messages}
              aiWorking={aiWorking}
              onEdit={handleEditMessage}
              onRegenerate={handleRegenerate}
              onRefresh={() => location.reload()}
              onJobDone={markJobDone}
              onBranch={(messageId) => activeChat && branchFromMessage(activeChat.id, messageId)}
              onAnswerAskUser={(messageId, questionId, payload) =>
                answerAgentQuestion(activeChat.id, messageId, questionId, payload)
              }
              onCancelAskUser={(messageId, questionId) =>
                cancelAgentQuestion(activeChat.id, messageId, questionId)
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
              isStreaming={aiWorking}
              onSend={handleSendMessage}
              onStop={stop}
              chatId={activeChat?.id || ''}
              {...composerSlashHooks}
            />
          </>
        ) : (
          <>
            <Composer
              hasMessages={false}
              isStreaming={aiWorking}
              onSend={handleSendMessage}
              onStop={stop}
              chatId={activeChat?.id || ''}
              {...composerSlashHooks}
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

      {/* Global flash toast — used by slash commands to give immediate feedback. */}
      {flash && (
        <div
          className={`pointer-events-none fixed inset-x-0 top-3 z-50 mx-auto flex w-fit max-w-[90vw] items-start gap-2 rounded-lg border px-3 py-2 text-[12px] shadow-2xl ${
            flash.kind === 'ok'   ? 'border-emerald-400/40 bg-emerald-900/80 text-emerald-100' :
            flash.kind === 'err'  ? 'border-red-400/40 bg-red-900/80 text-red-100' :
                                    'border-cream/20 bg-graphite-800/95 text-cream'
          }`}
          role="status"
        >
          <pre className="whitespace-pre-wrap font-mono">{flash.text}</pre>
        </div>
      )}
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
  if (pathname === '/admin/ops') {
    return (
      <AuthGate>
        {() => <OpsAdmin />}
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
