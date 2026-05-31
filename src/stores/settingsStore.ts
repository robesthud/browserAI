// ============================================
// AI CODE STUDIO - SETTINGS STORE
// Persistent settings with localStorage and Backend Database Synchronization
// ============================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { settingsAPI } from '../services/api';

export type AIProvider = 
  | 'openai' 
  | 'anthropic' 
  | 'google' 
  | 'groq' 
  | 'deepseek' 
  | 'mistral' 
  | 'qwen' 
  | 'zhipu'
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
  availableModels: string[];
  
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
  setAvailableModels: (models: string[]) => void;
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
  
  // Backend persistent sync methods
  syncWithBackend: () => Promise<void>;
  saveToBackend: (settings: Partial<SettingsState>) => Promise<void>;
}

const defaultSettings = {
  provider: 'openai' as AIProvider,
  apiKey: '',
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7,
  maxTokens: 4096,
  availableModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
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
    (set, get) => ({
      ...defaultSettings,
      
      setProvider: (provider) => {
        set({ provider });
        get().saveToBackend({ provider });
      },
      setApiKey: (apiKey) => {
        set({ apiKey });
        get().saveToBackend({ apiKey });
      },
      setModel: (model) => {
        set({ model });
        get().saveToBackend({ model });
      },
      setBaseUrl: (baseUrl) => {
        set({ baseUrl });
        get().saveToBackend({ baseUrl });
      },
      setTemperature: (temperature) => {
        set({ temperature });
        get().saveToBackend({ temperature });
      },
      setMaxTokens: (maxTokens) => {
        set({ maxTokens });
        get().saveToBackend({ maxTokens });
      },
      setAvailableModels: (availableModels) => {
        set({ availableModels });
        get().saveToBackend({ availableModels });
      },
      setFontSize: (fontSize) => {
        set({ fontSize });
        get().saveToBackend({ fontSize });
      },
      setTabSize: (tabSize) => {
        set({ tabSize });
        get().saveToBackend({ tabSize });
      },
      setWordWrap: (wordWrap) => {
        set({ wordWrap });
        get().saveToBackend({ wordWrap });
      },
      setMinimap: (minimap) => {
        set({ minimap });
        get().saveToBackend({ minimap });
      },
      setLineNumbers: (lineNumbers) => {
        set({ lineNumbers });
        get().saveToBackend({ lineNumbers });
      },
      setAutoSave: (autoSave) => {
        set({ autoSave });
        get().saveToBackend({ autoSave });
      },
      setAutoComplete: (autoComplete) => {
        set({ autoComplete });
        get().saveToBackend({ autoComplete });
      },
      setStreaming: (streaming) => {
        set({ streaming });
        get().saveToBackend({ streaming });
      },
      setTheme: (theme) => {
        set({ theme });
        get().saveToBackend({ theme });
      },
      setDemoMode: (demoMode) => set({ demoMode }),
      resetSettings: () => set(defaultSettings),
      
      // Pull and synchronize settings from Fastify бэкенд
      syncWithBackend: async () => {
        if (get().demoMode) return; // Skip in local offline demo mode
        try {
          const res = await settingsAPI.get();
          if (res && res.settings) {
            const db = res.settings;
            set({
              provider: db.provider as AIProvider,
              apiKey: db.apiKey || '',
              model: db.model || 'gpt-4o',
              baseUrl: db.baseUrl || 'https://api.openai.com/v1',
              temperature: db.temperature ?? 0.7,
              maxTokens: db.maxTokens ?? 4096,
              fontSize: db.fontSize ?? 14,
              tabSize: db.tabSize ?? 2,
              wordWrap: db.wordWrap ?? true,
              minimap: db.minimap ?? true,
              lineNumbers: db.lineNumbers ?? true,
              autoSave: db.autoSave ?? true,
              autoComplete: db.autoComplete ?? true,
              streaming: db.streaming ?? true,
              theme: db.theme as Theme || 'dark',
            });
          } else {
            // Push local settings to DB if empty on backend
            await get().saveToBackend(get());
          }
        } catch (error) {
          console.error('[Sync] Failed to sync settings with backend database:', error);
        }
      },

      // Push active settings updates directly to Postgres/SQLite
      saveToBackend: async (newSettings) => {
        if (get().demoMode) return;
        try {
          // Merge with current state
          const merged = {
            provider: get().provider,
            apiKey: get().apiKey,
            model: get().model,
            baseUrl: get().baseUrl,
            temperature: get().temperature,
            maxTokens: get().maxTokens,
            fontSize: get().fontSize,
            tabSize: get().tabSize,
            wordWrap: get().wordWrap,
            minimap: get().minimap,
            lineNumbers: get().lineNumbers,
            autoSave: get().autoSave,
            autoComplete: get().autoComplete,
            streaming: get().streaming,
            theme: get().theme,
            ...newSettings
          };
          await settingsAPI.update(merged);
        } catch (error) {
          console.error('[Sync] Failed to save settings to backend:', error);
        }
      }
    }),
    {
      name: 'ai-studio-settings',
    }
  )
);
export default useSettingsStore;
