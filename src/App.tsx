// ============================================
// AI CODE STUDIO - MAIN APPLICATION
// Full-Stack IDE with AI, Browser Automation, and Collaboration
// ============================================

import { useEffect, useState } from 'react';
import { Header } from './components/Header/Header';
import { Sidebar } from './components/Sidebar/Sidebar';
import { EditorPanel } from './components/Editor/EditorPanel';
import { ChatPanel } from './components/Chat/ChatPanel';
import { AgentPanel } from './components/Agent/AgentPanel';
import { BrowserPanel } from './components/Browser/BrowserPanel';
import { TerminalPanel } from './components/Terminal/Terminal';
import { WelcomeModal } from './components/Welcome/WelcomeModal';
import { useUIStore, useProjectStore, useAuthStore, useGitStore, useEditorStore } from './stores/useStore';
import { useSettingsStore } from './stores/settingsStore';
import { projectsAPI } from './services/api';
import { DEMO_PROJECT, DEMO_FILES, DEMO_COMMITS } from './services/mockBackend';
import { cn } from './utils/cn';

export default function App() {
  const [showWelcome, setShowWelcome] = useState(() => {
    return !localStorage.getItem('welcomeShown');
  });

  const {
    isRightPanelOpen,
    isBottomPanelOpen,
    activeRightPanel,
    rightPanelWidth,
    bottomPanelHeight,
  } = useUIStore();

  const { setCurrentProject, setFiles } = useProjectStore();
  const { login } = useAuthStore();
  const { setCommits, setBranches } = useGitStore();

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle Sidebar: Ctrl+B or Cmd+B
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        const { toggleSidebar } = useUIStore.getState();
        toggleSidebar();
      }
      
      // Toggle Terminal/Bottom panel: Ctrl+J or Ctrl+`
      if ((e.ctrlKey || e.metaKey) && (e.key === 'j' || e.key === '`')) {
        e.preventDefault();
        const { toggleBottomPanel } = useUIStore.getState();
        toggleBottomPanel();
      }

      // Switch to Chat Panel: Ctrl+Shift+C
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        const { setActiveRightPanel, toggleRightPanel, isRightPanelOpen, activeRightPanel } = useUIStore.getState();
        if (activeRightPanel === 'chat' && isRightPanelOpen) {
          toggleRightPanel();
        } else {
          setActiveRightPanel('chat');
        }
      }

      // Switch to Agent Panel: Ctrl+Shift+A
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const { setActiveRightPanel, toggleRightPanel, isRightPanelOpen, activeRightPanel } = useUIStore.getState();
        if (activeRightPanel === 'agent' && isRightPanelOpen) {
          toggleRightPanel();
        } else {
          setActiveRightPanel('agent');
        }
      }

      // Switch to Browser Panel: Ctrl+Shift+B (needs to check key precisely)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const { setActiveRightPanel, toggleRightPanel, isRightPanelOpen, activeRightPanel } = useUIStore.getState();
        if (activeRightPanel === 'browser' && isRightPanelOpen) {
          toggleRightPanel();
        } else {
          setActiveRightPanel('browser');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const { demoMode } = useSettingsStore();
  const { setCollabUsers } = useEditorStore();

  // Initialize data based on demoMode
  useEffect(() => {
    if (demoMode) {
      // Auto-login for demo
      login('demo-token', {
        id: 'demo-user-1',
        email: 'demo@aicodestudio.dev',
        name: 'Demo User',
        avatar: undefined,
        createdAt: new Date().toISOString(),
      });
      
      setCurrentProject(DEMO_PROJECT);
      setFiles(DEMO_FILES);
      setCommits(DEMO_COMMITS);
      setBranches(['main', 'develop', 'feature/ai-agent']);

      // Populate dummy collab users in demo mode
      setCollabUsers([
        { id: 'user-2', name: 'Alice Smith', color: '#10B981' },
        { id: 'user-3', name: 'Bob Johnson', color: '#F59E0B' },
        { id: 'user-4', name: 'Charlie Brown', color: '#EF4444' }
      ]);
    } else {
      setCollabUsers([]); // Clear mock users to listen to real WS connections

      const fetchRealData = async () => {
        try {
          // Synchronize/migrate user settings with Postgres/SQLite database on backend
          await useSettingsStore.getState().syncWithBackend();

          // Attempt to fetch real projects
          const { projects } = await projectsAPI.list();
          if (projects && projects.length > 0) {
            setCurrentProject(projects[0]);
            const { files } = await projectsAPI.getFiles(projects[0].id);
            setFiles(files || []);
          } else {
            // Create a default project
            const { project } = await projectsAPI.create({ 
              name: 'my-first-project', 
              description: 'Created automatically by AI Code Studio' 
            });
            setCurrentProject(project);
            const { files } = await projectsAPI.getFiles(project.id);
            setFiles(files || []);
          }
          setBranches(['main']);
        } catch (error) {
          console.error('Failed to load live backend data:', error);
        }
      };
      
      fetchRealData();
    }
  }, [demoMode]);

  const handleCloseWelcome = () => {
    localStorage.setItem('welcomeShown', 'true');
    setShowWelcome(false);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-950 text-white overflow-hidden">
      {/* Header */}
      <Header />

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar />

        {/* Editor Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Editor + Right Panel */}
          <div className="flex-1 flex overflow-hidden">
            {/* Editor */}
            <div className="flex-1 overflow-hidden">
              <EditorPanel />
            </div>

            {/* Right Panel */}
            {isRightPanelOpen && (
              <div
                className="border-l border-gray-700 overflow-hidden"
                style={{ width: rightPanelWidth }}
              >
                {activeRightPanel === 'chat' && <ChatPanel />}
                {activeRightPanel === 'agent' && <AgentPanel />}
                {activeRightPanel === 'browser' && <BrowserPanel />}
              </div>
            )}
          </div>

          {/* Bottom Panel - Terminal */}
          {isBottomPanelOpen && (
            <div style={{ height: bottomPanelHeight }}>
              <TerminalPanel />
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Welcome Modal */}
      {showWelcome && <WelcomeModal onClose={handleCloseWelcome} />}
    </div>
  );
}

function StatusBar() {
  const { currentProject } = useProjectStore();
  const { user } = useAuthStore();
  const { currentBranch, hasChanges } = useGitStore();

  return (
    <div className="h-6 bg-indigo-600 flex items-center justify-between px-3 text-xs">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-400" />
          Ready
        </span>
        
        {currentProject && (
          <span className="text-white/80">
            {currentProject.name}
          </span>
        )}
        
        {currentBranch && (
          <span className={cn(
            "flex items-center gap-1",
            hasChanges && "text-yellow-300"
          )}>
            ⎇ {currentBranch}
            {hasChanges && " •"}
          </span>
        )}

        {/* Shortcuts Hints */}
        <span className="text-white/60 hidden md:inline-block border-l border-white/20 pl-4">
          Ctrl+B: Sidebar • Ctrl+J: Terminal • Ctrl+Shift+C/A/G: Chat/Agent/Browser
        </span>
      </div>

      <div className="flex items-center gap-4">
        <span>TypeScript</span>
        <span>UTF-8</span>
        <span>Ln 1, Col 1</span>
        {user && (
          <span className="text-white/80">{user.name}</span>
        )}
      </div>
    </div>
  );
}
