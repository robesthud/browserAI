// ============================================
// AI CODE STUDIO - FILE TREE COMPONENT
// ============================================

import { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileText,
  Hash,
  Image,
  MoreVertical,
  Plus,
  Trash2,
  Edit3,
} from 'lucide-react';
import { useProjectStore, useEditorStore } from '../../stores/useStore';
import type { FileNode } from '../../types';
import { cn } from '../../utils/cn';

const fileIcons: Record<string, React.ReactNode> = {
  ts: <FileCode className="w-4 h-4 text-blue-400" />,
  tsx: <FileCode className="w-4 h-4 text-blue-400" />,
  js: <FileCode className="w-4 h-4 text-yellow-400" />,
  jsx: <FileCode className="w-4 h-4 text-yellow-400" />,
  json: <FileJson className="w-4 h-4 text-yellow-500" />,
  css: <Hash className="w-4 h-4 text-pink-400" />,
  scss: <Hash className="w-4 h-4 text-pink-400" />,
  html: <FileCode className="w-4 h-4 text-orange-400" />,
  md: <FileText className="w-4 h-4 text-gray-400" />,
  png: <Image className="w-4 h-4 text-purple-400" />,
  jpg: <Image className="w-4 h-4 text-purple-400" />,
  svg: <Image className="w-4 h-4 text-purple-400" />,
  default: <File className="w-4 h-4 text-gray-400" />,
};

function getFileIcon(filename: string): React.ReactNode {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return fileIcons[ext] || fileIcons.default;
}

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
}

function FileTreeItem({ node, depth }: FileTreeItemProps) {
  const { toggleFolder, deleteFile } = useProjectStore();
  const { openTab } = useEditorStore();
  const [showMenu, setShowMenu] = useState(false);

  const handleClick = () => {
    if (node.type === 'folder') {
      toggleFolder(node.id);
    } else {
      openTab(node);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
  };

  return (
    <div className="relative">
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-gray-700/50 rounded group transition-colors',
          'text-gray-300 hover:text-white'
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Expand/Collapse Icon */}
        {node.type === 'folder' ? (
          <>
            <span className="w-4 h-4 flex items-center justify-center">
              {node.isOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
              )}
            </span>
            {node.isOpen ? (
              <FolderOpen className="w-4 h-4 text-yellow-500" />
            ) : (
              <Folder className="w-4 h-4 text-yellow-500" />
            )}
          </>
        ) : (
          <>
            <span className="w-4 h-4" />
            {getFileIcon(node.name)}
          </>
        )}

        <span className="flex-1 truncate text-sm">{node.name}</span>

        {/* Actions Menu */}
        <button
          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-600 rounded transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
        >
          <MoreVertical className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Context Menu */}
      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setShowMenu(false)}
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]">
            {node.type === 'folder' && (
              <>
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white">
                  <Plus className="w-3.5 h-3.5" />
                  New File
                </button>
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white">
                  <Folder className="w-3.5 h-3.5" />
                  New Folder
                </button>
                <div className="border-t border-gray-700 my-1" />
              </>
            )}
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white">
              <Edit3 className="w-3.5 h-3.5" />
              Rename
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-400 hover:bg-gray-700"
              onClick={() => {
                deleteFile(node.id);
                setShowMenu(false);
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </>
      )}

      {/* Children */}
      {node.type === 'folder' && node.isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree() {
  const { files } = useProjectStore();

  // Build tree structure
  const buildTree = (files: FileNode[]): FileNode[] => {
    // Sort: folders first, then alphabetically
    return [...files].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  };

  const tree = buildTree(files);

  if (tree.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-gray-500 text-sm">
        <Folder className="w-8 h-8 mb-2 opacity-50" />
        <p>No files yet</p>
      </div>
    );
  }

  return (
    <div className="py-2">
      {tree.map((node) => (
        <FileTreeItem key={node.id} node={node} depth={0} />
      ))}
    </div>
  );
}
