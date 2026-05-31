// ============================================
// AI CODE STUDIO - UNIVERSAL AI ADAPTER
// Supports: OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, Qwen, Ollama, LM Studio
// ============================================

import { useSettingsStore } from '../stores/settingsStore';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onComplete: (fullText: string) => void;
  onError: (error: Error) => void;
}

export interface CompletionResult {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ============================================
// PROVIDER CONFIGURATIONS
// ============================================

interface ProviderConfig {
  formatRequest: (messages: Message[], model: string, options: RequestOptions) => any;
  formatHeaders: (apiKey: string) => Record<string, string>;
  parseResponse: (response: any) => string;
  parseStream: (chunk: string) => string | null;
  endpoint: (baseUrl: string, model?: string) => string;
}

interface RequestOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

const providers: Record<string, ProviderConfig> = {
  // OpenAI / OpenAI-compatible (Groq, DeepSeek, Mistral, Qwen, Ollama, LM Studio)
  openai: {
    formatRequest: (messages, model, options) => ({
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: options.stream ?? false,
    }),
    formatHeaders: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    parseResponse: (response) => response.choices?.[0]?.message?.content || '',
    parseStream: (chunk) => {
      if (chunk.startsWith('data: ')) {
        const data = chunk.slice(6);
        if (data === '[DONE]') return null;
        try {
          const parsed = JSON.parse(data);
          return parsed.choices?.[0]?.delta?.content || '';
        } catch {
          return '';
        }
      }
      return '';
    },
    endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  },

  // Anthropic (Claude)
  anthropic: {
    formatRequest: (messages, model, options) => {
      // Separate system message
      const systemMessage = messages.find(m => m.role === 'system');
      const otherMessages = messages.filter(m => m.role !== 'system');
      
      return {
        model,
        max_tokens: options.maxTokens ?? 4096,
        system: systemMessage?.content || 'You are a helpful AI coding assistant.',
        messages: otherMessages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        stream: options.stream ?? false,
      };
    },
    formatHeaders: (apiKey) => ({
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }),
    parseResponse: (response) => response.content?.[0]?.text || '',
    parseStream: (chunk) => {
      if (chunk.startsWith('data: ')) {
        const data = chunk.slice(6);
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            return parsed.delta?.text || '';
          }
        } catch {
          return '';
        }
      }
      return '';
    },
    endpoint: (baseUrl) => `${baseUrl}/messages`,
  },

  // Google (Gemini)
  google: {
    formatRequest: (messages, _model, options) => ({
      contents: messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096,
      },
      systemInstruction: messages.find(m => m.role === 'system')?.content 
        ? { parts: [{ text: messages.find(m => m.role === 'system')!.content }] }
        : undefined,
    }),
    formatHeaders: (_apiKey) => ({
      'Content-Type': 'application/json',
    }),
    parseResponse: (response) => response.candidates?.[0]?.content?.parts?.[0]?.text || '',
    parseStream: (chunk) => {
      try {
        const parsed = JSON.parse(chunk);
        return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch {
        return '';
      }
    },
    endpoint: (baseUrl, model) => `${baseUrl}/models/${model}:generateContent`,
  },
};

// Map provider IDs to their configurations
const providerMap: Record<string, string> = {
  openai: 'openai',
  groq: 'openai',
  deepseek: 'openai',
  mistral: 'openai',
  qwen: 'openai',
  zhipu: 'openai',
  ollama: 'openai',
  lmstudio: 'openai',
  anthropic: 'anthropic',
  google: 'google',
};

// ============================================
// AI ADAPTER CLASS
// ============================================

export class AIAdapter {
  private provider: string;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private config: ProviderConfig;

  constructor() {
    const settings = useSettingsStore.getState();
    this.provider = settings.provider;
    this.apiKey = settings.apiKey;
    this.model = settings.model;
    this.baseUrl = settings.baseUrl;
    this.config = providers[providerMap[this.provider] || 'openai'];
  }

  // Update settings from store
  refresh() {
    const settings = useSettingsStore.getState();
    this.provider = settings.provider;
    this.apiKey = settings.apiKey;
    this.model = settings.model;
    this.baseUrl = settings.baseUrl;
    this.config = providers[providerMap[this.provider] || 'openai'];
  }

  // Check if API key is configured
  isConfigured(): boolean {
    // Local providers don't need API key
    if (this.provider === 'ollama' || this.provider === 'lmstudio') {
      return true;
    }
    return Boolean(this.apiKey);
  }

  // Non-streaming chat completion
  async chat(messages: Message[], options: RequestOptions = {}): Promise<CompletionResult> {
    this.refresh();
    
    if (!this.isConfigured()) {
      throw new Error(`API key not configured for ${this.provider}`);
    }

    const endpoint = this.config.endpoint(this.baseUrl, this.model);
    const headers = this.config.formatHeaders(this.apiKey);
    const body = this.config.formatRequest(messages, this.model, { ...options, stream: false });

    // Add API key as query param for Google
    const url = this.provider === 'google' 
      ? `${endpoint}?key=${this.apiKey}`
      : endpoint;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `API request failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      text: this.config.parseResponse(data),
    };
  }

  // Streaming chat completion
  async streamChat(messages: Message[], callbacks: StreamCallbacks, options: RequestOptions = {}): Promise<void> {
    this.refresh();
    
    if (!this.isConfigured()) {
      callbacks.onError(new Error(`API key not configured for ${this.provider}`));
      return;
    }

    const endpoint = this.config.endpoint(this.baseUrl, this.model);
    const headers = this.config.formatHeaders(this.apiKey);
    const body = this.config.formatRequest(messages, this.model, { ...options, stream: true });

    // Add API key as query param for Google
    const url = this.provider === 'google' 
      ? `${endpoint}?key=${this.apiKey}&alt=sse`
      : endpoint;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `API request failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            const token = this.config.parseStream(line);
            if (token) {
              fullText += token;
              callbacks.onToken(token);
            }
          }
        }
      }

      callbacks.onComplete(fullText);
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Code completion (uses faster model if available)
  async complete(prefix: string, suffix: string, language: string): Promise<string> {
    this.refresh();

    const messages: Message[] = [
      {
        role: 'system',
        content: `You are a code completion AI. Complete the ${language} code at the cursor position. Return ONLY the completion text, no explanations, no markdown.`,
      },
      {
        role: 'user',
        content: `Complete this ${language} code:\n\n${prefix}<CURSOR>${suffix}\n\nReturn only the code that should replace <CURSOR>. Be concise.`,
      },
    ];

    // Use a faster/cheaper model for completions if available
    const completionModel = this.getCompletionModel();
    const originalModel = this.model;
    this.model = completionModel;

    try {
      const result = await this.chat(messages, {
        temperature: 0.1,
        maxTokens: 150,
      });
      return result.text.trim();
    } finally {
      this.model = originalModel;
    }
  }

  // Get the best model for fast completions
  private getCompletionModel(): string {
    const fastModels: Record<string, string> = {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-3-5-haiku-20241022',
      google: 'gemini-2.0-flash',
      groq: 'llama-3.1-8b-instant',
      deepseek: 'deepseek-chat',
      mistral: 'mistral-small-latest',
      qwen: 'qwen-turbo',
      zhipu: 'glm-4-flash',
      ollama: this.model,
      lmstudio: this.model,
    };
    return fastModels[this.provider] || this.model;
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

export const aiAdapter = new AIAdapter();

// ============================================
// HELPER FUNCTIONS
// ============================================

export async function chatWithAI(
  messages: Message[],
  onToken?: (token: string) => void
): Promise<string> {
  const settings = useSettingsStore.getState();
  
  if (settings.streaming && onToken) {
    return new Promise((resolve, reject) => {
      aiAdapter.streamChat(messages, {
        onToken,
        onComplete: resolve,
        onError: reject,
      }, {
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
      });
    });
  } else {
    const result = await aiAdapter.chat(messages, {
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    });
    return result.text;
  }
}

export async function getCodeCompletion(
  prefix: string,
  suffix: string,
  language: string
): Promise<string> {
  return aiAdapter.complete(prefix, suffix, language);
}
