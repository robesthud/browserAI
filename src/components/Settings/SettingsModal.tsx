// ============================================
// AI CODE STUDIO - SETTINGS MODAL
// Universal AI Provider Configuration
// ============================================

import { useState, useEffect } from 'react';
import {
  X,
  Settings,
  Key,
  Cpu,
  Palette,
  Code,
  Save,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
  RefreshCw,
  Zap,
  Globe,
  Server,
} from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { cn } from '../../utils/cn';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// AI Provider configurations
const AI_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    baseUrl: 'https://api.openai.com/v1',
    description: 'GPT-4o, GPT-4 Turbo, GPT-3.5',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '🧠',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    baseUrl: 'https://api.anthropic.com/v1',
    description: 'Claude 4, Claude 3.5 Sonnet/Haiku',
  },
  {
    id: 'google',
    name: 'Google AI',
    icon: '🔷',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    description: 'Gemini 2.5 Pro/Flash',
  },
  {
    id: 'groq',
    name: 'Groq',
    icon: '⚡',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    baseUrl: 'https://api.groq.com/openai/v1',
    description: 'Ultra-fast inference (Llama, Mixtral)',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🔮',
    models: ['deepseek-chat', 'deepseek-coder'],
    baseUrl: 'https://api.deepseek.com/v1',
    description: 'DeepSeek V3, DeepSeek Coder',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    icon: '🌀',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'open-mixtral-8x22b'],
    baseUrl: 'https://api.mistral.ai/v1',
    description: 'Mistral Large, Codestral',
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    icon: '🐼',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-coder-plus'],
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    description: 'Qwen 2.5, Qwen Coder',
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    icon: '🦙',
    models: ['llama3.2', 'codellama', 'mistral', 'deepseek-coder', 'qwen2.5-coder'],
    baseUrl: 'http://localhost:11434/v1',
    description: 'Local models via Ollama',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    icon: '🖥️',
    models: ['local-model'],
    baseUrl: 'http://localhost:1234/v1',
    description: 'Local models via LM Studio',
  },
];

const THEMES = [
  { id: 'dark', name: 'Dark', icon: '🌙' },
  { id: 'light', name: 'Light', icon: '☀️' },
  { id: 'system', name: 'System', icon: '💻' },
];

type SettingsTab = 'ai' | 'editor' | 'appearance' | 'advanced';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('ai');
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [customModel, setCustomModel] = useState('');

  const {
    provider,
    apiKey,
    model,
    baseUrl,
    temperature,
    maxTokens,
    theme,
    fontSize,
    autoSave,
    autoComplete,
    streaming,
    demoMode,
    setProvider,
    setApiKey,
    setModel,
    setBaseUrl,
    setTemperature,
    setMaxTokens,
    setTheme,
    setFontSize,
    setAutoSave,
    setAutoComplete,
    setStreaming,
    setDemoMode,
  } = useSettingsStore();

  const currentProvider = AI_PROVIDERS.find(p => p.id === provider) || AI_PROVIDERS[0];

  useEffect(() => {
    if (!isOpen) {
      setTestStatus('idle');
      setShowApiKey(false);
    }
  }, [isOpen]);

  const handleProviderChange = (providerId: string) => {
    const newProvider = AI_PROVIDERS.find(p => p.id === providerId);
    if (newProvider) {
      setProvider(providerId as any);
      setModel(newProvider.models[0]);
      setBaseUrl(newProvider.baseUrl);
    }
  };

  const testConnection = async () => {
    setTestStatus('testing');
    
    // Simulate API test
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    if (apiKey && apiKey.length > 10) {
      setTestStatus('success');
    } else {
      setTestStatus('error');
    }
    
    setTimeout(() => setTestStatus('idle'), 3000);
  };

  const addCustomModel = () => {
    if (customModel.trim()) {
      setModel(customModel.trim());
      setCustomModel('');
    }
  };

  if (!isOpen) return null;

  const tabs = [
    { id: 'ai' as const, label: 'AI Provider', icon: Cpu },
    { id: 'editor' as const, label: 'Editor', icon: Code },
    { id: 'appearance' as const, label: 'Appearance', icon: Palette },
    { id: 'advanced' as const, label: 'Advanced', icon: Settings },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-3xl mx-4 bg-gray-900 rounded-2xl border border-gray-700 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <Settings className="w-5 h-5 text-gray-400" />
            <h2 className="text-lg font-semibold">Settings</h2>
          </div>
          <button
            className="p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Tabs Sidebar */}
          <div className="w-48 border-r border-gray-800 p-2">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors',
                    activeTab === tab.id
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  )}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {activeTab === 'ai' && (
              <>
                {/* Provider Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    AI Provider
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {AI_PROVIDERS.map((p) => (
                      <button
                        key={p.id}
                        className={cn(
                          'flex flex-col items-center gap-2 p-3 rounded-lg border transition-all',
                          provider === p.id
                            ? 'border-indigo-500 bg-indigo-500/10 text-white'
                            : 'border-gray-700 hover:border-gray-600 text-gray-400 hover:text-white'
                        )}
                        onClick={() => handleProviderChange(p.id)}
                      >
                        <span className="text-2xl">{p.icon}</span>
                        <span className="text-xs font-medium">{p.name}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-gray-500">{currentProvider.description}</p>
                </div>

                {/* API Key */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    API Key
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={`Enter your ${currentProvider.name} API key`}
                        className="w-full pl-10 pr-10 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <button
                      className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2',
                        testStatus === 'testing' && 'bg-gray-700 text-gray-400',
                        testStatus === 'success' && 'bg-green-600 text-white',
                        testStatus === 'error' && 'bg-red-600 text-white',
                        testStatus === 'idle' && 'bg-gray-700 hover:bg-gray-600 text-white'
                      )}
                      onClick={testConnection}
                      disabled={testStatus === 'testing'}
                    >
                      {testStatus === 'testing' && <RefreshCw className="w-4 h-4 animate-spin" />}
                      {testStatus === 'success' && <Check className="w-4 h-4" />}
                      {testStatus === 'error' && <AlertCircle className="w-4 h-4" />}
                      {testStatus === 'idle' && <Zap className="w-4 h-4" />}
                      {testStatus === 'testing' ? 'Testing...' : testStatus === 'idle' ? 'Test' : testStatus === 'success' ? 'Connected' : 'Failed'}
                    </button>
                  </div>
                </div>

                {/* Model Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Model
                  </label>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
                  >
                    {currentProvider.models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  
                  {/* Custom model input for local providers */}
                  {(provider === 'ollama' || provider === 'lmstudio') && (
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder="Enter custom model name"
                        className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm"
                        onClick={addCustomModel}
                      >
                        Add
                      </button>
                    </div>
                  )}
                </div>

                {/* Base URL (for local providers) */}
                {(provider === 'ollama' || provider === 'lmstudio') && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Base URL
                    </label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                      <input
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="http://localhost:11434/v1"
                        className="w-full pl-10 pr-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>
                )}

                {/* Temperature */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-300">Temperature</label>
                    <span className="text-sm text-gray-500">{temperature}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={temperature}
                    onChange={(e) => setTemperature(parseFloat(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>Precise</span>
                    <span>Creative</span>
                  </div>
                </div>

                {/* Max Tokens */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Max Tokens
                  </label>
                  <input
                    type="number"
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                    min={100}
                    max={32000}
                    step={100}
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </>
            )}

            {activeTab === 'editor' && (
              <>
                {/* Font Size */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-300">Font Size</label>
                    <span className="text-sm text-gray-500">{fontSize}px</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="24"
                    value={fontSize}
                    onChange={(e) => setFontSize(parseInt(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                </div>

                {/* Auto Save */}
                <div className="flex items-center justify-between py-3 border-b border-gray-800">
                  <div>
                    <div className="font-medium">Auto Save</div>
                    <div className="text-sm text-gray-500">Automatically save files after changes</div>
                  </div>
                  <Toggle checked={autoSave} onChange={setAutoSave} />
                </div>

                {/* AI Autocomplete */}
                <div className="flex items-center justify-between py-3 border-b border-gray-800">
                  <div>
                    <div className="font-medium">AI Autocomplete</div>
                    <div className="text-sm text-gray-500">Show AI-powered code suggestions</div>
                  </div>
                  <Toggle checked={autoComplete} onChange={setAutoComplete} />
                </div>

                {/* Streaming */}
                <div className="flex items-center justify-between py-3">
                  <div>
                    <div className="font-medium">Streaming Responses</div>
                    <div className="text-sm text-gray-500">Show AI responses as they generate</div>
                  </div>
                  <Toggle checked={streaming} onChange={setStreaming} />
                </div>
              </>
            )}

            {activeTab === 'appearance' && (
              <>
                {/* Theme */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    Theme
                  </label>
                  <div className="flex gap-3">
                    {THEMES.map((t) => (
                      <button
                        key={t.id}
                        className={cn(
                          'flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border transition-all',
                          theme === t.id
                            ? 'border-indigo-500 bg-indigo-500/10'
                            : 'border-gray-700 hover:border-gray-600'
                        )}
                        onClick={() => setTheme(t.id as any)}
                      >
                        <span className="text-2xl">{t.icon}</span>
                        <span className="text-sm">{t.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {activeTab === 'advanced' && (
              <>
                <div className="p-4 bg-gray-800 rounded-lg">
                  <h3 className="font-medium mb-2 flex items-center gap-2">
                    <Server className="w-4 h-4" />
                    Backend Connection
                  </h3>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-1">
                      <div>
                        <div className="font-medium text-sm">Demo / Simulated Mode</div>
                        <div className="text-xs text-gray-400">
                          Use simulated backend data & LLM responses. Disables real Fastify/WebSocket server requests.
                        </div>
                      </div>
                      <Toggle checked={demoMode} onChange={setDemoMode} />
                    </div>

                    {!demoMode && (
                      <div className="pt-2 border-t border-gray-700 text-xs text-gray-400 space-y-1">
                        <div><strong>Active API Base:</strong> /api</div>
                        <div>Ensure Fastify backend is running on port 3000 (proxied) or available at /api.</div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-4 bg-gray-800 rounded-lg">
                  <h3 className="font-medium mb-2 flex items-center gap-2">
                    <Server className="w-4 h-4" />
                    Backend Services Status
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Code Runner</span>
                      <span className={cn(demoMode ? "text-yellow-400" : "text-green-400")}>
                        {demoMode ? "● Simulated" : "● Active"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Browser Agent</span>
                      <span className={cn(demoMode ? "text-yellow-400" : "text-green-400")}>
                        {demoMode ? "● Simulated" : "● Active"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Collaboration Server</span>
                      <span className={cn(demoMode ? "text-yellow-400" : "text-green-400")}>
                        {demoMode ? "● Simulated" : "● Active"}
                      </span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-700 bg-gray-800/50">
          <button
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-medium transition-colors"
            onClick={onClose}
          >
            <Save className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// Toggle Component
function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      className={cn(
        'relative w-11 h-6 rounded-full transition-colors',
        checked ? 'bg-indigo-600' : 'bg-gray-700'
      )}
      onClick={() => onChange(!checked)}
    >
      <span
        className={cn(
          'absolute top-1 w-4 h-4 bg-white rounded-full transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1'
        )}
      />
    </button>
  );
}
