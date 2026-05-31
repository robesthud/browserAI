// ============================================
// AI CODE STUDIO - HEADER
// ============================================

import { useState } from 'react';
import {
  MessageSquare,
  Rocket,
  Globe,
  Terminal,
  Settings,
  User,
  LogOut,
  ChevronDown,
  Sparkles,
  Zap,
  Plus,
  FolderOpen,
  PanelLeftClose,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  GitBranch,
} from 'lucide-react';
import { useAuthStore, useUIStore, useProjectStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { DEMO_PROJECT } from '../../services/mockBackend';
import { SettingsModal } from '../Settings/SettingsModal';
import { cn } from '../../utils/cn';

export function Header() {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  const { user, isAuthenticated, login, logout } = useAuthStore();
  const { 
    isSidebarOpen, 
    isRightPanelOpen, 
    isBottomPanelOpen,
    toggleSidebar, 
    toggleRightPanel, 
    toggleBottomPanel,
    activeRightPanel,
    setActiveRightPanel,
  } = useUIStore();
  const { currentProject, setCurrentProject } = useProjectStore();
  const { provider, model } = useSettingsStore();

  // Demo login
  const handleLogin = () => {
    login('demo-token', {
      id: 'demo-user-1',
      email: 'demo@example.com',
      name: 'Demo User',
      avatar: undefined,
      createdAt: new Date().toISOString(),
    });
    setCurrentProject(DEMO_PROJECT);
  };

  return (
    <header className="h-12 bg-gray-900 border-b border-gray-700 flex items-center justify-between px-4">
      {/* Left Section */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <span className="font-semibold text-lg hidden sm:block">AI Code Studio</span>
        </div>

        {/* Project Selector */}
        <div className="relative">
          <button
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            onClick={() => setShowProjectMenu(!showProjectMenu)}
          >
            <FolderOpen className="w-4 h-4 text-gray-400" />
            <span className="text-sm">{currentProject?.name || 'Select Project'}</span>
            <ChevronDown className="w-4 h-4 text-gray-400" />
          </button>

          {showProjectMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowProjectMenu(false)}
              />
              <div className="absolute left-0 top-full mt-2 z-20 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1">
                <div className="px-3 py-2 border-b border-gray-700">
                  <span className="text-xs text-gray-500 uppercase">Recent Projects</span>
                </div>
                <button
                  className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-700 transition-colors"
                  onClick={() => {
                    setCurrentProject(DEMO_PROJECT);
                    setShowProjectMenu(false);
                  }}
                >
                  <FolderOpen className="w-4 h-4 text-indigo-400" />
                  <span className="text-sm">my-awesome-app</span>
                </button>
                <div className="border-t border-gray-700 mt-1 pt-1">
                  <button className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-700 transition-colors text-indigo-400">
                    <Plus className="w-4 h-4" />
                    <span className="text-sm">New Project</span>
                  </button>
                  <button className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-700 transition-colors">
                    <GitBranch className="w-4 h-4" />
                    <span className="text-sm">Clone from Git</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Center Section - Panel Toggles */}
      <div className="flex items-center gap-1">
        <button
          className={cn(
            'p-2 rounded-lg transition-colors',
            isSidebarOpen ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white hover:bg-gray-800'
          )}
          onClick={toggleSidebar}
          title="Toggle Sidebar"
        >
          {isSidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
        </button>
        
        <button
          className={cn(
            'p-2 rounded-lg transition-colors',
            isBottomPanelOpen ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white hover:bg-gray-800'
          )}
          onClick={toggleBottomPanel}
          title="Toggle Terminal"
        >
          <Terminal className="w-4 h-4" />
        </button>

        <div className="w-px h-6 bg-gray-700 mx-2" />

        <button
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors',
            activeRightPanel === 'chat' && isRightPanelOpen
              ? 'bg-indigo-600 text-white'
              : 'text-gray-500 hover:text-white hover:bg-gray-800'
          )}
          onClick={() => setActiveRightPanel('chat')}
          title="AI Chat"
        >
          <MessageSquare className="w-4 h-4" />
          <span className="text-sm hidden sm:block">Chat</span>
        </button>

        <button
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors',
            activeRightPanel === 'agent' && isRightPanelOpen
              ? 'bg-purple-600 text-white'
              : 'text-gray-500 hover:text-white hover:bg-gray-800'
          )}
          onClick={() => setActiveRightPanel('agent')}
          title="AI Agent"
        >
          <Rocket className="w-4 h-4" />
          <span className="text-sm hidden sm:block">Agent</span>
        </button>

        <button
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors',
            activeRightPanel === 'browser' && isRightPanelOpen
              ? 'bg-blue-600 text-white'
              : 'text-gray-500 hover:text-white hover:bg-gray-800'
          )}
          onClick={() => setActiveRightPanel('browser')}
          title="Browser AI"
        >
          <Globe className="w-4 h-4" />
          <span className="text-sm hidden sm:block">Browser</span>
        </button>

        <button
          className={cn(
            'p-2 rounded-lg transition-colors',
            isRightPanelOpen ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white hover:bg-gray-800'
          )}
          onClick={toggleRightPanel}
          title="Toggle Right Panel"
        >
          {isRightPanelOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
        </button>
      </div>

      {/* Right Section */}
      <div className="flex items-center gap-3">
        {/* AI Status */}
        <button
          className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          onClick={() => setShowSettings(true)}
        >
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span className="text-xs text-gray-400">{model || provider}</span>
          <div className="w-2 h-2 rounded-full bg-green-500" />
        </button>

        {/* Settings Button */}
        <button
          className="p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* User Menu */}
        {isAuthenticated ? (
          <div className="relative">
            <button
              className="flex items-center gap-2 p-1.5 hover:bg-gray-800 rounded-lg transition-colors"
              onClick={() => setShowUserMenu(!showUserMenu)}
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                <span className="text-xs font-medium">{user?.name?.[0] || 'U'}</span>
              </div>
            </button>

            {showUserMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowUserMenu(false)}
                />
                <div className="absolute right-0 top-full mt-2 z-20 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1">
                  <div className="px-4 py-3 border-b border-gray-700">
                    <div className="font-medium">{user?.name}</div>
                    <div className="text-sm text-gray-500">{user?.email}</div>
                  </div>
                  <button className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-700 transition-colors">
                    <User className="w-4 h-4" />
                    <span className="text-sm">Profile</span>
                  </button>
                  <button 
                    className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-700 transition-colors"
                    onClick={() => {
                      setShowSettings(true);
                      setShowUserMenu(false);
                    }}
                  >
                    <Settings className="w-4 h-4" />
                    <span className="text-sm">Settings</span>
                  </button>
                  <div className="border-t border-gray-700 mt-1 pt-1">
                    <button
                      className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-700 transition-colors text-red-400"
                      onClick={() => {
                        logout();
                        setShowUserMenu(false);
                      }}
                    >
                      <LogOut className="w-4 h-4" />
                      <span className="text-sm">Sign Out</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <button
            className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors text-sm"
            onClick={handleLogin}
          >
            <User className="w-4 h-4" />
            <span>Sign In</span>
          </button>
        )}
      </div>

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </header>
  );
}
