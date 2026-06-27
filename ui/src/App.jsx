import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Topbar from './components/Topbar.jsx'
import Composer from './components/Composer.jsx'
import OpenHandsWorkspace from './components/OpenHandsWorkspace.jsx'
import MessageList from './components/MessageList.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import AuthGate from './components/AuthGate.jsx'
import DeepSeekAdmin from './components/DeepSeekAdmin.jsx'
import OpsAdmin from './components/OpsAdmin.jsx'
import AgentAdmin from './components/AgentAdmin.jsx'
import OperatorPage from './components/OperatorPage.jsx'
import ChatSearchModal from './components/ChatSearchModal.jsx'
import CheckpointsTray from './components/CheckpointsTray.jsx'
import { downloadChatMarkdown } from './lib/chatExport.js'
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
import useEdgeSwipe from './lib/useEdgeSwipe.js'

function devtoolsEnabled() {
  try { return localStorage.getItem('browserai.devtools') === '1' }
  catch { return false }
}

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
    updateChat, sendMessage, sendAgentMessage, sendBackgroundAgentMessage, answerAgentQuestion,
    cancelAgentQuestion, stop,
  } = useChats(settings)

  const [costInfo, setCostInfo] = useState({ dailyTotal: 0, cap: 0 })
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 768 : false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspaceAiBusy, setWorkspaceAiBusy] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  const [flash, setFlash] = useState(null)
  const composerRef = useRef(null)
  
  // ── Gestures ──
  useEdgeSwipe({
    side: 'left',
    enabled: collapsed,
    onTrigger: () => setCollapsed(false)
  })
  
  useEdgeSwipe({
    side: 'right',
    enabled: !collapsed,
    onTrigger: () => setCollapsed(true)
  })
  
  const [agentMode, setAgentMode] = useState(() => {
    try {
      const saved = localStorage.getItem('browserai.agentMode')
      return saved === '0' ? false : true
    } catch { return true }
  })

  const isDevTools = useMemo(() => devtoolsEnabled(), [])
  const effectiveAgentMode = isDevTools ? agentMode : true

  const messages = useMemo(() => activeChat?.messages ?? [], [activeChat])
  const hasMessages = messages.length > 0
  const aiWorking = isStreaming || jobBusy || workspaceAiBusy

  const configured = isConfigured(settings)
  const activeKey = useMemo(() => getActiveKey(settings), [settings])
  const availableModels = useMemo(() => {
    const all = getAllAvailableModels(settings)
    return all.length ? all : getAvailableModels(activeKey)
  }, [settings, activeKey])
  const selectedModel = getSelectedModel(activeKey)

  useEffect(() => {
    // Cost is a devtools-only metric in the topbar. Do not poll it for normal
    // users: on weak mobile networks failed /api/cost/today requests create
    // noisy DevTools errors while the value is not shown anyway.
    if (!isDevTools || (typeof window !== 'undefined' && window.innerWidth < 768)) return undefined
    let alive = true
    async function refresh() {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const r = await fetch('/api/cost/today', { credentials: 'include', signal: controller.signal })
        if (r.ok && alive) {
          const j = await r.json()
          setCostInfo({ dailyTotal: Number(j.dailyTotal || 0), cap: Number(j.cap || 0) })
        }
      } catch { /* ignore */ }
      finally { clearTimeout(timer) }
    }
    refresh(); const id = setInterval(refresh, 60000)
    return () => { alive = false; clearInterval(id) }
  }, [isDevTools])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 6000)
    return () => clearTimeout(id)
  }, [flash])

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

  const handleSelectModel = useCallback(async (modelId) => {
    await setActiveModel(modelId)
  }, [setActiveModel])

  const handleSendMessage = useCallback(async (text, attachments = []) => {
    if (aiWorking) return
    if (effectiveAgentMode) return sendAgentMessage(text, attachments, { useWebAI: false })
    return sendMessage(text, attachments, { useWebAI: settings.useWebAI })
  }, [aiWorking, effectiveAgentMode, sendAgentMessage, sendMessage, settings.useWebAI])

  const handleSendBackground = useCallback(async (text, attachments = []) => {
    if (aiWorking) return
    const key = findKeyForModel(settings, selectedModel) || activeKey
    const override = key ? {
      baseUrl: key.baseUrl, apiKey: key.apiKey, model: selectedModel || key.model,
      authType: key.authType || 'bearer', authHeader: key.authHeader || '',
      extraHeaders: key.extraHeaders || {}, temperature: settings.temperature,
    } : null
    setFlash({ kind: 'info', text: 'Фоновый агент запущен. Результат появится в карточке job.' })
    return sendBackgroundAgentMessage(text, attachments, override)
  }, [aiWorking, settings, selectedModel, activeKey, sendBackgroundAgentMessage])

  const handleRegenerate = useCallback((m) => {
    if (aiWorking || !activeChat) return
    const curMsgs = activeChat.messages || []
    const idx = curMsgs.findIndex(x => x.id === m.id)
    if (idx === -1) return
    const updatedMessages = curMsgs.slice(0, idx)
    updateChat(activeChat.id, { messages: updatedMessages })
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
      handleSelectModel(hit.id); return true
    },
    onSlashFetchCost: async () => {
      const r = await fetch('/api/cost/today', { credentials: 'include' })
      return r.ok ? r.json() : null
    },
    onFlash: setFlash,
  }

  return (
    <div className="flex w-full overflow-hidden bg-graphite-900 text-cream" style={{ height: 'var(--app-height, 100dvh)' }}>
      <CloudSync settings={settings} chats={chats} />
      <Sidebar
        collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} onNewChat={() => { newChat(); if (window.innerWidth < 768) setCollapsed(true) }}
        chats={chats} activeId={activeId} onSelect={(id) => { selectChat(id); if (window.innerWidth < 768) setCollapsed(true) }}
        onDelete={deleteChat} onOpenSettings={() => setSettingsOpen(true)}
        agentMode={effectiveAgentMode} onToggleAgentMode={setAgentMode} devtoolsEnabled={isDevTools}
        useWebAI={settings.useWebAI} onToggleWebAI={(next) => setParams({ useWebAI: next })}
        onResumeAgentTask={() => handleSendMessage('продолжай')} onFlash={setFlash}
        onOpenJobChat={(chatId) => { if (chatId) selectChat(chatId); if (window.innerWidth < 768) setCollapsed(true) }}
      />
      {!collapsed && <button className="fixed inset-0 z-30 bg-black/45 md:hidden" onClick={() => setCollapsed(true)} />}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden" style={{ height: 'var(--app-height, 100dvh)' }}>
        <Topbar
          collapsed={collapsed} onToggleSidebar={() => setCollapsed(!collapsed)}
          title={activeChat?.title ?? 'BrowserAI'} configured={configured} aiWorking={aiWorking}
          agentMode={effectiveAgentMode}
          agentContext={[...messages].reverse().find(m => m?.agentContext)?.agentContext || null}
          workspaceOpen={workspaceOpen} onToggleWorkspace={() => setWorkspaceOpen(!workspaceOpen)}
          onOpenSettings={() => setSettingsOpen(true)} user={user} onLogout={async () => { await backend.saveCloud({ settings, chats }); await backend.authLogout(); localStorage.removeItem('browserai.auth.enabled'); await reloadAuth?.() }}
          availableModels={availableModels} selectedModel={selectedModel} onSelectModel={handleSelectModel}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenCheckpoints={activeChat ? () => setCheckpointsOpen(true) : null} onExportChat={activeChat ? () => downloadChatMarkdown(activeChat) : null}
          totalTokens={messages.reduce((s, m) => s + (m?.tokens?.total || 0), 0)} costToday={costInfo.dailyTotal} costCap={costInfo.cap}
          devtoolsEnabled={isDevTools}
        />
        <ChatSearchModal open={searchOpen} chats={chats} onSelectChat={selectChat} onClose={() => setSearchOpen(false)} />
        <CheckpointsTray open={checkpointsOpen} chatId={activeChat?.id || ''} onClose={() => setCheckpointsOpen(false)} />
        <div className="flex flex-col h-full overflow-hidden">
        {hasMessages ? (
          <>
            <div className="flex flex-1 min-h-0 flex-col">
            <MessageList
              key={activeChat?.id || 'empty'}
              messages={messages} chatId={activeChat?.id || ''} aiWorking={aiWorking} onEdit={(m) => composerRef.current?.setDraft(m.content || '')}
              onRegenerate={handleRegenerate} onResumeRun={() => handleSendMessage('продолжай с того места, где остановился. Не начинай заново: используй уже созданные файлы, историю tool-вызовов и продолжи незавершённые проверки.')} onOpenSettings={() => setSettingsOpen(true)} onRefresh={() => location.reload()} onJobDone={markJobDone} onBranch={(messageId) => activeChat && branchFromMessage(activeChat.id, messageId)}
              onAnswerAskUser={(messageId, questionId, payload) => answerAgentQuestion(activeChat.id, messageId, questionId, payload)}
              onCancelAskUser={(messageId, questionId) => cancelAgentQuestion(activeChat.id, messageId, questionId)}
            />
            </div>
            <div className="shrink-0">
            <Composer ref={composerRef} hasMessages isStreaming={aiWorking} onSend={handleSendMessage} onSendBackground={handleSendBackground} onStop={stop} chatId={activeChat?.id || ''} {...composerSlashHooks} />
            </div>
          </>
        ) : (
          <Composer ref={composerRef} hasMessages={false} isStreaming={aiWorking} onSend={handleSendMessage} onSendBackground={handleSendBackground} onStop={stop} chatId={activeChat?.id || ''} {...composerSlashHooks} />
        )}
        </div>
      </main>
      <OpenHandsWorkspace
        activeChat={activeChat}
        isOpen={workspaceOpen}
        onToggle={() => setWorkspaceOpen(false)}
        files={(() => {
          const fl = []
          for (const m of messages) {
            for (const tc of m.toolCalls || []) {
              if (tc.name === 'write_file' || tc.name === 'edit_file' || tc.name === 'read_file') {
                const p = tc.args?.path || tc.args?.file || tc.result?.path
                if (p && !fl.find((f) => f.path === p)) fl.push({ path: p, content: tc.args?.content || tc.result?.content || '', size: tc.args?.content?.length || 1024 })
              }
            }
          }
          return fl
        })()}
        terminalLogs={(() => {
          const lg = []
          for (const m of messages) {
            for (const tc of m.toolCalls || []) {
              if (tc.name === 'bash' || tc.name === 'cmd') {
                lg.push(`$ ${tc.args?.command || tc.args?.cmd}`)
                if (tc.result) lg.push(String(tc.result))
              }
            }
          }
          return lg
        })()}
        browserScreenshot={messages.slice(-1)[0]?.toolCalls?.slice(-1)[0]?.result?.screenshot || null}
        onDownloadZip={() => window.open(`/api/conversations/${activeChat?.id || 'default'}/zip-directory`)}
      />
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
  // Package J: Operator Console — dedicated routes
  if (pathname === '/operator' || pathname.startsWith('/operator/')) return <AuthGate>{() => <OperatorPage tab={pathname.replace('/operator', '').replace(/^\//, '') || 'missions'} />}</AuthGate>
  return <AuthGate>{({ user, reloadAuth, renderKey }) => <BrowserApp key={renderKey} user={user} reloadAuth={reloadAuth} />}</AuthGate>
}
