// ============================================
// AI CODE STUDIO - BROWSER AI PANEL
// ============================================

import { useState, useEffect } from 'react';
import {
  Globe,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Home,
  Lock,
  Send,
  Camera,
  Mouse,
  Type,
  Eye,
  Bot,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { useBrowserStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { simulateBrowserAgent } from '../../services/mockBackend';
import { browserAPI } from '../../services/api';
import { cn } from '../../utils/cn';

const QUICK_ACTIONS = [
  { id: 'screenshot', icon: Camera, label: 'Screenshot' },
  { id: 'click', icon: Mouse, label: 'Click element' },
  { id: 'type', icon: Type, label: 'Type text' },
  { id: 'extract', icon: Eye, label: 'Extract data' },
];

export function BrowserPanel() {
  const [url, setUrl] = useState('https://github.com');
  const [instruction, setInstruction] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentResult, setAgentResult] = useState<any>(null);
  const [showAgent, setShowAgent] = useState(false);
  const { state, navigate, goBack } = useBrowserStore();
  const { demoMode } = useSettingsStore();

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'BROWSER_NAVIGATION') {
        navigate(e.data.url);
        setUrl(e.data.url);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate]);

  const handleNavigate = () => {
    if (!url.trim()) return;
    
    let finalUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      finalUrl = 'https://' + url;
    }
    
    navigate(finalUrl);
    setUrl(finalUrl);
  };

  const handleAgentInstruction = async () => {
    if (!instruction.trim() || isLoading) return;

    setIsLoading(true);
    setAgentResult(null);

    const { demoMode } = useSettingsStore.getState();

    try {
      let result;
      if (demoMode) {
        result = await simulateBrowserAgent(instruction, state.url);
      } else {
        result = await browserAPI.executeInstruction(instruction, state.url);
      }
      setAgentResult(result);
    } catch (error) {
      setAgentResult({ error: String(error) });
    }

    setIsLoading(false);
    setInstruction('');
  };

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-blue-400" />
          <span className="font-medium">Browser AI</span>
        </div>
        <button
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors',
            showAgent 
              ? 'bg-purple-600 text-white' 
              : 'bg-gray-800 text-gray-400 hover:text-white'
          )}
          onClick={() => setShowAgent(!showAgent)}
        >
          <Bot className="w-4 h-4" />
          Agent
        </button>
      </div>

      {/* URL Bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 bg-gray-800/50">
        <button
          className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded transition-colors"
          onClick={goBack}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded transition-colors">
          <ArrowRight className="w-4 h-4" />
        </button>
        <button
          className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded transition-colors"
          onClick={() => navigate(url)}
        >
          <RefreshCw className={cn('w-4 h-4', state.isLoading && 'animate-spin')} />
        </button>
        <button
          className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded transition-colors"
          onClick={() => {
            setUrl('https://google.com');
            navigate('https://google.com');
          }}
        >
          <Home className="w-4 h-4" />
        </button>

        <div className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-gray-900 rounded-lg border border-gray-700">
          <Lock className="w-3.5 h-3.5 text-green-500" />
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
            className="flex-1 bg-transparent text-sm text-white outline-none"
            placeholder="Enter URL..."
          />
          <button
            className="p-1 text-gray-500 hover:text-white transition-colors"
            onClick={() => window.open(url, '_blank')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Browser Content */}
      <div className="flex-1 flex overflow-hidden">
          {/* Main Browser View */}
          <div className={cn(
            'flex-1 flex flex-col bg-white',
            showAgent && 'border-r border-gray-700'
          )}>
            {/* Simulated or Real Browser Content */}
            {demoMode ? (
              <div className="flex-1 flex items-center justify-center bg-gray-100">
                <div className="text-center p-8">
                  <Globe className="w-16 h-16 mx-auto mb-4 text-gray-400" />
                  <h3 className="text-lg font-medium text-gray-700 mb-2">Browser Preview (Simulated)</h3>
                  <p className="text-sm text-gray-500 max-w-md">
                    In a full deployment, this would show an embedded browser or proxy view.
                    <br />
                    The AI agent can still simulate browser actions. Turn off "Demo Mode" in Settings (Advanced tab) to connect to the real CORS proxy!
                  </p>
                  <div className="mt-4 p-4 bg-white rounded-lg shadow-sm max-w-md mx-auto">
                    <div className="text-left">
                      <div className="text-xs text-gray-400 mb-1">Current URL:</div>
                      <div className="text-sm text-gray-700 font-mono break-all">{state.url}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 w-full h-full bg-white relative">
                <iframe 
                  src={`/api/proxy?url=${encodeURIComponent(state.url)}`}
                  className="w-full h-full border-none"
                  title="Web Sandbox"
                />
              </div>
            )}

          {/* Quick Actions */}
          <div className="flex items-center gap-2 px-4 py-2 bg-gray-800/50 border-t border-gray-700">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300 transition-colors"
                  onClick={() => setInstruction(`${action.label} on the current page`)}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent Panel */}
        {showAgent && (
          <div className="w-80 flex flex-col bg-gray-900">
            <div className="p-4 border-b border-gray-800">
              <h3 className="text-sm font-medium mb-1">Browser Agent</h3>
              <p className="text-xs text-gray-500">
                Give instructions in natural language
              </p>
            </div>

            {/* Agent Result */}
            <div className="flex-1 overflow-y-auto p-4">
              {agentResult && (
                <div className="bg-gray-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Bot className="w-4 h-4 text-purple-400" />
                    <span className="text-sm font-medium">Result</span>
                  </div>
                  <pre className="text-xs text-gray-300 whitespace-pre-wrap overflow-x-auto">
                    {JSON.stringify(agentResult, null, 2)}
                  </pre>
                </div>
              )}

              {!agentResult && !isLoading && (
                <div className="text-center text-gray-500 py-8">
                  <Bot className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    Send an instruction to the browser agent
                  </p>
                </div>
              )}

              {isLoading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
                </div>
              )}
            </div>

            {/* Agent Input */}
            <div className="p-4 border-t border-gray-800">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAgentInstruction()}
                  placeholder="e.g., Find all links on this page..."
                  className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                  disabled={isLoading}
                />
                <button
                  onClick={handleAgentInstruction}
                  disabled={!instruction.trim() || isLoading}
                  className={cn(
                    'px-3 rounded transition-colors',
                    instruction.trim() && !isLoading
                      ? 'bg-purple-600 hover:bg-purple-700 text-white'
                      : 'bg-gray-800 text-gray-500 cursor-not-allowed'
                  )}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
