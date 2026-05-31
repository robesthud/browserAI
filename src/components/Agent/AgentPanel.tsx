// ============================================
// AI CODE STUDIO - AGENT PANEL
// ============================================

import { useState } from 'react';
import {
  Bot,
  Send,
  CheckCircle,
  Circle,
  Loader2,
  XCircle,
  FileCode,
  Terminal,
  Package,
  Globe,
  Sparkles,
  ChevronRight,
  Rocket,
  Code2,
  Palette,
  Server,
} from 'lucide-react';
import { useAgentStore, useProjectStore, useEditorStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { simulateAgentExecution } from '../../services/mockBackend';
import { v4 as uuidv4 } from 'uuid';
import type { AgentStep } from '../../types';
import { cn } from '../../utils/cn';

const PROJECT_TEMPLATES = [
  { 
    id: 'react', 
    name: 'React App', 
    icon: Code2, 
    color: 'text-cyan-400',
    description: 'Modern React with TypeScript & Tailwind'
  },
  { 
    id: 'next', 
    name: 'Next.js App', 
    icon: Globe, 
    color: 'text-white',
    description: 'Full-stack Next.js application'
  },
  { 
    id: 'api', 
    name: 'REST API', 
    icon: Server, 
    color: 'text-green-400',
    description: 'Node.js API with Express/Fastify'
  },
  { 
    id: 'landing', 
    name: 'Landing Page', 
    icon: Palette, 
    color: 'text-pink-400',
    description: 'Beautiful landing page template'
  },
];

const stepIcons: Record<AgentStep['type'], React.ElementType> = {
  plan: Sparkles,
  create_file: FileCode,
  edit_file: FileCode,
  run_command: Terminal,
  install: Package,
  browser: Globe,
  complete: CheckCircle,
};

export function AgentPanel() {
  const [goal, setGoal] = useState('');
  const [showTemplates, setShowTemplates] = useState(true);
  
  // Figma states
  const [figmaUrl, setFigmaUrl] = useState('');
  const [figmaToken, setFigmaToken] = useState('');
  const [isFigmaLoading, setIsFigmaLoading] = useState(false);
  const [figmaError, setFigmaError] = useState('');
  const [figmaSuccess, setFigmaSuccess] = useState('');

  const { currentTask, isRunning, createTask, addStep, updateStepStatus, setRunning } = useAgentStore();
  const { addFile, currentProject } = useProjectStore();
  const { openTab } = useEditorStore();

  const handleFigmaConvert = async () => {
    if (!figmaUrl || !figmaToken) {
      setFigmaError('Figma File URL and Token are required.');
      return;
    }

    setIsFigmaLoading(true);
    setFigmaError('');
    setFigmaSuccess('');

    const settings = useSettingsStore.getState();

    try {
      const response = await fetch('/api/figma/generate-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`,
        },
        body: JSON.stringify({
          figmaUrl,
          personalToken: figmaToken,
          aiConfig: {
            provider: settings.provider,
            apiKey: settings.apiKey,
            model: settings.model,
            baseUrl: settings.baseUrl,
            temperature: settings.temperature,
            maxTokens: settings.maxTokens,
          }
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate code from Figma');
      }

      const data = await response.json();
      
      // Create a file in the workspace
      const newFileId = uuidv4();
      const path = `src/components/${data.documentName.replace(/\s+/g, '') || 'FigmaDesign'}.tsx`;
      const name = path.split('/').pop()!;
      
      const fileObj = {
        id: newFileId,
        projectId: currentProject?.id || 'demo-project-1',
        path,
        name,
        type: 'file' as const,
        content: data.code,
        language: 'typescript',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      addFile(fileObj);
      openTab(fileObj);

      setFigmaSuccess(`Successfully imported Design as ${path}!`);
      setFigmaUrl('');
    } catch (err: any) {
      setFigmaError(err.message || String(err));
    } finally {
      setIsFigmaLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!goal.trim() || isRunning) return;

    setShowTemplates(false);
    const task = createTask(goal);
    setRunning(true);
    setGoal('');

    try {
      const stream = simulateAgentExecution(goal);
      for await (const step of stream) {
        addStep(task.id, step);
        
        // Simulate step completion after a delay
        await new Promise(resolve => setTimeout(resolve, 500));
        updateStepStatus(task.id, step.id, 'completed', step.result);
      }
    } catch (error) {
      addStep(task.id, {
        id: uuidv4(),
        type: 'complete',
        description: 'Task failed',
        status: 'error',
        error: String(error),
      });
    }

    setRunning(false);
  };

  const handleTemplateSelect = (template: typeof PROJECT_TEMPLATES[0]) => {
    setGoal(`Create a ${template.name.toLowerCase()} project: ${template.description}`);
    setShowTemplates(false);
  };

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Rocket className="w-5 h-5 text-purple-400" />
          <span className="font-medium">AI Agent</span>
        </div>
        {isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-purple-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Working...
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
        {!currentTask && showTemplates ? (
          <div className="space-y-4">
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center">
                <Bot className="w-7 h-7 text-white" />
              </div>
              <h3 className="text-lg font-semibold">AI Project Agent</h3>
              <p className="text-sm text-gray-500 mt-1">
                Describe what you want to build and I'll create it
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Quick Start Templates</p>
              {PROJECT_TEMPLATES.map((template) => {
                const Icon = template.icon;
                return (
                  <button
                    key={template.id}
                    className="w-full flex items-center gap-3 p-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-left"
                    onClick={() => handleTemplateSelect(template)}
                  >
                    <div className={cn(
                      'w-10 h-10 rounded-lg flex items-center justify-center bg-gray-700',
                      template.color
                    )}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-sm">{template.name}</div>
                      <div className="text-xs text-gray-500">{template.description}</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-500" />
                  </button>
                );
              })}
            </div>

            {/* Figma Importer Section */}
            <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50 space-y-3">
              <div className="flex items-center gap-2 text-indigo-400">
                <Palette className="w-5 h-5" />
                <h4 className="font-semibold text-sm text-white">Figma Design Importer</h4>
              </div>
              <p className="text-xs text-gray-400">
                Paste your Figma File URL and Token to generate premium styled Tailwind React components directly into your active project workspace!
              </p>

              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Figma File URL (e.g., https://figma.com/file/...)"
                  value={figmaUrl}
                  onChange={(e) => setFigmaUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="password"
                  placeholder="Figma Personal Access Token"
                  value={figmaToken}
                  onChange={(e) => setFigmaToken(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {figmaError && (
                <div className="text-xs text-red-400 font-medium">
                  ⚠️ {figmaError}
                </div>
              )}

              {figmaSuccess && (
                <div className="text-xs text-green-400 font-medium">
                  🎉 {figmaSuccess}
                </div>
              )}

              <button
                onClick={handleFigmaConvert}
                disabled={isFigmaLoading || !figmaUrl || !figmaToken}
                className={cn(
                  'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-semibold transition-colors',
                  figmaUrl && figmaToken && !isFigmaLoading
                    ? 'bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white'
                    : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                )}
              >
                {isFigmaLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating React Code...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Convert Design to React
                  </>
                )}
              </button>
            </div>
          </div>
        ) : currentTask ? (
          <div className="space-y-4">
            {/* Task Header */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Bot className="w-5 h-5 text-purple-400" />
                <span className="font-medium">Task</span>
              </div>
              <p className="text-sm text-gray-300">{currentTask.goal}</p>
            </div>

            {/* Steps */}
            <div className="space-y-2">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Progress</p>
              {currentTask.steps.map((step, index) => {
                const Icon = stepIcons[step.type] || Circle;
                const isLast = index === currentTask.steps.length - 1;
                
                return (
                  <div
                    key={step.id}
                    className={cn(
                      'relative pl-8 pb-4',
                      !isLast && 'border-l-2 border-gray-700 ml-3'
                    )}
                  >
                    {/* Status Icon */}
                    <div className={cn(
                      'absolute left-0 top-0 w-6 h-6 rounded-full flex items-center justify-center -translate-x-1/2',
                      step.status === 'completed' && 'bg-green-500/20 text-green-400',
                      step.status === 'running' && 'bg-purple-500/20 text-purple-400',
                      step.status === 'error' && 'bg-red-500/20 text-red-400',
                      step.status === 'pending' && 'bg-gray-700 text-gray-500'
                    )}>
                      {step.status === 'running' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : step.status === 'error' ? (
                        <XCircle className="w-3.5 h-3.5" />
                      ) : step.status === 'completed' ? (
                        <CheckCircle className="w-3.5 h-3.5" />
                      ) : (
                        <Circle className="w-3.5 h-3.5" />
                      )}
                    </div>

                    {/* Step Content */}
                    <div className={cn(
                      'bg-gray-800 rounded-lg p-3 ml-2',
                      step.status === 'running' && 'ring-1 ring-purple-500/50'
                    )}>
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="w-4 h-4 text-gray-400" />
                        <span className="text-sm font-medium">{step.description}</span>
                      </div>
                      
                      {step.result && (
                        <p className="text-xs text-gray-500 mt-1">{step.result}</p>
                      )}
                      
                      {step.error && (
                        <p className="text-xs text-red-400 mt-1">{step.error}</p>
                      )}
                    </div>
                  </div>
                );
              })}

              {isRunning && (
                <div className="flex items-center gap-2 text-sm text-gray-500 pl-4">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Working on next step...</span>
                </div>
              )}
            </div>

            {/* Completion Summary */}
            {!isRunning && currentTask.steps.length > 0 && (
              <div className={cn(
                'p-4 rounded-lg',
                currentTask.status === 'error' 
                  ? 'bg-red-500/10 border border-red-500/20'
                  : 'bg-green-500/10 border border-green-500/20'
              )}>
                <div className="flex items-center gap-2">
                  {currentTask.status === 'error' ? (
                    <>
                      <XCircle className="w-5 h-5 text-red-400" />
                      <span className="text-red-400 font-medium">Task failed</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-5 h-5 text-green-400" />
                      <span className="text-green-400 font-medium">Task completed</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-700">
        <div className="flex gap-2">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Describe what you want to build..."
            className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-purple-500 scrollbar-thin"
            rows={2}
            disabled={isRunning}
          />
          <button
            onClick={handleSubmit}
            disabled={!goal.trim() || isRunning}
            className={cn(
              'px-4 rounded-lg transition-colors',
              goal.trim() && !isRunning
                ? 'bg-purple-600 hover:bg-purple-700 text-white'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'
            )}
          >
            {isRunning ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
