// ============================================
// AI CODE STUDIO - GLOBAL STORE (ZUSTAND)
// ============================================

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { 
  User, 
  Project, 
  FileNode, 
  EditorTab, 
  ChatMessage, 
  TerminalLine,
  AgentTask,
  AgentStep,
  CollabUser,
  Cursor,
  BrowserState,
  GitCommit
} from '../types';

// ============================================
// AUTH STORE
// ============================================
interface AuthStore {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  setUser: (user: User) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),
  isLoading: false,
  login: (token, user) => {
    localStorage.setItem('token', token);
    set({ token, user, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem('token');
    set({ token: null, user: null, isAuthenticated: false });
  },
  setUser: (user) => set({ user }),
}));

// ============================================
// PROJECT STORE
// ============================================
interface ProjectStore {
  projects: Project[];
  currentProject: Project | null;
  files: FileNode[];
  isLoading: boolean;
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (project: Project | null) => void;
  setFiles: (files: FileNode[]) => void;
  addFile: (file: FileNode) => void;
  updateFile: (id: string, content: string) => void;
  deleteFile: (id: string) => void;
  toggleFolder: (id: string) => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  projects: [],
  currentProject: null,
  files: [],
  isLoading: false,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (project) => set({ currentProject: project }),
  setFiles: (files) => set({ files }),
  addFile: (file) => set((state) => ({ files: [...state.files, file] })),
  updateFile: (id, content) => set((state) => ({
    files: state.files.map(f => f.id === id ? { ...f, content } : f)
  })),
  deleteFile: (id) => set((state) => ({
    files: state.files.filter(f => f.id !== id)
  })),
  toggleFolder: (id) => set((state) => ({
    files: state.files.map(f => f.id === id ? { ...f, isOpen: !f.isOpen } : f)
  })),
}));

// ============================================
// EDITOR STORE
// ============================================
interface EditorStore {
  tabs: EditorTab[];
  activeTabId: string | null;
  cursors: Cursor[];
  collabUsers: CollabUser[];
  openTab: (file: FileNode) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  markTabDirty: (id: string, isDirty: boolean) => void;
  setCursors: (cursors: Cursor[]) => void;
  setCollabUsers: (users: CollabUser[]) => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  cursors: [],
  collabUsers: [],
  openTab: (file) => {
    const existing = get().tabs.find(t => t.fileId === file.id);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: EditorTab = {
      id: uuidv4(),
      fileId: file.id,
      path: file.path,
      name: file.name,
      content: file.content || '',
      language: getLanguageFromPath(file.path),
      isDirty: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }));
  },
  closeTab: (id) => set((state) => {
    const tabs = state.tabs.filter(t => t.id !== id);
    let activeTabId = state.activeTabId;
    if (activeTabId === id) {
      activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
    }
    return { tabs, activeTabId };
  }),
  setActiveTab: (id) => set({ activeTabId: id }),
  updateTabContent: (id, content) => set((state) => ({
    tabs: state.tabs.map(t => t.id === id ? { ...t, content, isDirty: true } : t)
  })),
  markTabDirty: (id, isDirty) => set((state) => ({
    tabs: state.tabs.map(t => t.id === id ? { ...t, isDirty } : t)
  })),
  setCursors: (cursors) => set({ cursors }),
  setCollabUsers: (users) => set({ collabUsers: users }),
}));

// ============================================
// CHAT STORE
// ============================================
interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, content: string) => void;
  appendToMessage: (id: string, chunk: string) => void;
  clearMessages: () => void;
  setStreaming: (isStreaming: boolean) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  isStreaming: false,
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message]
  })),
  updateMessage: (id, content) => set((state) => ({
    messages: state.messages.map(m => m.id === id ? { ...m, content } : m)
  })),
  appendToMessage: (id, chunk) => set((state) => ({
    messages: state.messages.map(m => 
      m.id === id ? { ...m, content: m.content + chunk } : m
    )
  })),
  clearMessages: () => set({ messages: [] }),
  setStreaming: (isStreaming) => set({ isStreaming }),
}));

// ============================================
// TERMINAL STORE
// ============================================
interface TerminalStore {
  lines: TerminalLine[];
  isRunning: boolean;
  addLine: (type: TerminalLine['type'], content: string) => void;
  clearLines: () => void;
  setRunning: (isRunning: boolean) => void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  lines: [],
  isRunning: false,
  addLine: (type, content) => set((state) => ({
    lines: [...state.lines, {
      id: uuidv4(),
      type,
      content,
      timestamp: new Date().toISOString(),
    }]
  })),
  clearLines: () => set({ lines: [] }),
  setRunning: (isRunning) => set({ isRunning }),
}));

// ============================================
// AGENT STORE
// ============================================
interface AgentStore {
  tasks: AgentTask[];
  currentTask: AgentTask | null;
  isRunning: boolean;
  createTask: (goal: string) => AgentTask;
  addStep: (taskId: string, step: AgentStep) => void;
  updateStepStatus: (taskId: string, stepId: string, status: AgentStep['status'], result?: string) => void;
  setCurrentTask: (task: AgentTask | null) => void;
  setRunning: (isRunning: boolean) => void;
}

export const useAgentStore = create<AgentStore>((set) => ({
  tasks: [],
  currentTask: null,
  isRunning: false,
  createTask: (goal) => {
    const task: AgentTask = {
      id: uuidv4(),
      goal,
      steps: [],
      status: 'planning',
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      tasks: [...state.tasks, task],
      currentTask: task,
    }));
    return task;
  },
  addStep: (taskId, step) => set((state) => ({
    tasks: state.tasks.map(t => 
      t.id === taskId ? { ...t, steps: [...t.steps, step] } : t
    ),
    currentTask: state.currentTask?.id === taskId 
      ? { ...state.currentTask, steps: [...state.currentTask.steps, step] }
      : state.currentTask,
  })),
  updateStepStatus: (taskId, stepId, status, result) => set((state) => ({
    tasks: state.tasks.map(t => 
      t.id === taskId 
        ? { ...t, steps: t.steps.map(s => s.id === stepId ? { ...s, status, result } : s) }
        : t
    ),
    currentTask: state.currentTask?.id === taskId 
      ? { 
          ...state.currentTask, 
          steps: state.currentTask.steps.map(s => s.id === stepId ? { ...s, status, result } : s) 
        }
      : state.currentTask,
  })),
  setCurrentTask: (task) => set({ currentTask: task }),
  setRunning: (isRunning) => set({ isRunning }),
}));

// ============================================
// BROWSER STORE
// ============================================
interface BrowserStore {
  state: BrowserState;
  history: string[];
  setState: (state: Partial<BrowserState>) => void;
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
}

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  state: {
    url: 'https://google.com',
    title: 'Google',
    isLoading: false,
  },
  history: [],
  setState: (newState) => set((state) => ({
    state: { ...state.state, ...newState }
  })),
  navigate: (url) => set((state) => ({
    state: { ...state.state, url, isLoading: true },
    history: [...state.history, url],
  })),
  goBack: () => {
    const { history } = get();
    if (history.length > 1) {
      const newHistory = history.slice(0, -1);
      const url = newHistory[newHistory.length - 1];
      set({ history: newHistory, state: { ...get().state, url } });
    }
  },
  goForward: () => {},
}));

// ============================================
// GIT STORE
// ============================================
interface GitStore {
  commits: GitCommit[];
  currentBranch: string;
  branches: string[];
  isLoading: boolean;
  hasChanges: boolean;
  setCommits: (commits: GitCommit[]) => void;
  setBranch: (branch: string) => void;
  setBranches: (branches: string[]) => void;
  setHasChanges: (hasChanges: boolean) => void;
}

export const useGitStore = create<GitStore>((set) => ({
  commits: [],
  currentBranch: 'main',
  branches: ['main'],
  isLoading: false,
  hasChanges: false,
  setCommits: (commits) => set({ commits }),
  setBranch: (branch) => set({ currentBranch: branch }),
  setBranches: (branches) => set({ branches }),
  setHasChanges: (hasChanges) => set({ hasChanges }),
}));

// ============================================
// UI STORE
// ============================================
interface UIStore {
  sidebarWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  isSidebarOpen: boolean;
  isRightPanelOpen: boolean;
  isBottomPanelOpen: boolean;
  activeRightPanel: 'chat' | 'agent' | 'browser';
  activeBottomPanel: 'terminal' | 'problems' | 'output';
  theme: 'dark' | 'light';
  setSidebarWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  setBottomPanelHeight: (height: number) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  toggleBottomPanel: () => void;
  setActiveRightPanel: (panel: UIStore['activeRightPanel']) => void;
  setActiveBottomPanel: (panel: UIStore['activeBottomPanel']) => void;
  setTheme: (theme: 'dark' | 'light') => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarWidth: 260,
  rightPanelWidth: 400,
  bottomPanelHeight: 200,
  isSidebarOpen: true,
  isRightPanelOpen: true,
  isBottomPanelOpen: true,
  activeRightPanel: 'chat',
  activeBottomPanel: 'terminal',
  theme: 'dark',
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  toggleRightPanel: () => set((state) => ({ isRightPanelOpen: !state.isRightPanelOpen })),
  toggleBottomPanel: () => set((state) => ({ isBottomPanelOpen: !state.isBottomPanelOpen })),
  setActiveRightPanel: (panel) => set({ activeRightPanel: panel, isRightPanelOpen: true }),
  setActiveBottomPanel: (panel) => set({ activeBottomPanel: panel, isBottomPanelOpen: true }),
  setTheme: (theme) => set({ theme }),
}));

// ============================================
// HELPERS
// ============================================
function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    dockerfile: 'dockerfile',
  };
  return langMap[ext || ''] || 'plaintext';
}
