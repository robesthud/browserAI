// ============================================
// AI CODE STUDIO - AGENT PANEL
// Real-time WebSocket ReAct Agent dashboard with rich animations
// ============================================

import React, { useState, useEffect, useRef } from 'react';
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
  StopCircle,
  Trash2
} from 'lucide-react';
import { useAgentStore, AgentStepUI } from '../../stores/useAgentStore';
import { useProjectStore, useEditorStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { wsService } from '../../services/websocket';
import { v4 as uuidv4 } from 'uuid';
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

const stepIcons: Record<string, React.ElementType> = {
  thought: Sparkles,
  action: Code2,
  observation: Eye,
  error: XCircle,
  complete: CheckCircle,
  plan: Sparkles,
  create_file: FileCode,
  edit_file: FileCode,
  run_command: Terminal,
  install: Package,
  browser: Globe,
};

function Eye(props: any) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function AgentPanel() {
  const [goal, setGoal] = useState('');
  const [showTemplates, setShowTemplates] = useState(true);
  
  // Figma states
  const [figmaUrl, setFigmaUrl] = useState('');
  const [figmaToken, setFigmaToken] = useState('');
  const [isFigmaLoading, setIsFigmaLoading] = useState(false);
  const [figmaError, setFigmaError] = useState('');
  const [figmaSuccess, setFigmaSuccess] = useState('');

  // Selected step details modal
  const [selectedStep, setSelectedStep] = useState<AgentStepUI | null>(null);

  const {
    currentTask,
    isRunning,
    setCurrentTask,
    addStep,
    updateStepStatus,
    completeTask,
    failTask,
    cancelTask,
    clearTask
  } = useAgentStore();

  const { addFile, currentProject } = useProjectStore();
  const { openTab } = useEditorStore();
  const stepsEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll as steps complete
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentTask?.steps]);

  // Connect & listen to WebSockets
  useEffect(() => {
    const unsubStep = wsService.on('agent:step', (data: any) => {
      // Step started
      addStep({
        id: data.stepId || data.id || uuidv4(),
        type: data.action || data.type || 'thought',
        description: data.content || data.description || 'Reasoning next action...',
        status: 'running',
        order: data.order || 0
      });
    });

    const unsubStepComplete = wsService.on('agent:step:complete', (data: any) => {
      updateStepStatus(
        data.stepId || data.id,
        data.status === 'error' ? 'error' : 'completed',
        data.content || data.result,
        data.error
      );
    });

    const unsubComplete = wsService.on('agent:complete', () => {
      completeTask();
    });

    const unsubError = wsService.on('agent:error', (data: any) => {
      failTask(data.error || 'Agent execution encountered an unhandled error.');
    });

    const unsubQueued = wsService.on('agent:queued', (data: any) => {
      setCurrentTask({
        id: data.taskId,
        goal: goal || 'Autonomous Design task',
        steps: [],
        status: 'pending',
        createdAt: new Date().toISOString()
      });
    });

    return () => {
      unsubStep();
      unsubStepComplete();
      unsubComplete();
      unsubError();
      unsubQueued();
    };
  }, [goal, addStep, updateStepStatus, completeTask, failTask, setCurrentTask]);

  const handleStartTask = () => {
    if (!goal.trim() || isRunning) return;

    setShowTemplates(false);
    const settings = useSettingsStore.getState();

    // Trigger Task on Backend via WS
    wsService.send('agent:task', {
      goal,
      config: {
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens
      }
    });
  };

  const handleCancelTask = () => {
    if (!currentTask) return;
    wsService.send('agent:cancel', { taskId: currentTask.id });
    cancelTask();
  };

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

  const handleTemplateSelect = (template: typeof PROJECT_TEMPLATES[0]) => {
    setGoal(`Create a ${template.name.toLowerCase()} project: ${template.description}`);
    setShowTemplates(false);
  };

  const completedSteps = currentTask?.steps.filter(s => s.status === 'completed') || [];
  const progressPercent = currentTask?.steps.length 
    ? Math.round((completedSteps.length / currentTask.steps.length) * 100) 
    : 0;

  return (
    <div className="flex flex-col h-full bg-gray-900 text-white relative">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800/60 backdrop-blur">
        <div className="flex items-center gap-2">
          <Rocket className="w-5 h-5 text-purple-400 animate-pulse" />
          <span className="font-semibold text-sm">Autonomous ReAct Agent</span>
        </div>
        
        {isRunning ? (
          <button
            onClick={handleCancelTask}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded text-xs font-semibold transition-all border border-red-500/30"
          >
            <StopCircle className="w-3.5 h-3.5" />
            Cancel Task
          </button>
        ) : currentTask && (
          <button
            onClick={clearTask}
            className="p-1.5 text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded transition-colors"
            title="Clear Task Session"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Progress Bar */}
      {currentTask && (
        <div className="bg-gray-850 px-4 py-2 border-b border-gray-700/60">
          <div className="flex justify-between text-xs text-gray-400 mb-1.5 font-mono">
            <span>Executing: {currentTask.status.toUpperCase()}</span>
            <span>{completedSteps.length} / {currentTask.steps.length} Steps ({progressPercent}%)</span>
          </div>
          <div className="w-full bg-gray-800 h-2 rounded-full overflow-hidden">
            <div 
              className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-500 ease-out" 
              style={{ width: `${progressPercent || 2}%` }}
            />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
        {!currentTask && showTemplates ? (
          <div className="space-y-4">
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-500/20">
                <Bot className="w-7 h-7 text-white" />
              </div>
              <h3 className="text-lg font-bold">Autonomous Project Agent</h3>
              <p className="text-xs text-gray-400 mt-1 max-w-xs mx-auto leading-relaxed">
                Describe your desired software features, and watch the agent create, edit, run, and test it!
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Quick Start Templates</p>
              {PROJECT_TEMPLATES.map((template) => {
                const Icon = template.icon;
                return (
                  <button
                    key={template.id}
                    className="w-full flex items-center gap-3 p-3 bg-gray-800 hover:bg-gray-750 rounded-xl border border-gray-700/40 hover:border-gray-600 transition-all text-left group"
                    onClick={() => handleTemplateSelect(template)}
                  >
                    <div className={cn(
                      'w-10 h-10 rounded-lg flex items-center justify-center bg-gray-900 border border-gray-700/40',
                      template.color
                    )}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-sm group-hover:text-indigo-400 transition-colors">{template.name}</div>
                      <div className="text-xs text-gray-400">{template.description}</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-500 group-hover:translate-x-0.5 transition-transform" />
                  </button>
                );
              })}
            </div>

            {/* Figma Importer Section */}
            <div className="bg-gray-800/80 rounded-2xl p-4 border border-gray-700/50 space-y-3.5">
              <div className="flex items-center gap-2 text-indigo-400">
                <Palette className="w-5 h-5" />
                <h4 className="font-bold text-xs uppercase tracking-wider text-white">Figma Design Importer</h4>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">
                Convert your Figma mockup into beautiful styled Tailwind React code automatically synced to your files!
              </p>

              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Figma File URL (e.g., https://figma.com/file/...)"
                  value={figmaUrl}
                  onChange={(e) => setFigmaUrl(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="password"
                  placeholder="Figma Personal Access Token"
                  value={figmaToken}
                  onChange={(e) => setFigmaToken(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
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
                  'w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-all shadow-md',
                  figmaUrl && figmaToken && !isFigmaLoading
                    ? 'bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white shadow-indigo-500/10'
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
            {/* Task Goal Display */}
            <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
              <div className="flex items-center gap-2 mb-1 text-xs text-purple-400 font-semibold uppercase tracking-wider">
                <Bot className="w-4 h-4" />
                <span>Active Objective</span>
              </div>
              <p className="text-sm text-gray-200 font-medium leading-relaxed">{currentTask.goal}</p>
            </div>

            {/* Step Trace Hierarchy */}
            <div className="space-y-3.5 relative">
              {currentTask.steps.map((step, index) => {
                const Icon = stepIcons[step.type] || Circle;
                const isLast = index === currentTask.steps.length - 1;
                
                return (
                  <div
                    key={step.id}
                    onClick={() => setSelectedStep(step)}
                    className={cn(
                      'relative pl-8 pb-1 group cursor-pointer transition-all duration-300 animate-fade-in-down',
                      step.status === 'running' && 'animate-pulse'
                    )}
                  >
                    {/* Connecting Timeline Line */}
                    {!isLast && (
                      <div className="absolute left-0 top-6 w-0.5 h-full bg-gray-700/60 ml-3" />
                    )}

                    {/* Timeline Dot Indicator */}
                    <div className={cn(
                      'absolute left-0 top-1.5 w-6 h-6 rounded-full flex items-center justify-center -translate-x-1/2 transition-colors border shadow',
                      step.status === 'completed' && 'bg-green-500/10 border-green-500 text-green-400',
                      step.status === 'running' && 'bg-blue-500/20 border-blue-400 text-blue-400 animate-pulse',
                      step.status === 'error' && 'bg-red-500/10 border-red-500 text-red-400',
                      step.status === 'pending' && 'bg-gray-800 border-gray-700 text-gray-500'
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

                    {/* Step Card */}
                    <div className={cn(
                      'bg-gray-800 rounded-xl p-3.5 ml-2 border transition-all duration-300 group-hover:border-gray-600',
                      step.status === 'running' ? 'border-blue-500/40 bg-blue-500/5 shadow-lg shadow-blue-500/5' : 'border-gray-700/50',
                      step.status === 'error' && 'border-red-500/30 bg-red-500/5'
                    )}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <Icon className={cn(
                            'w-4 h-4',
                            step.status === 'completed' && 'text-green-400',
                            step.status === 'running' && 'text-blue-400',
                            step.status === 'error' && 'text-red-400'
                          )} />
                          <span className="text-xs font-semibold text-gray-200 capitalize">{step.type.replace('_', ' ')}</span>
                        </div>
                        <span className="text-[10px] text-gray-500 font-mono">Step #{index + 1}</span>
                      </div>
                      
                      <p className="text-xs text-gray-300 font-medium leading-relaxed line-clamp-2">
                        {step.description}
                      </p>

                      {step.result && (
                        <div className="mt-2 text-[10px] text-gray-500 font-mono line-clamp-1 bg-gray-900/50 px-2 py-1 rounded border border-gray-700/30">
                          {step.result}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              <div ref={stepsEndRef} />
            </div>

            {/* Final Completion Summary Status Card */}
            {!isRunning && currentTask.status !== 'pending' && (
              <div className={cn(
                'p-4 rounded-xl border text-center space-y-1.5 shadow',
                currentTask.status === 'failed' 
                  ? 'bg-red-500/10 border-red-500/20 text-red-400'
                  : currentTask.status === 'cancelled'
                  ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400'
                  : 'bg-green-500/10 border-green-500/20 text-green-400'
              )}>
                <h4 className="font-bold text-sm">
                  {currentTask.status === 'failed' && 'Task Terminated with Error'}
                  {currentTask.status === 'cancelled' && 'Task Suspended by User'}
                  {currentTask.status === 'completed' && 'Objective Reached Successfully!'}
                </h4>
                <p className="text-xs text-gray-400 max-w-xs mx-auto leading-relaxed">
                  {currentTask.status === 'completed' 
                    ? 'All operations and test conditions validated successfully.'
                    : 'Execution chain terminated. Read steps detail or restart task.'}
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-700 bg-gray-800/20">
        <div className="flex gap-2">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleStartTask();
              }
            }}
            placeholder="Describe what you want the Autonomous Agent to build..."
            className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-xl text-xs text-white placeholder-gray-500 resize-none focus:outline-none focus:border-purple-500 scrollbar-thin h-12"
            disabled={isRunning}
          />
          <button
            onClick={handleStartTask}
            disabled={!goal.trim() || isRunning}
            className={cn(
              'px-4 rounded-xl transition-all shadow-md',
              goal.trim() && !isRunning
                ? 'bg-gradient-to-r from-purple-500 to-indigo-500 hover:from-purple-600 hover:to-indigo-600 text-white shadow-purple-500/10'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed border border-gray-700/60'
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

      {/* Detail Step Modal */}
      {selectedStep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/85 backdrop-blur-sm" 
            onClick={() => setSelectedStep(null)} 
          />
          <div className="bg-gray-800 rounded-2xl border border-gray-700 p-5 max-w-lg w-full z-10 relative flex flex-col max-h-[80vh] shadow-2xl animate-scale-in">
            <h3 className="text-sm font-bold text-gray-200 capitalize mb-3 flex items-center gap-2">
              <Bot className="w-4 h-4 text-purple-400" />
              <span>Step Execution details</span>
            </h3>
            
            <div className="flex-1 overflow-y-auto space-y-4 text-xs font-medium leading-relaxed pr-2">
              <div>
                <span className="text-gray-500 block mb-1">DESCRIPTION:</span>
                <p className="bg-gray-900/50 p-3 rounded-lg border border-gray-700/30 text-gray-300 font-mono">
                  {selectedStep.description}
                </p>
              </div>

              {selectedStep.result && (
                <div>
                  <span className="text-gray-500 block mb-1">OBSERVATION / RESULT:</span>
                  <pre className="bg-gray-900 p-3.5 rounded-lg border border-gray-700/50 text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap max-h-60">
                    {selectedStep.result}
                  </pre>
                </div>
              )}

              {selectedStep.error && (
                <div>
                  <span className="text-red-400 block mb-1">ERROR OUTPUT:</span>
                  <pre className="bg-red-950/20 border border-red-500/20 p-3.5 rounded-lg text-red-400 font-mono overflow-x-auto whitespace-pre-wrap max-h-60">
                    {selectedStep.error}
                  </pre>
                </div>
              )}
            </div>

            <button
              onClick={() => setSelectedStep(null)}
              className="mt-4 w-full bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-xl text-xs font-bold transition-colors"
            >
              Close Details
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
