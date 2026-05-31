// ============================================
// AI CODE STUDIO - EDITOR TABS
// ============================================

import { X, FileCode, FileJson, FileText, Braces, Hash } from 'lucide-react';
import { useEditorStore } from '../../stores/useStore';
import { cn } from '../../utils/cn';

const fileIcons: Record<string, React.ReactNode> = {
  typescript: <FileCode className="w-4 h-4 text-blue-400" />,
  javascript: <FileCode className="w-4 h-4 text-yellow-400" />,
  json: <FileJson className="w-4 h-4 text-yellow-500" />,
  css: <Hash className="w-4 h-4 text-pink-400" />,
  html: <Braces className="w-4 h-4 text-orange-400" />,
  markdown: <FileText className="w-4 h-4 text-gray-400" />,
  default: <FileText className="w-4 h-4 text-gray-400" />,
};

export function EditorTabs() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useEditorStore();

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center bg-gray-900 border-b border-gray-700 overflow-x-auto scrollbar-thin">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const icon = fileIcons[tab.language] || fileIcons.default;

        return (
          <div
            key={tab.id}
            className={cn(
              'group flex items-center gap-2 px-3 py-2 border-r border-gray-700 cursor-pointer transition-colors min-w-[120px] max-w-[200px]',
              isActive
                ? 'bg-gray-800 text-white border-t-2 border-t-indigo-500'
                : 'bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-white border-t-2 border-t-transparent'
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {icon}
            <span className="truncate text-sm flex-1">{tab.name}</span>
            {tab.isDirty && (
              <span className="w-2 h-2 rounded-full bg-yellow-500" title="Unsaved changes" />
            )}
            <button
              className={cn(
                'p-0.5 rounded hover:bg-gray-600 transition-opacity',
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
