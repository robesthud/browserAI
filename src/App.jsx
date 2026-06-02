import { useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Topbar from './components/Topbar.jsx'
import Composer from './components/Composer.jsx'
import Workspace from './components/Workspace.jsx'
import MessageList from './components/MessageList.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import AuthGate from './components/AuthGate.jsx'
import { IconExpand } from './icons.jsx'
import {
  getActiveKey,
  getAvailableModels,
  getSelectedModel,
  isConfigured,
} from './lib/settings.js'
import { useSettings } from './lib/useSettings.js'
import { useChats } from './lib/useChats.js'
import { backend } from './lib/backend.js'

function CloudSync({ settings, chats }) {
  const firstRun = useRef(true)

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return undefined
    }
    const timer = setTimeout(() => {
      void backend.saveCloud({ settings, chats }).catch(() => {})
    }, 700)
    return () => clearTimeout(timer)
  }, [settings, chats])

  return null
}

function BrowserApp({ user, reloadAuth }) {
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  )
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspaceAiBusy, setWorkspaceAiBusy] = useState(false)

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
    sendMessage,
    stop,
  } = useChats(settings)

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
  const toggleWorkspace = () => setWorkspaceOpen((v) => !v)
  const logout = async () => {
    await backend.saveCloud({ settings, chats }).catch(() => {})
    await backend.authLogout().catch(() => {})
    localStorage.removeItem('browserai.auth.enabled')
    await reloadAuth?.()
  }

  const configured = isConfigured(settings)
  const activeKey = useMemo(() => getActiveKey(settings), [settings])
  const availableModels = useMemo(() => getAvailableModels(activeKey), [activeKey])
  const selectedModel = getSelectedModel(activeKey)
  const messages = activeChat?.messages ?? []
  const hasMessages = messages.length > 0

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
            className="absolute left-3 top-3.5 z-10 grid h-9 w-9 place-items-center rounded-lg
                       text-cream-dim transition-colors hover:bg-graphite-800 hover:text-cream"
            title="Развернуть панель"
          >
            <IconExpand />
          </button>
        )}

        <Topbar
          title={activeChat?.title ?? 'BrowserAI'}
          configured={configured}
          aiWorking={isStreaming || workspaceAiBusy}
          useWebAI={settings.useWebAI}
          onToggleWebAI={(next) => setParams({ useWebAI: next })}
          models={availableModels}
          selectedModel={selectedModel}
          onSelectModel={setActiveModel}
          workspaceOpen={workspaceOpen}
          onToggleWorkspace={toggleWorkspace}
          onOpenSettings={() => setSettingsOpen(true)}
          user={user}
          onLogout={logout}
        />

        {hasMessages ? (
          <>
            <MessageList messages={messages} />
            <Composer
              hasMessages
              isStreaming={isStreaming}
              onSend={sendMessage}
              onStop={stop}
            />
          </>
        ) : (
          <Composer
            hasMessages={false}
            isStreaming={isStreaming}
            onSend={sendMessage}
            onStop={stop}
          />
        )}
      </main>

      <Workspace
        open={workspaceOpen}
        onClose={toggleWorkspace}
        settings={settings}
        onSendToChat={sendMessage}
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
  return (
    <AuthGate>
      {({ user, reloadAuth, renderKey }) => (
        <BrowserApp key={renderKey} user={user} reloadAuth={reloadAuth} />
      )}
    </AuthGate>
  )
}
