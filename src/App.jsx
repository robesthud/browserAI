import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Topbar from './components/Topbar.jsx'
import Composer from './components/Composer.jsx'
import Workspace from './components/Workspace.jsx'
import MessageList from './components/MessageList.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import AuthGate from './components/AuthGate.jsx'
import DeepSeekAdmin from './components/DeepSeekAdmin.jsx'
import OpsAdmin from './components/OpsAdmin.jsx'
import AgentAdmin from './components/AgentAdmin.jsx'
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
    workspaceRevision,
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

  // -- Derived state (defined BEFORE hooks that might use them) --
  const messages = activeChat?.messages ?? []
  const hasMessages = messages.length > 0
  const aiWorking = isStreaming || jobBusy // workspaceAiBusy removed if not defined elsewhere

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

  // Unified "AI is busy" flag
  const isBusy = aiWorking || workspaceAiBusy

  // Auto-dismiss flash after 6s.
  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 6000)
    return () => clearTimeout(id)
  }, [flash])

  const devtoolsEnabled = (() => {
    try { return localStorage.getItem('browserai.devtools') === '1' }
    catch { return false }
  })()

  const [agentMode, setAgentMode] = useState(() => {
    try {
      const saved = localStorage.getItem('browserai.agentMode')
      if (saved === '1') return true
      if (saved === '0') return false
      return true
    } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('browserai.agentMode', agentMode ? '1' : '0') } catch { }
  }, [agentMode])
  const effectiveAgentMode = devtoolsEnabled ? agentMode : true

  // Slash-command hook bundle passed to Composer.
  const composerSlashHooks = {
    onSlashClear: () => { newChat() },
    onSlashSettings: () => setSettingsOpen(true),
    onSlashSearch: () => setSearchOpen(true),
    onSlashCheckpoints: () => setCheckpointsOpen(true),
    onSlashExport: () => { if (activeChat) downloadChatMarkdown(activeChat) },
    onSlashToggleAgent: (forceOn) => {
      if (!activeChat) return
      const cur = activeChat.agentMode !== false
      const next = forceOn == null ? !cur : Boolean(forceOn)
      updateChat(activeChat.id, { agentMode: next })
      setFlash({ kind: 'info', text: `Agent Mode: ${next ? 'включён' : 'выключен'}` })
    },
    onSlashSetModel: (modelId) => {
      const all = getAllAvailableModels(settings)
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

  const [autoMode, setAutoMode] = useState(() => {
    try { return localStorage.getItem('browserai.autoMode') === '1' } catch { return false }
  })
  const [autoHint, setAutoHint] = useState(null)
  useEffect(() => {
    try { localStorage.setItem('browserai.autoMode', autoMode ? '1' : '0') } catch { }
  }, [autoMode])

  useEffect(() => {
    const onKey = (e) => {
      const isCmd = e.metaKey || e.ctrlKey
      if (!isCmd || e.key.toLowerCase() !== 'k') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return
      e.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const closeSidebarOnMobile = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setCollapsed(true)
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
    const ta = document.querySelector('textarea')
    if (ta) {
      ta.value = m.content
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
      ta.focus()
    }
  }

  const configured = isConfigured(settings)
  const activeKey = useMemo(() => getActiveKey(settings), [settings])
  const availableModels = useMemo(() => {
    const all = getAllAvailableModels(settings)
    return all.length ? all : getAvailableModels(activeKey)
  }, [settings, activeKey])
  const selectedModel = getSelectedModel(activeKey)

  const providerOverrideForModel = useCallback((model) => {
    const key = findKeyForModel(settings, model)
    if (!key) return null
    return {
      baseUrl: key.baseUrl, apiKey: key.apiKey, model,
      authType: key.authType || 'bearer', authHeader: key.authHeader || '',
      responsePath: key.responsePath || '', extraHeaders: key.extraHeaders || {},
      systemPrompt: settings.systemPrompt, temperature: settings.temperature,
      stream: settings.stream, useWebAI: settings.useWebAI,
    }
  }, [settings])

  const shouldUseAgentForText = useCallback(() => {
    if (!effectiveAgentMode) return false
    return true
  }, [effectiveAgentMode])

  const handleSendMessage = useCallback(async (text, attachments = []) => {
    if (isBusy) return
    let overrideModel = null
    let routedTaskType = getTaskType(text || '')

    if (autoMode && availableModels.length > 1 && text?.trim()) {
      const result = pickBestModel(text, availableModels, selectedModel)
      routedTaskType = result.taskType || routedTaskType
      if (result.changed) {
        overrideModel = providerOverrideForModel(result.model) || result.model
        setActiveModel(result.model).catch(() => {})
        setAutoHint({ reason: result.reason, taskType: result.taskType, icon: result.icon })
        setTimeout(() => setAutoHint(null), 5000)
      } else {
        setAutoHint(null)
      }
    }

    if (shouldUseAgentForText()) {
      return sendAgentMessage(text, attachments, overrideModel)
    }
    return sendMessage(text, attachments, overrideModel)
  }, [isBusy, autoMode, availableModels, selectedModel, providerOverrideForModel, shouldUseAgentForText, sendAgentMessage, sendMessage, setActiveModel])

  const handleRegenerate = useCallback((m) => {
    if (isBusy || !activeChat) return
    const currentMessages = activeChat.messages || []
    const idx = currentMessages.findIndex(x => x.id === m.id)
    if (idx === -1) return
    const updatedMessages = currentMessages.slice(0, idx)
    updateChat(activeChat.id, { messages: updatedMessages })
    
    const lastUserMsg = updatedMessages.reverse().find(x => x.role === 'user')
    if (lastUserMsg) {
      handleSendMessage(lastUserMsg.content, lastUserMsg.attachments)
    }
  }, [isBusy, activeChat, updateChat, handleSendMessage])

  // v2.17: Retry failed tool (Arena parity)
  useEffect(() => {
    const handler = (e) => {
      const { name, args } = e.detail || {}
      if (!name || !activeChat || isBusy) return
      const retryText = `[RETRY_TOOL] Повтори tool "${name}" с аргументами: ${JSON.stringify(args)}`
      handleSendMessage(retryText).catch(() => {})
    }
    window.addEventListener('agent:retry-tool', handler)
    return () => window.removeEventListener('agent:retry-tool', handler)
  }, [activeChat, handleSendMessage, isBusy])

  useEffect(() => { setAutoHint(null) }, [activeId])

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
        agentMode={effectiveAgentMode}
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
          aiWorking={isBusy}
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
          onToggleAuto={() => { setAutoMode(v => !v); setAutoHint(null) }}
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
              aiWorking={isBusy}
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
            <Composer
              hasMessages
              isStreaming={isBusy}
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
              isStreaming={isBusy}
              onSend={handleSendMessage}
              onStop={stop}
              chatId={activeChat?.id || ''}
              {...composerSlashHooks}
            />
          </>
        )}
      </main>

      <Workspace
        revision={workspaceRevision}
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
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (pathname === '/admin/deepseek') return <AuthGate>{() => <DeepSeekAdmin />}</AuthGate>
  if (pathname === '/admin/ops') return <AuthGate>{() => <OpsAdmin />}</AuthGate>
  if (pathname === '/admin/agent') return <AuthGate>{() => <AgentAdmin />}</AuthGate>
  return (
    <AuthGate>
      {({ user, reloadAuth, renderKey }) => (
        <BrowserApp key={renderKey} user={user} reloadAuth={reloadAuth} />
      )}
    </AuthGate>
  )
}
