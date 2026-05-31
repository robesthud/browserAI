// ============================================
// AI CODE STUDIO - TYPE DEFINITIONS
// ============================================

// User & Auth
export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  createdAt: string;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
}

// Project & Files
export interface Project {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  files: FileNode[];
  gitRepo?: GitRepo;
  createdAt: string;
  updatedAt: string;
}

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  content?: string;
  language?: string;
  children?: FileNode[];
  isOpen?: boolean;
  projectId: string;
}

export interface GitRepo {
  id: string;
  remoteUrl: string;
  branch: string;
  projectId: string;
  lastSync: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// Editor & Collaboration
export interface EditorTab {
  id: string;
  fileId: string;
  path: string;
  name: string;
  content: string;
  language: string;
  isDirty: boolean;
}

export interface Cursor {
  id: string;
  userId: string;
  userName: string;
  color: string;
  position: {
    line: number;
    column: number;
  };
  selection?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

export interface CollabUser {
  id: string;
  name: string;
  avatar?: string;
  color: string;
  cursor?: Cursor;
}

// Chat & AI
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  codeBlocks?: CodeBlock[];
}

export interface CodeBlock {
  language: string;
  code: string;
  filename?: string;
}

export interface AICommand {
  name: string;
  description: string;
  prompt: string;
}

// Terminal
export interface TerminalLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'system';
  content: string;
  timestamp: string;
}

export interface CodeExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}

// Browser AI
export interface BrowserAction {
  type: 'navigate' | 'click' | 'type' | 'scroll' | 'screenshot' | 'extract';
  target?: string;
  value?: string;
  selector?: string;
}

export interface BrowserState {
  url: string;
  title: string;
  screenshot?: string;
  isLoading: boolean;
  elements?: ExtractedElement[];
}

export interface ExtractedElement {
  tag: string;
  text: string;
  selector: string;
  attributes: Record<string, string>;
}

// Agent
export interface AgentStep {
  id: string;
  type: 'plan' | 'create_file' | 'edit_file' | 'run_command' | 'install' | 'browser' | 'complete';
  description: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  result?: string;
  error?: string;
}

export interface AgentTask {
  id: string;
  goal: string;
  steps: AgentStep[];
  status: 'planning' | 'executing' | 'completed' | 'error';
  createdAt: string;
}

// WebSocket Events
export interface WSMessage {
  type: string;
  payload: any;
}

export type WSEventType = 
  | 'collab:join'
  | 'collab:edit'
  | 'collab:cursor'
  | 'collab:update'
  | 'collab:cursors'
  | 'ai:completion'
  | 'ai:completion:chunk'
  | 'ai:chat:stream'
  | 'ai:chat:chunk'
  | 'ai:chat:end'
  | 'browser:action'
  | 'browser:result';
