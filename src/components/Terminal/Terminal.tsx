// ============================================
// AI CODE STUDIO - TERMINAL
// ============================================

import { useState, useRef, useEffect } from 'react';
import {
  Terminal as TerminalIcon,
  AlertCircle,
  XCircle,
  Trash2,
  Maximize2,
  Minimize2,
  Play,
  Square,
} from 'lucide-react';
import { useTerminalStore, useEditorStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { simulateCodeExecution } from '../../services/mockBackend';
import { codeAPI } from '../../services/api';
import { cn } from '../../utils/cn';

export function TerminalPanel() {
  const [input, setInput] = useState('');
  const [isMaximized, setIsMaximized] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  
  const { lines, isRunning, addLine, clearLines, setRunning } = useTerminalStore();
  const { tabs, activeTabId } = useEditorStore();

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [lines]);

  const handleCommand = async (command: string) => {
    addLine('input', `$ ${command}`);

    const parts = command.trim().split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case 'clear':
        clearLines();
        break;
        
      case 'help':
        addLine('output', `Available commands:
  clear       Clear the terminal
  help        Show this help
  run         Run the current file
  npm         Package manager commands
  git         Git commands
  ls          List files
  pwd         Print working directory
  echo        Print text`);
        break;

      case 'run': {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (!activeTab) {
          addLine('error', 'No file open to run');
          break;
        }

        setRunning(true);
        addLine('system', `Running ${activeTab.name}...`);

        const language = activeTab.language === 'typescript' || activeTab.language === 'javascript'
          ? 'javascript'
          : activeTab.language;

        const { demoMode } = useSettingsStore.getState();

        try {
          let result;
          if (demoMode) {
            result = await simulateCodeExecution(language, activeTab.content);
          } else {
            result = await codeAPI.run(language, activeTab.content);
          }
          
          if (result.stdout) {
            addLine('output', result.stdout);
          }
          if (result.stderr) {
            addLine('error', result.stderr);
          }
          
          addLine('system', `Process exited with code ${result.exitCode} (${result.executionTimeMs}ms)`);
        } catch (error) {
          addLine('error', `Execution failed: ${error}`);
        }

        setRunning(false);
        break;
      }

      case 'npm':
        if (args[0] === 'install' || args[0] === 'i') {
          setRunning(true);
          addLine('system', 'Installing dependencies...');
          await new Promise(resolve => setTimeout(resolve, 1500));
          addLine('output', `added ${Math.floor(Math.random() * 100) + 50} packages in ${(Math.random() * 3 + 1).toFixed(1)}s`);
          setRunning(false);
        } else if (args[0] === 'run') {
          addLine('system', `Running script: ${args[1] || 'dev'}`);
        } else {
          addLine('output', `npm ${args.join(' ')}`);
        }
        break;

      case 'git':
        if (args[0] === 'status') {
          addLine('output', `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  modified:   src/App.tsx

no changes added to commit`);
        } else if (args[0] === 'log') {
          addLine('output', `commit a1b2c3d (HEAD -> main)
Author: Demo User <demo@example.com>
Date:   Mon Jan 15 10:00:00 2024

    Initial commit`);
        } else {
          addLine('output', `git ${args.join(' ')}`);
        }
        break;

      case 'ls':
        addLine('output', `src/
  App.tsx
  main.tsx
  index.css
  components/
package.json
README.md
.gitignore`);
        break;

      case 'pwd':
        addLine('output', '/home/user/project');
        break;

      case 'echo':
        addLine('output', args.join(' '));
        break;

      case 'node':
      case 'python':
      case 'python3':
        addLine('system', `${cmd} interpreter not available in browser environment.`);
        addLine('system', 'Use the "run" command to execute the current file.');
        break;

      default:
        addLine('error', `Command not found: ${cmd}`);
        addLine('system', 'Type "help" for available commands.');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.trim()) {
      handleCommand(input.trim());
      setInput('');
    }
  };

  const handleRunClick = async () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      await handleCommand('run');
    }
  };

  return (
    <div className={cn(
      'flex flex-col bg-gray-900 border-t border-gray-700',
      isMaximized && 'fixed inset-0 z-50'
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800/50 border-b border-gray-700">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <TerminalIcon className="w-4 h-4 text-gray-400" />
            <span>Terminal</span>
          </div>
          
          {isRunning && (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400">
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              Running...
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
            onClick={clearLines}
            title="Clear terminal"
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

      {/* Output */}
      <div
        ref={outputRef}
        className="flex-1 p-4 overflow-y-auto font-mono text-sm scrollbar-thin"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.length === 0 ? (
          <div className="text-gray-500">
            <p>Welcome to AI Code Studio Terminal</p>
            <p>Type "help" for available commands</p>
          </div>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              className={cn(
                'flex items-start gap-2 py-0.5',
                line.type === 'error' && 'text-red-400',
                line.type === 'system' && 'text-gray-500',
                line.type === 'input' && 'text-gray-300',
                line.type === 'output' && 'text-gray-100'
              )}
            >
              {line.type === 'error' && <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
              {line.type === 'system' && <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
              <span className="whitespace-pre-wrap break-all">{line.content}</span>
            </div>
          ))
        )}

        {/* Input Line */}
        <div className="flex items-center gap-2 mt-2">
          <span className="text-green-400">$</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none text-gray-100"
            placeholder="Type a command..."
            disabled={isRunning}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}
