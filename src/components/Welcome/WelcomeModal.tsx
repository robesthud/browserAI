// ============================================
// AI CODE STUDIO - WELCOME MODAL
// ============================================

import { useState, useEffect } from 'react';
import {
  X,
  Zap,
  Code2,
  MessageSquare,
  Rocket,
  Globe,
  Terminal,
  Users,
  Keyboard,
} from 'lucide-react';
import { cn } from '../../utils/cn';

interface WelcomeModalProps {
  onClose: () => void;
}

const features = [
  {
    icon: Code2,
    title: 'Smart Editor',
    description: 'Monaco-based editor with AI-powered autocomplete',
    color: 'text-blue-400',
  },
  {
    icon: MessageSquare,
    title: 'AI Chat',
    description: 'Ask questions, refactor code, fix bugs with AI',
    color: 'text-indigo-400',
  },
  {
    icon: Rocket,
    title: 'AI Agent',
    description: 'Generate entire projects from descriptions',
    color: 'text-purple-400',
  },
  {
    icon: Globe,
    title: 'Browser AI',
    description: 'Automate web tasks with natural language',
    color: 'text-cyan-400',
  },
  {
    icon: Terminal,
    title: 'Terminal',
    description: 'Run code and commands in the browser',
    color: 'text-green-400',
  },
  {
    icon: Users,
    title: 'Collaboration',
    description: 'Real-time editing with multiple users',
    color: 'text-pink-400',
  },
];

const shortcuts = [
  { keys: ['Ctrl', 'S'], action: 'Save file' },
  { keys: ['Ctrl', 'P'], action: 'Quick open' },
  { keys: ['Ctrl', '`'], action: 'Toggle terminal' },
  { keys: ['Ctrl', 'Shift', 'P'], action: 'Command palette' },
  { keys: ['Ctrl', '/'], action: 'Toggle comment' },
  { keys: ['Tab'], action: 'Accept AI completion' },
];

export function WelcomeModal({ onClose }: WelcomeModalProps) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' || e.key === 'ArrowRight') {
        if (step < 2) setStep(step + 1);
        else onClose();
      }
      if (e.key === 'ArrowLeft' && step > 0) setStep(step - 1);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [step, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-2xl mx-4 bg-gray-900 rounded-2xl border border-gray-700 shadow-2xl overflow-hidden">
        {/* Close button */}
        <button
          className="absolute top-4 right-4 p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors z-10"
          onClick={onClose}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Content */}
        <div className="p-8">
          {step === 0 && (
            <div className="animate-fade-in">
              {/* Logo */}
              <div className="flex items-center justify-center mb-6">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
                  <Zap className="w-8 h-8 text-white" />
                </div>
              </div>

              <h1 className="text-3xl font-bold text-center mb-2">
                Welcome to AI Code Studio
              </h1>
              <p className="text-gray-400 text-center mb-8">
                Your AI-powered development environment
              </p>

              {/* Features Grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
                {features.map((feature) => {
                  const Icon = feature.icon;
                  return (
                    <div
                      key={feature.title}
                      className="p-4 bg-gray-800/50 rounded-xl border border-gray-700/50 hover:border-gray-600 transition-colors"
                    >
                      <Icon className={cn('w-6 h-6 mb-2', feature.color)} />
                      <h3 className="font-medium mb-1">{feature.title}</h3>
                      <p className="text-xs text-gray-500">{feature.description}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="animate-fade-in">
              <div className="flex items-center justify-center mb-6">
                <Keyboard className="w-12 h-12 text-indigo-400" />
              </div>

              <h2 className="text-2xl font-bold text-center mb-2">
                Keyboard Shortcuts
              </h2>
              <p className="text-gray-400 text-center mb-8">
                Speed up your workflow with these shortcuts
              </p>

              <div className="grid grid-cols-2 gap-3">
                {shortcuts.map((shortcut, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg"
                  >
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, j) => (
                        <kbd
                          key={j}
                          className="px-2 py-1 bg-gray-700 rounded text-xs font-mono"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                    <span className="text-sm text-gray-400">{shortcut.action}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="animate-fade-in text-center">
              <div className="flex items-center justify-center mb-6">
                <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
                  <Rocket className="w-8 h-8 text-green-400" />
                </div>
              </div>

              <h2 className="text-2xl font-bold mb-2">You're All Set!</h2>
              <p className="text-gray-400 mb-8">
                Start coding with AI assistance
              </p>

              <div className="space-y-4 text-left bg-gray-800/50 rounded-xl p-6">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs text-indigo-400">1</span>
                  </div>
                  <div>
                    <p className="font-medium">Open a file from the sidebar</p>
                    <p className="text-sm text-gray-500">Click on any file to start editing</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs text-indigo-400">2</span>
                  </div>
                  <div>
                    <p className="font-medium">Use AI commands in chat</p>
                    <p className="text-sm text-gray-500">Try /generate, /refactor, /explain, or /fix</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs text-indigo-400">3</span>
                  </div>
                  <div>
                    <p className="font-medium">Generate projects with Agent</p>
                    <p className="text-sm text-gray-500">Describe what you want to build</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-4 bg-gray-800/50 border-t border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {[0, 1, 2].map((i) => (
              <button
                key={i}
                className={cn(
                  'w-2 h-2 rounded-full transition-colors',
                  step === i ? 'bg-indigo-500' : 'bg-gray-600 hover:bg-gray-500'
                )}
                onClick={() => setStep(i)}
              />
            ))}
          </div>

          <div className="flex items-center gap-3">
            {step > 0 && (
              <button
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                onClick={() => setStep(step - 1)}
              >
                Back
              </button>
            )}
            <button
              className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-medium transition-colors"
              onClick={() => {
                if (step < 2) setStep(step + 1);
                else onClose();
              }}
            >
              {step < 2 ? 'Next' : 'Get Started'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
