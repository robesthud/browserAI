// ============================================
// AI CODE STUDIO - SETTINGS STORE
// Persistent settings with localStorage
// ============================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AIProvider = 
  | 'openai' 
  | 'anthropic' 
  | 'google' 
  | 'groq' 
  | 'deepseek' 
  | 'mistral' 
  | 'qwen' 
  | 'ollama' 
  | 'lmstudio';

export type Theme = 'dark' | 'light' | 'system';

interface SettingsState {
  // AI Settings
  provider: AIProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  
  // Editor Settings
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  autoSave: boolean;
  autoComplete: boolean;
  streaming: boolean;
  
  // Appearance
  theme: Theme;
  
  // Backend Mode
  demoMode: boolean;
  
  // Actions
  setProvider: (provider: AIProvider) => void;
  setApiKey: (apiKey: string) => void;
  setModel: (model: string) => void;
  setBaseUrl: (baseUrl: string) => void;
  setTemperature: (temperature: number) => void;
  setMaxTokens: (maxTokens: number) => void;
  setFontSize: (fontSize: number) => void;
  setTabSize: (tabSize: number) => void;
  setWordWrap: (wordWrap: boolean) => void;
  setMinimap: (minimap: boolean) => void;
  setLineNumbers: (lineNumbers: boolean) => void;
  setAutoSave: (autoSave: boolean) => void;
  setAutoComplete: (autoComplete: boolean) => void;
  setStreaming: (streaming: boolean) => void;
  setTheme: (theme: Theme) => void;
  setDemoMode: (demoMode: boolean) => void;
  resetSettings: () => void;
}

const defaultSettings = {
  provider: 'openai' as AIProvider,
  apiKey: '',
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7,
  maxTokens: 4096,
  fontSize: 14,
  tabSize: 2,
  wordWrap: true,
  minimap: true,
  lineNumbers: true,
  autoSave: true,
  autoComplete: true,
  streaming: true,
  theme: 'dark' as Theme,
  demoMode: true,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,
      
      setProvider: (provider) => set({ provider }),
      setApiKey: (apiKey) => set({ apiKey }),
      setModel: (model) => set({ model }),
      setBaseUrl: (baseUrl) => set({ baseUrl }),
      setTemperature: (temperature) => set({ temperature }),
      setMaxTokens: (maxTokens) => set({ maxTokens }),
      setFontSize: (fontSize) => set({ fontSize }),
      setTabSize: (tabSize) => set({ tabSize }),
      setWordWrap: (wordWrap) => set({ wordWrap }),
      setMinimap: (minimap) => set({ minimap }),
      setLineNumbers: (lineNumbers) => set({ lineNumbers }),
      setAutoSave: (autoSave) => set({ autoSave }),
      setAutoComplete: (autoComplete) => set({ autoComplete }),
      setStreaming: (streaming) => set({ streaming }),
      setTheme: (theme) => set({ theme }),
      setDemoMode: (demoMode) => set({ demoMode }),
      resetSettings: () => set(defaultSettings),
    }),
    {
      name: 'ai-studio-settings',
    }
  )
);
