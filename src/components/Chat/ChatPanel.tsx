// ============================================
// AI CODE STUDIO - CHAT PANEL
// ============================================

import { useState, useRef, useEffect } from 'react';
import {
  Send,
  Bot,
  User,
  Copy,
  Check,
  RefreshCw,
  Sparkles,
  MessageSquare,
  Wand2,
  Bug,
  FileCode,
  TestTube,
} from 'lucide-react';
import { useChatStore, useEditorStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { chatWithAI, type Message } from '../../services/aiAdapter';
import { simulateAIStream } from '../../services/mockBackend';
import { v4 as uuidv4 } from 'uuid';
import { cn } from '../../utils/cn';

const AI_COMMANDS = [
  { name: '/generate', icon: Wand2, description: 'Generate new code', color: 'text-purple-400' },
  { name: '/refactor', icon: RefreshCw, description: 'Refactor selected code', color: 'text-blue-400' },
  { name: '/explain', icon: MessageSquare, description: 'Explain code', color: 'text-green-400' },
  { name: '/fix', icon: Bug, description: 'Fix bugs in code', color: 'text-red-400' },
  { name: '/test', icon: TestTube, description: 'Generate tests', color: 'text-yellow-400' },
  { name: '/doc', icon: FileCode, description: 'Generate documentation', color: 'text-cyan-400' },
  { name: '/review', icon: MessageSquare, description: 'Code review', color: 'text-orange-400' },
];

export function ChatPanel() {
  const [input, setInput] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  
  const { messages, isStreaming, addMessage, appendToMessage, setStreaming } = useChatStore();
  const { tabs, activeTabId } = useEditorStore();

  const activeTab = tabs.find(t => t.id === activeTabId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (input.startsWith('/')) {
      setShowCommands(true);
    } else {
      setShowCommands(false);
    }
  }, [input]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();
    setInput('');
    setShowCommands(false);

    // Determine command type
    let command: string | undefined;
    let prompt = userMessage;
    
    for (const cmd of AI_COMMANDS) {
      if (userMessage.startsWith(cmd.name)) {
        command = cmd.name.slice(1);
        prompt = userMessage.slice(cmd.name.length).trim() || `${command} the code`;
        break;
      }
    }

    // Build system message based on command
    const systemMessages: Record<string, string> = {
      generate: 'You are an expert code generator. Create clean, well-commented code based on the user\'s description.',
      refactor: 'You are an expert code refactorer. Improve the given code for readability, performance, and best practices.',
      explain: 'You are a helpful coding teacher. Explain the given code clearly and thoroughly.',
      fix: 'You are an expert debugger. Find and fix bugs in the given code. Explain what was wrong.',
      test: 'You are a testing expert. Generate comprehensive unit tests for the given code.',
      doc: 'You are a documentation expert. Generate clear documentation for the given code.',
      review: 'You are a senior code reviewer. Review the code and suggest improvements.',
    };

    const systemPrompt = command 
      ? systemMessages[command] || 'You are a helpful AI coding assistant.'
      : 'You are a helpful AI coding assistant. Help users write, debug, and understand code.';

    // Add context if we have an active file
    let fullPrompt = prompt;
    if (activeTab && (command === 'refactor' || command === 'explain' || command === 'fix' || command === 'test' || command === 'doc' || command === 'review')) {
      fullPrompt = `${prompt}\n\nCode context (${activeTab.name}):\n\`\`\`${activeTab.language}\n${activeTab.content.slice(0, 4000)}\n\`\`\``;
    }

    // Add user message
    addMessage({
      id: uuidv4(),
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    // Create assistant message placeholder
    const assistantId = uuidv4();
    addMessage({
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
    });

    setStreaming(true);

    // Check if we have API key configured
    const settings = useSettingsStore.getState();
    const hasApiKey = settings.apiKey || settings.provider === 'ollama' || settings.provider === 'lmstudio';

    try {
      if (hasApiKey) {
        // Use real AI adapter
        const aiMessages: Message[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: fullPrompt },
        ];

        await chatWithAI(aiMessages, (token) => {
          appendToMessage(assistantId, token);
        });
      } else {
        // Fallback to simulation for demo
        const stream = simulateAIStream(prompt, command);
        for await (const chunk of stream) {
          appendToMessage(assistantId, chunk);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      appendToMessage(assistantId, `\n\n⚠️ Error: ${errorMessage}\n\nPlease check your API key in Settings.`);
    }

    setStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCommandSelect = (cmd: string) => {
    setInput(cmd + ' ');
    setShowCommands(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-400" />
          <span className="font-medium">AI Assistant</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">GPT-4</span>
          <div className="w-2 h-2 rounded-full bg-green-500" />
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
        {messages.length === 0 ? (
          <EmptyChat onCommandSelect={handleCommandSelect} />
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                'flex gap-3',
                message.role === 'user' ? 'justify-end' : 'justify-start'
              )}
            >
              {message.role === 'assistant' && (
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
                  <Bot className="w-5 h-5" />
                </div>
              )}
              
              <div
                className={cn(
                  'max-w-[85%] rounded-lg px-4 py-3',
                  message.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-100'
                )}
              >
                {message.role === 'assistant' ? (
                  <div className="prose prose-invert prose-sm max-w-none">
                    <MessageContent content={message.content} messageId={message.id} />
                    {message.isStreaming && (
                      <span className="inline-block w-2 h-4 bg-indigo-400 animate-pulse ml-1" />
                    )}
                  </div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                )}
              </div>

              {message.role === 'user' && (
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center">
                  <User className="w-5 h-5" />
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Command Suggestions */}
      {showCommands && (
        <div className="px-4 pb-2">
          <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            {AI_COMMANDS.filter(cmd => 
              cmd.name.toLowerCase().includes(input.toLowerCase())
            ).map((cmd) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.name}
                  className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-700 transition-colors"
                  onClick={() => handleCommandSelect(cmd.name)}
                >
                  <Icon className={cn('w-4 h-4', cmd.color)} />
                  <span className="font-mono text-sm">{cmd.name}</span>
                  <span className="text-xs text-gray-500">{cmd.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="p-4 border-t border-gray-700">
        {activeTab && (
          <div className="flex items-center gap-2 mb-2 text-xs text-gray-500">
            <FileCode className="w-3.5 h-3.5" />
            <span>Context: {activeTab.name}</span>
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI anything... (use /commands for actions)"
            className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-indigo-500 scrollbar-thin"
            rows={1}
            disabled={isStreaming}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className={cn(
              'px-4 rounded-lg transition-colors',
              input.trim() && !isStreaming
                ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'
            )}
          >
            {isStreaming ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageContent({ content, messageId }: { content: string; messageId: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  // Simple markdown-like rendering
  const parts = content.split(/(```[\s\S]*?```)/g);
  
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const match = part.match(/```(\w+)?\n([\s\S]*?)```/);
          if (match) {
            const language = match[1] || 'plaintext';
            const code = match[2].trim();
            const blockId = `${messageId}-${i}`;
            
            return (
              <div key={i} className="relative my-2 group">
                <div className="flex items-center justify-between bg-gray-900 px-3 py-1 rounded-t border border-gray-700 border-b-0">
                  <span className="text-xs text-gray-500">{language}</span>
                  <button
                    className="p-1 text-gray-500 hover:text-white transition-colors"
                    onClick={() => {
                      navigator.clipboard.writeText(code);
                      setCopiedId(blockId);
                      setTimeout(() => setCopiedId(null), 2000);
                    }}
                  >
                    {copiedId === blockId ? (
                      <Check className="w-3.5 h-3.5 text-green-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
                <pre className="bg-gray-900 p-3 rounded-b border border-gray-700 border-t-0 overflow-x-auto">
                  <code className="text-sm font-mono">{code}</code>
                </pre>
              </div>
            );
          }
        }
        
        // Render plain text with basic formatting
        return (
          <span key={i} className="whitespace-pre-wrap">
            {part.split(/(\*\*.*?\*\*)/g).map((segment, j) => {
              if (segment.startsWith('**') && segment.endsWith('**')) {
                return <strong key={j}>{segment.slice(2, -2)}</strong>;
              }
              return segment;
            })}
          </span>
        );
      })}
    </>
  );
}

function EmptyChat({ onCommandSelect }: { onCommandSelect: (cmd: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-4">
        <Sparkles className="w-8 h-8 text-white" />
      </div>
      <h3 className="text-lg font-semibold mb-2">AI Code Assistant</h3>
      <p className="text-sm text-gray-500 mb-6 max-w-sm">
        I can help you write, refactor, explain, and debug code. Try one of these commands:
      </p>
      
      <div className="grid grid-cols-1 gap-2 w-full max-w-sm">
        {AI_COMMANDS.map((cmd) => {
          const Icon = cmd.icon;
          return (
            <button
              key={cmd.name}
              className="flex items-center gap-3 px-4 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-left"
              onClick={() => onCommandSelect(cmd.name)}
            >
              <Icon className={cn('w-5 h-5', cmd.color)} />
              <div>
                <div className="font-mono text-sm">{cmd.name}</div>
                <div className="text-xs text-gray-500">{cmd.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
