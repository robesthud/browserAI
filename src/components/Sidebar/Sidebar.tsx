// ============================================
// AI CODE STUDIO - SIDEBAR
// ============================================

import { useState } from 'react';
import {
  Files,
  Search,
  GitBranch,
  Settings,
  Plus,
  RefreshCw,
  Download,
  FolderGit2,
  ChevronDown,
} from 'lucide-react';
import { FileTree } from './FileTree';
import { useProjectStore, useGitStore, useUIStore } from '../../stores/useStore';
import { DEMO_FILES, DEMO_COMMITS } from '../../services/mockBackend';
import { cn } from '../../utils/cn';

type SidebarTab = 'files' | 'search' | 'git' | 'settings';

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<SidebarTab>('files');
  const { sidebarWidth, isSidebarOpen } = useUIStore();
  const { setFiles, files } = useProjectStore();
  const { commits, setCommits } = useGitStore();

  // Load demo files if empty
  if (files.length === 0) {
    setFiles(DEMO_FILES);
  }

  // Load demo commits if empty
  if (commits.length === 0) {
    setCommits(DEMO_COMMITS);
  }

  if (!isSidebarOpen) return null;

  const tabs = [
    { id: 'files' as const, icon: Files, label: 'Explorer' },
    { id: 'search' as const, icon: Search, label: 'Search' },
    { id: 'git' as const, icon: GitBranch, label: 'Source Control' },
    { id: 'settings' as const, icon: Settings, label: 'Settings' },
  ];

  return (
    <div
      className="flex h-full bg-gray-900 border-r border-gray-700"
      style={{ width: sidebarWidth }}
    >
      {/* Tab Icons */}
      <div className="flex flex-col items-center py-2 px-1 bg-gray-900 border-r border-gray-800 w-12">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              className={cn(
                'p-2.5 rounded-lg mb-1 transition-colors',
                activeTab === tab.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-white hover:bg-gray-800'
              )}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
            >
              <Icon className="w-5 h-5" />
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeTab === 'files' && <FilesPanel />}
        {activeTab === 'search' && <SearchPanel />}
        {activeTab === 'git' && <GitPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
      </div>
    </div>
  );
}

function FilesPanel() {
  const { currentProject } = useProjectStore();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          Explorer
        </span>
        <div className="flex items-center gap-1">
          <button className="p-1 text-gray-500 hover:text-white hover:bg-gray-700 rounded">
            <Plus className="w-4 h-4" />
          </button>
          <button className="p-1 text-gray-500 hover:text-white hover:bg-gray-700 rounded">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Project Name */}
      {currentProject && (
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-800/50 border-b border-gray-800">
          <FolderGit2 className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-medium">{currentProject.name}</span>
        </div>
      )}

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <FileTree />
      </div>
    </div>
  );
}

function SearchPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ file: string; line: number; text: string }[]>([]);

  const handleSearch = () => {
    // Simulate search results
    if (query.trim()) {
      setResults([
        { file: 'src/App.tsx', line: 5, text: `import { ${query} } from './components';` },
        { file: 'src/components/Header.tsx', line: 12, text: `const ${query} = useCallback(() => {` },
        { file: 'src/utils/helpers.ts', line: 28, text: `export function ${query}(data: any) {` },
      ]);
    } else {
      setResults([]);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-gray-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search in files..."
            className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {results.length > 0 ? (
          <div className="py-2">
            {results.map((result, i) => (
              <div
                key={i}
                className="px-3 py-2 hover:bg-gray-800 cursor-pointer"
              >
                <div className="text-sm text-indigo-400">{result.file}</div>
                <div className="text-xs text-gray-500 mt-1">
                  Line {result.line}: <span className="text-gray-400">{result.text}</span>
                </div>
              </div>
            ))}
          </div>
        ) : query ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            No results found
          </div>
        ) : (
          <div className="p-4 text-center text-gray-500 text-sm">
            Enter a search term
          </div>
        )}
      </div>
    </div>
  );
}

function GitPanel() {
  const { commits, currentBranch, branches, hasChanges } = useGitStore();
  const [showBranches, setShowBranches] = useState(false);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-gray-800">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          Source Control
        </span>
      </div>

      {/* Branch Selector */}
      <div className="px-3 py-2 border-b border-gray-800">
        <button
          className="flex items-center gap-2 w-full px-3 py-2 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
          onClick={() => setShowBranches(!showBranches)}
        >
          <GitBranch className="w-4 h-4 text-green-400" />
          <span className="flex-1 text-left text-sm">{currentBranch}</span>
          <ChevronDown className={cn('w-4 h-4 transition-transform', showBranches && 'rotate-180')} />
        </button>

        {showBranches && (
          <div className="mt-2 bg-gray-800 rounded-lg overflow-hidden">
            {branches.map((branch) => (
              <button
                key={branch}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm hover:bg-gray-700 transition-colors',
                  branch === currentBranch ? 'text-indigo-400' : 'text-gray-400'
                )}
              >
                {branch}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Changes */}
      {hasChanges && (
        <div className="px-3 py-2 border-b border-gray-800">
          <div className="text-xs text-gray-400 mb-2">Changes</div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-2 py-1 text-sm text-yellow-400">
              <span className="w-4 text-center">M</span>
              <span>src/App.tsx</span>
            </div>
          </div>
          <button className="mt-2 w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg transition-colors">
            Commit Changes
          </button>
        </div>
      )}

      {/* Commits */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2 text-xs text-gray-400">Recent Commits</div>
        {commits.map((commit) => (
          <div
            key={commit.hash}
            className="px-3 py-2 hover:bg-gray-800 cursor-pointer border-b border-gray-800/50"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-indigo-400">{commit.hash}</span>
              <span className="text-xs text-gray-500">
                {new Date(commit.date).toLocaleDateString()}
              </span>
            </div>
            <div className="text-sm text-gray-300 truncate">{commit.message}</div>
            <div className="text-xs text-gray-500 mt-1">{commit.author}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="p-3 border-t border-gray-800 flex gap-2">
        <button className="flex-1 flex items-center justify-center gap-2 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors">
          <Download className="w-4 h-4" />
          Pull
        </button>
        <button className="flex-1 flex items-center justify-center gap-2 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors">
          <RefreshCw className="w-4 h-4" />
          Push
        </button>
      </div>
    </div>
  );
}

function SettingsPanel() {
  const { theme, setTheme } = useUIStore();

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-gray-800">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          Settings
        </span>
      </div>

      <div className="p-3 space-y-4">
        {/* Theme */}
        <div>
          <label className="text-sm text-gray-400 block mb-2">Theme</label>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>

        {/* AI Provider */}
        <div>
          <label className="text-sm text-gray-400 block mb-2">AI Provider</label>
          <select
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
          >
            <option value="openai">OpenAI (GPT-4)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="groq">Groq (Fast)</option>
            <option value="ollama">Ollama (Local)</option>
          </select>
        </div>

        {/* Font Size */}
        <div>
          <label className="text-sm text-gray-400 block mb-2">Editor Font Size</label>
          <input
            type="range"
            min="10"
            max="24"
            defaultValue="14"
            className="w-full"
          />
        </div>

        {/* Auto Save */}
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-400">Auto Save</label>
          <button className="relative w-10 h-5 bg-indigo-600 rounded-full transition-colors">
            <span className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full" />
          </button>
        </div>
      </div>
    </div>
  );
}
