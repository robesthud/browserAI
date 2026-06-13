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
import { pickBestModel } from './lib/autoModel.js'
import { routeUserMessage } from './lib/smartRouter.js'

function CloudSync({ settings, chats }) {
  const firstRun = useRef(true)
  const isLoggedIn = typeof localStorage !== 'undefined' && localStorage.getItem('browserai.auth.enabled') === '1'
  const hasPending = chats.some((chat) => chat.messages.some((m) => m.pending === true))

  useEffect(() => {
    if (!isLoggedIn || firstRun.current || hasPending) {
      if (isLoggedIn) firstRun.current = false
      return undefined
    }
    const timer = setTimeout(() => {
      const settingsToSave = {
        systemPrompt: settings.systemPrompt,
        temperature: settings.temperature,
        stream: settings.stream,
        useWebAI: settings.useWebAI,
        activeKeyId: settings.activeKeyId,
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
    settings, online, vault, saveKey, deleteKey, activateKey,
    setActiveModel, setParams, importKeys, validateKey,
    vaultSetup, vaultUnlock, vaultLock, vaultChange, vaultDisable,
    vaultAutolock, vaultBackup, vaultRestore,
  } = useSettings()

  const {
    chats, activeChat, workspaceRevision, activeId, isStreaming, jobBusy,
    markJobDone, newChat, selectChat, deleteChat, branchFromMessage,
    updateChat, sendMessage, sendAgentMessage, answerAgentQuestion,
    cancelAgentQuestion, stop,
  } = useChats(settings)

  // 1. Declare ALL State hooks first
  const [costInfo, setCostInfo] = useState({ dailyTotal: 0, cap: 0 })
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 768 : false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspaceAiBusy, setWorkspaceAiBusy] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  const [flash, setFlash] = useState(null)
  const [autoMode, setAutoMode] = useState(() => {
    try {
      const saved = localStorage.getItem('browserai.autoMode')
      // Default ON: Auto is now the cost-saving smart router, not just model-pick.
      return saved == null ? true : saved === '1'
    } catch { return true }
  })
  const [autoHint, setAutoHint] = useState(null)
  const [agentMode, setAgentMode] = useState(() => {
    try {
      const saved = localStorage.getItem('browserai.agentMode')
      return saved === '0' ? false : true
    } catch { return true }
  })

  // Manual Agent mode is available to all users. Auto mode routes each turn
  // to chat/web/agent automatically. Manual mode is a developer override
  // that forces agent routing for every message.
  const effectiveAgentMode = agentMode

  // 2. Derived variables
  const messages = useMemo(() => activeChat?.messages ?? [], [activeChat])
  const hasMessages = messages.length > 0
  const aiWorking = isStreaming || jobBusy || workspaceAiBusy

  // 3. Memoized values for settings
  const configured = isConfigured(settings)
  const activeKey = useMemo(() => getActiveKey(settings), [settings])
  const availableModels = useMemo(() => {
    const all = getAllAvailableModels(settings)
    return all.length ? all : getAvailableModels(activeKey)
  }, [settings, activeKey])
  const selectedModel = getSelectedModel(activeKey)

  // 4. Effects
  useEffect(() => {
    let alive = true
    async function refresh() {
      try {
        const r = await fetch('/api/cost/today', { credentials: 'include' })
        if (r.ok && alive) {
          const j = await r.json()
          setCostInfo({ dailyTotal: Number(j.dailyTotal || 0), cap: Number(j.cap || 0) })
        }
      } catch { /* ignore */ }
    }
    refresh(); const id = setInterval(refresh, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 6000)
    return () => clearTimeout(id)
  }, [flash])

  useEffect(() => {
    try { localStorage.setItem('browserai.autoMode', autoMode ? '1' : '0') } catch { /* ignore */ }
  }, [autoMode])

  useEffect(() => {
    try { localStorage.setItem('browserai.agentMode', agentMode ? '1' : '0') } catch { /* ignore */ }
  }, [agentMode])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const tag = (document.activeElement?.tagName || '').toLowerCase()
        if (tag !== 'input' && tag !== 'textarea' && !document.activeElement?.isContentEditable) {
          e.preventDefault(); setSearchOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 5. Callbacks
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

  const handleSendMessage = useCallback(async (text, attachments = []) => {
    if (aiWorking) return
    let overrideModel = null
    let modelHint = null

    if (autoMode && availableModels.length > 1 && text?.trim()) {
      const result = pickBestModel(text, availableModels, selectedModel)
      if (result.changed) {
        overrideModel = providerOverrideForModel(result.model) || { model: result.model }
        setActiveModel(result.model).catch(() => {})
        modelHint = { reason: result.reason, taskType: result.taskType, icon: result.icon }
      }
    }

    // Manual agent toggle takes priority over autoMode/smartRouter
    const route = effectiveAgentMode
      ? { mode: 'agent', reason: 'Агент включён вручную', icon: '🤖' }
      : autoMode
        ? routeUserMessage(text, attachments)
        : { mode: 'chat', reason: 'Обычный чат', icon: '💬' }

    const mergeOverride = (extra = {}) => {
      if (overrideModel && typeof overrideModel === 'object') return { ...overrideModel, ...extra }
      if (typeof overrideModel === 'string') return { model: overrideModel, ...extra }
      return extra
    }

    setAutoHint(autoMode
      ? { reason: `${route.reason}${modelHint?.reason ? ' · ' + modelHint.reason : ''}`, taskType: route.mode, icon: route.icon }
      : modelHint)
    if (autoMode || modelHint) setTimeout(() => setAutoHint(null), 5000)

    if (route.mode === 'agent') return sendAgentMessage(text, attachments, mergeOverride({ useWebAI: false }))
    if (route.mode === 'web') return sendMessage(text, attachments, mergeOverride({ useWebAI: true }))
    return sendMessage(text, attachments, mergeOverride({ useWebAI: false }))
  }, [aiWorking, autoMode, availableModels, selectedModel, providerOverrideForModel, effectiveAgentMode, sendAgentMessage, sendMessage, setActiveModel])

  const handleRegenerate = useCallback((m) => {
    if (aiWorking || !activeChat) return
    const curMsgs = activeChat.messages || []
    const idx = curMsgs.findIndex(x => x.id === m.id)
    if (idx === -1) return
    const updatedMessages = curMsgs.slice(0, idx)
    updateChat(activeChat.id, { messages: updatedMessages })
    // NB: [...spread] — .reverse() in place would mutate the same array we just
    // stored in state, leaving the restored chat history in reversed order.
    const lastUserMsg = [...updatedMessages].reverse().find(x => x.role === 'user')
    if (lastUserMsg) handleSendMessage(lastUserMsg.content, lastUserMsg.attachments)
  }, [aiWorking, activeChat, updateChat, handleSendMessage])

  useEffect(() => {
    const handler = (e) => {
      const { name, args } = e.detail || {}
      if (!name || !activeChat || aiWorking) return
      handleSendMessage(`[RETRY_TOOL] Повтори tool "${name}" с аргументами: ${JSON.stringify(args)}`)
    }
    window.addEventListener('agent:retry-tool', handler); return () => window.removeEventListener('agent:retry-tool', handler)
  }, [activeChat, handleSendMessage, aiWorking])

  useEffect(() => { setAutoHint(null) }, [activeId])

  const composerSlashHooks = {
    onSlashClear: () => newChat(),
    onSlashSettings: () => setSettingsOpen(true),
    onSlashSearch: () => setSearchOpen(true),
    onSlashCheckpoints: () => setCheckpointsOpen(true),
    onSlashExport: () => activeChat && downloadChatMarkdown(activeChat),
    onSlashToggleAgent: (forceOn) => {
      if (!activeChat) return
      const next = forceOn == null ? !activeChat.agentMode : Boolean(forceOn)
      updateChat(activeChat.id, { agentMode: next })
      setFlash({ kind: 'info', text: `Agent Mode: ${next ? 'включён' : 'выключен'}` })
    },
    onSlashSetModel: (modelId) => {
      const hit = availableModels.find((m) => m.id === modelId || m.name === modelId || (m.id || '').endsWith(modelId))
      if (!hit) return false
      setActiveModel?.(hit.id); return true
    },
    onSlashFetchCost: async () => {
      const r = await fetch('/api/cost/today', { credentials: 'include' })
      return r.ok ? r.json() : null
    },
    onFlash: setFlash,
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-graphite-900 text-cream">
      <CloudSync settings={settings} chats={chats} />
      <Sidebar
        collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} onNewChat={() => { newChat(); if (window.innerWidth < 768) setCollapsed(true) }}
        chats={chats} activeId={activeId} onSelect={(id) => { selectChat(id); if (window.innerWidth < 768) setCollapsed(true) }}
        onDelete={deleteChat} onOpenSettings={() => setSettingsOpen(true)}
        agentMode={effectiveAgentMode} onToggleAgentMode={setAgentMode}
        useWebAI={settings.useWebAI} onToggleWebAI={(next) => setParams({ useWebAI: next })}
      />
      {!collapsed && <button className="fixed inset-0 z-30 bg-black/45 md:hidden" onClick={() => setCollapsed(true)} />}
      <main className="relative flex min-w-0 flex-1 flex-col h-[100dvh] overflow-hidden">
        {collapsed && (
          <button onClick={() => setCollapsed(false)} className="absolute left-3 top-10 z-10 grid h-9 w-9 place-items-center rounded-lg text-cream-dim hover:bg-graphite-800 md:top-3.5">
            <IconExpand />
          </button>
        )}
        <Topbar
          title={activeChat?.title ?? 'BrowserAI'} configured={configured} aiWorking={aiWorking}
          autoMode={autoMode} autoModelHint={autoHint ? `${autoHint.icon || ''} ${autoHint.reason}` : ''}
          agentMode={agentMode} workspaceOpen={workspaceOpen} onToggleWorkspace={() => setWorkspaceOpen(!workspaceOpen)}
          onOpenSettings={() => setSettingsOpen(true)} user={user} onLogout={async () => { await backend.saveCloud({ settings, chats }); await backend.authLogout(); localStorage.removeItem('browserai.auth.enabled'); await reloadAuth?.() }}
          availableModels={availableModels} selectedModel={selectedModel} onSelectModel={setActiveModel}
          onToggleAuto={() => { setAutoMode(!autoMode); setAutoHint(null) }} onOpenSearch={() => setSearchOpen(true)}
          onOpenCheckpoints={activeChat ? () => setCheckpointsOpen(true) : null} onExportChat={activeChat ? () => downloadChatMarkdown(activeChat) : null}
          totalTokens={messages.reduce((s, m) => s + (m?.tokens?.total || 0), 0)} costToday={costInfo.dailyTotal} costCap={costInfo.cap}
        />
        <ChatSearchModal open={searchOpen} chats={chats} onSelectChat={selectChat} onClose={() => setSearchOpen(false)} />
        <CheckpointsTray open={checkpointsOpen} chatId={activeChat?.id || ''} onClose={() => setCheckpointsOpen(false)} />
        <div className="flex flex-col h-full overflow-hidden">
        {hasMessages ? (
          <>
            <div className="flex-1 overflow-y-auto min-h-0" style={{ overscrollBehaviorY: "contain" }}>
            <MessageList
              messages={messages} aiWorking={aiWorking} onEdit={(m) => { const ta = document.querySelector('textarea'); if (ta) { ta.value = m.content; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; ta.focus() } }}
              onRegenerate={handleRegenerate} onRefresh={() => location.reload()} onJobDone={markJobDone} onBranch={(messageId) => activeChat && branchFromMessage(activeChat.id, messageId)}
              onAnswerAskUser={(messageId, questionId, payload) => answerAgentQuestion(activeChat.id, messageId, questionId, payload)}
              onCancelAskUser={(messageId, questionId) => cancelAgentQuestion(activeChat.id, messageId, questionId)}
            />
            </div>
            <div className="shrink-0">
            <Composer hasMessages isStreaming={aiWorking} onSend={handleSendMessage} onStop={stop} chatId={activeChat?.id || ''} {...composerSlashHooks} />
            </div>
          </>
        ) : (
          <Composer hasMessages={false} isStreaming={aiWorking} onSend={handleSendMessage} onStop={stop} chatId={activeChat?.id || ''} {...composerSlashHooks} />
        )}
        </div>
      </main>
      <Workspace revision={workspaceRevision} open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} settings={settings} chatId={activeId || ''} onSendToChat={handleSendMessage} onAiBusyChange={setWorkspaceAiBusy} />
      <SettingsModal
        key={settingsOpen ? 'open' : 'closed'} open={settingsOpen} settings={settings} online={online} vault={vault}
        onSaveKey={saveKey} onDeleteKey={deleteKey} onActivateKey={activateKey} onSetParams={setParams} onImportKeys={importKeys} onValidateKey={validateKey}
        onVaultSetup={vaultSetup} onVaultUnlock={vaultUnlock} onVaultLock={vaultLock} onVaultChange={vaultChange} onVaultDisable={vaultDisable} onVaultAutolock={vaultAutolock} onVaultBackup={vaultBackup} onVaultRestore={vaultRestore} onClose={() => setSettingsOpen(false)}
      />
      {flash && (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-50 mx-auto flex w-fit max-w-[90vw] items-start gap-2 rounded-lg border px-3 py-2 text-[12px] shadow-2xl border-cream/20 bg-graphite-800/95 text-cream" role="status">
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
  return <AuthGate>{({ user, reloadAuth, renderKey }) => <BrowserApp key={renderKey} user={user} reloadAuth={reloadAuth} />}</AuthGate>
}
