// ============================================
// AI CODE STUDIO - MOCK BACKEND FOR DEMO
// This simulates backend responses when no real backend is available
// ============================================

import { v4 as uuidv4 } from 'uuid';
import type { FileNode, Project, AgentStep, GitCommit } from '../types';

// Demo project structure
export const DEMO_PROJECT: Project = {
  id: 'demo-project-1',
  name: 'my-awesome-app',
  description: 'A full-stack web application',
  ownerId: 'demo-user-1',
  files: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export const DEMO_FILES: FileNode[] = [
  {
    id: 'folder-src',
    name: 'src',
    path: 'src',
    type: 'folder',
    projectId: DEMO_PROJECT.id,
    isOpen: true,
    children: [
      {
        id: 'file-app',
        name: 'App.tsx',
        path: 'src/App.tsx',
        type: 'file',
        projectId: DEMO_PROJECT.id,
        language: 'typescript',
        content: `import React, { useState } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';

export default function App() {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <Header onMenuClick={() => setIsOpen(!isOpen)} />
      <div className="flex">
        <Sidebar isOpen={isOpen} />
        <MainContent />
      </div>
    </div>
  );
}`,
      },
      {
        id: 'file-main',
        name: 'main.tsx',
        path: 'src/main.tsx',
        type: 'file',
        projectId: DEMO_PROJECT.id,
        language: 'typescript',
        content: `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`,
      },
      {
        id: 'file-css',
        name: 'index.css',
        path: 'src/index.css',
        type: 'file',
        projectId: DEMO_PROJECT.id,
        language: 'css',
        content: `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --primary: #6366f1;
  --secondary: #8b5cf6;
}

body {
  font-family: 'Inter', sans-serif;
}`,
      },
    ],
  },
  {
    id: 'folder-components',
    name: 'components',
    path: 'src/components',
    type: 'folder',
    projectId: DEMO_PROJECT.id,
    isOpen: false,
    children: [
      {
        id: 'file-header',
        name: 'Header.tsx',
        path: 'src/components/Header.tsx',
        type: 'file',
        projectId: DEMO_PROJECT.id,
        language: 'typescript',
        content: `import React from 'react';

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  return (
    <header className="h-14 bg-gray-800 border-b border-gray-700 flex items-center px-4">
      <button onClick={onMenuClick} className="p-2 hover:bg-gray-700 rounded">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <h1 className="ml-4 text-lg font-semibold">My App</h1>
    </header>
  );
}`,
      },
      {
        id: 'file-sidebar',
        name: 'Sidebar.tsx',
        path: 'src/components/Sidebar.tsx',
        type: 'file',
        projectId: DEMO_PROJECT.id,
        language: 'typescript',
        content: `import React from 'react';

interface SidebarProps {
  isOpen: boolean;
}

export function Sidebar({ isOpen }: SidebarProps) {
  if (!isOpen) return null;
  
  return (
    <aside className="w-64 bg-gray-800 h-[calc(100vh-56px)] p-4">
      <nav className="space-y-2">
        <a href="#" className="block px-4 py-2 rounded hover:bg-gray-700">Dashboard</a>
        <a href="#" className="block px-4 py-2 rounded hover:bg-gray-700">Projects</a>
        <a href="#" className="block px-4 py-2 rounded hover:bg-gray-700">Settings</a>
      </nav>
    </aside>
  );
}`,
      },
    ],
  },
  {
    id: 'file-package',
    name: 'package.json',
    path: 'package.json',
    type: 'file',
    projectId: DEMO_PROJECT.id,
    language: 'json',
    content: `{
  "name": "my-awesome-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^3.3.0",
    "typescript": "^5.0.0",
    "vite": "^4.4.0"
  }
}`,
  },
  {
    id: 'file-readme',
    name: 'README.md',
    path: 'README.md',
    type: 'file',
    projectId: DEMO_PROJECT.id,
    language: 'markdown',
    content: `# My Awesome App

A modern web application built with React, TypeScript, and Tailwind CSS.

## Features

- ⚡ Fast development with Vite
- 🎨 Beautiful UI with Tailwind CSS
- 📦 Type-safe with TypeScript
- 🔄 Hot module replacement

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Project Structure

\`\`\`
src/
├── components/     # React components
├── hooks/         # Custom hooks
├── utils/         # Utility functions
├── App.tsx        # Main app component
└── main.tsx       # Entry point
\`\`\`

## License

MIT
`,
  },
  {
    id: 'file-gitignore',
    name: '.gitignore',
    path: '.gitignore',
    type: 'file',
    projectId: DEMO_PROJECT.id,
    language: 'plaintext',
    content: `node_modules
dist
.env
.env.local
*.log
.DS_Store`,
  },
];

export const DEMO_COMMITS: GitCommit[] = [
  { hash: 'a1b2c3d', message: 'Initial commit', author: 'Demo User', date: '2024-01-15T10:00:00Z' },
  { hash: 'e4f5g6h', message: 'Add header component', author: 'Demo User', date: '2024-01-15T11:30:00Z' },
  { hash: 'i7j8k9l', message: 'Implement sidebar navigation', author: 'Demo User', date: '2024-01-15T14:00:00Z' },
  { hash: 'm0n1o2p', message: 'Add Tailwind CSS configuration', author: 'Demo User', date: '2024-01-16T09:00:00Z' },
  { hash: 'q3r4s5t', message: 'Update README documentation', author: 'Demo User', date: '2024-01-16T16:00:00Z' },
];

// Flatten files for easy access
export function flattenFiles(files: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  
  function traverse(nodes: FileNode[]) {
    for (const node of nodes) {
      result.push(node);
      if (node.children) {
        traverse(node.children);
      }
    }
  }
  
  traverse(files);
  return result;
}

// AI Response simulation
const AI_RESPONSES: Record<string, string[]> = {
  default: [
    "I'll help you with that! ",
    "Let me analyze your code... ",
    "Here's what I suggest:\n\n",
  ],
  explain: [
    "Let me explain this code:\n\n",
    "This code does the following:\n\n",
    "1. **Imports**: The component imports necessary dependencies.\n",
    "2. **State Management**: Uses React hooks for state.\n",
    "3. **Rendering**: Returns JSX with proper structure.\n\n",
    "The key concepts here are:\n",
    "- Component composition\n",
    "- Event handling\n",
    "- Conditional rendering\n",
  ],
  refactor: [
    "I've analyzed your code and here are my suggestions for refactoring:\n\n",
    "```typescript\n",
    "// Refactored version with improvements:\n",
    "import { memo, useCallback } from 'react';\n\n",
    "export const Component = memo(function Component({ props }) {\n",
    "  const handleClick = useCallback(() => {\n",
    "    // Optimized handler\n",
    "  }, []);\n\n",
    "  return <div onClick={handleClick}>...</div>;\n",
    "});\n",
    "```\n\n",
    "Key improvements:\n",
    "- Added memoization\n",
    "- Used useCallback for handlers\n",
    "- Improved type safety\n",
  ],
  fix: [
    "I found some issues in your code. Here's the fix:\n\n",
    "```typescript\n",
    "// Fixed version:\n",
    "const handleSubmit = async (e: FormEvent) => {\n",
    "  e.preventDefault(); // Added missing preventDefault\n",
    "  try {\n",
    "    await submitData(formData);\n",
    "  } catch (error) {\n",
    "    console.error('Submit failed:', error); // Added error handling\n",
    "  }\n",
    "};\n",
    "```\n",
  ],
  generate: [
    "I'll generate the code for you:\n\n",
    "```typescript\n",
    "import React, { useState, useEffect } from 'react';\n\n",
    "interface Props {\n",
    "  title: string;\n",
    "  onAction: () => void;\n",
    "}\n\n",
    "export function GeneratedComponent({ title, onAction }: Props) {\n",
    "  const [isLoading, setIsLoading] = useState(false);\n\n",
    "  useEffect(() => {\n",
    "    // Initialize component\n",
    "  }, []);\n\n",
    "  return (\n",
    "    <div className=\"p-4 rounded-lg bg-gray-800\">\n",
    "      <h2 className=\"text-xl font-bold\">{title}</h2>\n",
    "      <button\n",
    "        onClick={onAction}\n",
    "        className=\"mt-4 px-4 py-2 bg-indigo-600 rounded hover:bg-indigo-700\"\n",
    "      >\n",
    "        Click me\n",
    "      </button>\n",
    "    </div>\n",
    "  );\n",
    "}\n",
    "```\n",
  ],
};

// Simulate streaming AI response
export async function* simulateAIStream(
  _prompt: string,
  command?: string
): AsyncGenerator<string> {
  const responses = AI_RESPONSES[command || 'default'] || AI_RESPONSES.default;
  
  for (const chunk of responses) {
    for (const char of chunk) {
      await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 25));
      yield char;
    }
  }
}

// Simulate code completion
export async function simulateCompletion(
  prefix: string,
  _suffix: string,
  language: string
): Promise<string> {
  await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
  
  const completions: Record<string, string[]> = {
    typescript: [
      'const result = await fetch(url);',
      'return data.map(item => item.id);',
      '}: ${type}Props) => {',
      'useState<string>("")',
      'useEffect(() => {\n    // Effect logic\n  }, []);',
    ],
    javascript: [
      'const result = await fetch(url);',
      'return data.map(item => item.id);',
      '}) => {',
      'useState("")',
    ],
    python: [
      'def process_data(self, data):',
      'return [item for item in items]',
      'async with session.get(url) as response:',
    ],
    css: [
      'display: flex;\n  align-items: center;',
      'background: linear-gradient(to right, #6366f1, #8b5cf6);',
    ],
  };
  
  const langCompletions = completions[language] || completions.typescript;
  const completion = langCompletions[Math.floor(Math.random() * langCompletions.length)];
  
  // Try to make completion contextual
  if (prefix.includes('function') || prefix.includes('const')) {
    return completion;
  }
  
  return completion;
}

// Simulate code execution
export async function simulateCodeExecution(
  language: string,
  code: string
): Promise<{ stdout: string; stderr: string; exitCode: number; executionTimeMs: number }> {
  await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
  
  const startTime = Date.now();
  
  // Simple simulation based on language
  if (language === 'python') {
    if (code.includes('print')) {
      const match = code.match(/print\(['"](.+)['"]\)/);
      return {
        stdout: match ? `${match[1]}\n` : 'Output\n',
        stderr: '',
        exitCode: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
  
  if (language === 'javascript' || language === 'typescript') {
    if (code.includes('console.log')) {
      const match = code.match(/console\.log\(['"](.+)['"]\)/);
      return {
        stdout: match ? `${match[1]}\n` : 'Output\n',
        stderr: '',
        exitCode: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
  
  return {
    stdout: 'Program executed successfully.\n',
    stderr: '',
    exitCode: 0,
    executionTimeMs: Date.now() - startTime,
  };
}

// Simulate agent steps
export async function* simulateAgentExecution(goal: string): AsyncGenerator<AgentStep> {
  const steps: Omit<AgentStep, 'id'>[] = [
    { type: 'plan', description: `Analyzing goal: "${goal}"`, status: 'completed' },
    { type: 'plan', description: 'Creating project structure...', status: 'completed' },
    { type: 'create_file', description: 'Creating package.json', status: 'completed', result: 'Created package.json with dependencies' },
    { type: 'create_file', description: 'Creating src/App.tsx', status: 'completed', result: 'Created main App component' },
    { type: 'create_file', description: 'Creating src/index.css', status: 'completed', result: 'Added Tailwind CSS setup' },
    { type: 'install', description: 'Installing dependencies...', status: 'completed', result: 'npm install completed' },
    { type: 'run_command', description: 'Running build test', status: 'completed', result: 'Build successful' },
    { type: 'complete', description: 'Project created successfully!', status: 'completed' },
  ];
  
  for (const step of steps) {
    await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 1200));
    yield { ...step, id: uuidv4() };
  }
}

// Simulate browser agent
export async function simulateBrowserAgent(
  instruction: string,
  _startUrl?: string
): Promise<{ result: any; screenshot?: string }> {
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
  
  if (instruction.toLowerCase().includes('search')) {
    return {
      result: {
        action: 'search',
        query: instruction.replace(/search for/i, '').trim(),
        results: ['Result 1', 'Result 2', 'Result 3'],
      },
    };
  }
  
  if (instruction.toLowerCase().includes('click')) {
    return {
      result: {
        action: 'click',
        element: 'button',
        success: true,
      },
    };
  }
  
  return {
    result: {
      action: 'navigate',
      success: true,
      title: 'Page Title',
    },
  };
}
