// ============================================
// AI CODE STUDIO - EDITOR PANEL
// ============================================

import { Code2, Play, GitBranch, Users } from 'lucide-react';
import { useEditorStore, useProjectStore, useGitStore } from '../../stores/useStore';
import { MonacoEditor } from './MonacoEditor';
import { EditorTabs } from './EditorTabs';
import { cn } from '../../utils/cn';

export function EditorPanel() {
  const { tabs, activeTabId, updateTabContent, collabUsers } = useEditorStore();
  const { currentProject } = useProjectStore();
  const { currentBranch, hasChanges } = useGitStore();
  
  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Editor Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800/50 border-b border-gray-700">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Code2 className="w-4 h-4" />
            <span>{currentProject?.name || 'No Project'}</span>
          </div>
          
          {currentBranch && (
            <div className={cn(
              "flex items-center gap-1.5 text-xs px-2 py-1 rounded",
              hasChanges ? "bg-yellow-500/20 text-yellow-400" : "bg-gray-700 text-gray-400"
            )}>
              <GitBranch className="w-3 h-3" />
              <span>{currentBranch}</span>
              {hasChanges && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Collab Users */}
          {collabUsers.length > 0 && (
            <div className="flex items-center gap-1">
              <Users className="w-4 h-4 text-gray-400 mr-1" />
              {collabUsers.slice(0, 3).map((user, i) => (
                <div
                  key={user.id}
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
                  style={{ 
                    backgroundColor: user.color,
                    marginLeft: i > 0 ? '-4px' : 0,
                    zIndex: collabUsers.length - i
                  }}
                  title={user.name}
                >
                  {user.name[0].toUpperCase()}
                </div>
              ))}
              {collabUsers.length > 3 && (
                <div className="w-6 h-6 rounded-full bg-gray-600 flex items-center justify-center text-xs ml-[-4px]">
                  +{collabUsers.length - 3}
                </div>
              )}
            </div>
          )}

          {/* Run Button */}
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors">
            <Play className="w-3.5 h-3.5" />
            <span>Run</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <EditorTabs />

      {/* Editor Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab ? (
          <MonacoEditor
            fileId={activeTab.fileId}
            content={activeTab.content}
            language={activeTab.language}
            onChange={(content) => updateTabContent(activeTab.id, content)}
          />
        ) : (
          <EmptyEditor />
        )}
      </div>
    </div>
  );
}

function EmptyEditor() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-gray-500">
      <Code2 className="w-16 h-16 mb-4 opacity-30" />
      <h3 className="text-lg font-medium mb-2">No file open</h3>
      <p className="text-sm text-gray-600 text-center max-w-md">
        Select a file from the sidebar to start editing, or use the AI chat to generate code.
      </p>
      <div className="mt-6 space-y-2 text-sm text-gray-600">
        <p><kbd className="px-2 py-1 bg-gray-800 rounded">Ctrl+P</kbd> Quick open file</p>
        <p><kbd className="px-2 py-1 bg-gray-800 rounded">Ctrl+Shift+N</kbd> New file</p>
        <p><kbd className="px-2 py-1 bg-gray-800 rounded">Ctrl+`</kbd> Toggle terminal</p>
      </div>
    </div>
  );
}
