// ============================================
// AI CODE STUDIO - REAL TERMINAL WITH PTY
// Handles direct terminal access to project root directory
// ============================================

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import {
  Terminal as TerminalIcon,
  Trash2,
  Maximize2,
  Minimize2,
  Play,
  Square,
  AlertCircle,
} from 'lucide-react';
import { useTerminalStore, useEditorStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { simulateCodeExecution } from '../../services/mockBackend';
import { wsService } from '../../services/websocket';
import { cn } from '../../utils/cn';

// Import CSS stylesheet of xterm
import 'xterm/css/xterm.css';

export function TerminalPanel() {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  const { isRunning, setRunning } = useTerminalStore();
  const { tabs, activeTabId } = useEditorStore();
  const { demoMode } = useSettingsStore();

  useEffect(() => {
    if (!terminalRef.current) return;

    if (demoMode) {
      // Clean up xterm instance if switching back to simulated input/logs
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      return;
    }

    // Initialize xterm.js instance
    const xterm = new XTerminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      theme: {
        background: '#111827', // Gray 900
        foreground: '#F3F4F6', // Gray 100
        cursor: '#818CF8', // Indigo 400
      },
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    xterm.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Send terminal initializations via socket
    wsService.send('terminal:init', {});

    // Listen to keystrokes on client side and transfer payload to backend PTY
    const onKeyDispose = xterm.onKey((e) => {
      wsService.sendTerminalInput(e.key);
    });

    // Handle terminal:output events streamed from simple server PTY process
    const unsubOutput = wsService.on('terminal:output', (payload: any) => {
      xterm.write(payload.data);
    });

    // Trigger terminal resizing
    const handleResize = () => {
      try {
        fitAddon.fit();
        wsService.sendTerminalResize(xterm.cols, xterm.rows);
      } catch (err) {}
    };

    window.addEventListener('resize', handleResize);
    // Fire first resize alignment
    setTimeout(handleResize, 100);

    return () => {
      onKeyDispose.dispose();
      unsubOutput();
      window.removeEventListener('resize', handleResize);
      xterm.dispose();
      xtermRef.current = null;
    };
  }, [demoMode]);

  // Clean terminal output
  const handleClear = () => {
    if (xtermRef.current) {
      xtermRef.current.clear();
    }
  };

  const handleRunClick = async () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab) return;

    if (demoMode) {
      // Simulated Run click fallback
      setRunning(true);
      const language = activeTab.language === 'typescript' || activeTab.language === 'javascript'
        ? 'javascript'
        : activeTab.language;

      try {
        const result = await simulateCodeExecution(language, activeTab.content);
        console.log('[Demo Run]', result);
      } catch {}
      setRunning(false);
    } else {
      // Execute the active open file directly inside the interactive PTY session
      const runCommand = activeTab.language === 'python'
        ? `python3 ${activeTab.path}\r`
        : activeTab.language === 'javascript' || activeTab.language === 'typescript'
        ? `node ${activeTab.path}\r`
        : `echo "Cannot directly run language: ${activeTab.language}"\r`;

      wsService.sendTerminalInput(runCommand);
    }
  };

  return (
    <div className={cn(
      'flex flex-col bg-gray-900 border-t border-gray-700 h-full',
      isMaximized && 'fixed inset-0 z-50'
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800/50 border-b border-gray-700">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <TerminalIcon className="w-4 h-4 text-gray-400" />
            <span>PTY Shell Terminal</span>
          </div>
          
          {isRunning && (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400">
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              Executing Process...
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded transition-colors"
            onClick={handleRunClick}
            disabled={isRunning}
            title="Run current file"
          >
            {isRunning ? (
              <Square className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </button>
          <button
            className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded transition-colors"
            onClick={handleClear}
            title="Clear terminal screen"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded transition-colors"
            onClick={() => setIsMaximized(!isMaximized)}
            title={isMaximized ? 'Minimize' : 'Maximize'}
          >
            {isMaximized ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Terminal View Container */}
      <div className="flex-1 w-full bg-[#111827] overflow-hidden p-2 relative">
        {demoMode ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 font-sans p-6 text-center">
            <AlertCircle className="w-12 h-12 text-yellow-500/80 mb-3 animate-bounce" />
            <h3 className="font-bold text-sm text-gray-300">Demo/Simulated Mode Active</h3>
            <p className="text-xs text-gray-400 max-w-sm mt-1 leading-relaxed">
              Real terminal with interactive PTY requires a direct backend connection. Turn off "Demo Mode" in Settings (Advanced Tab) to launch shell!
            </p>
          </div>
        ) : (
          <div ref={terminalRef} className="w-full h-full" />
        )}
      </div>
    </div>
  );
}
export default TerminalPanel;
