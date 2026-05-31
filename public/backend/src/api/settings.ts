// ============================================
// AI CODE STUDIO - SETTINGS ROUTER
// Manages User Settings persisted inside the Database with AES encryption
// ============================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../index.js';
import { encrypt, decrypt } from '../utils/encryption.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  // Get user settings (Prisma database lookup with decryptions)
  fastify.get('/', {
    preHandler: [fastify.authenticate],
  }, async (request: any) => {
    const userId = request.user.userId;

    let settings = await prisma.userSettings.findUnique({
      where: { userId },
    });

    // Create default settings row in DB if not present yet
    if (!settings) {
      settings = await prisma.userSettings.create({
        data: {
          userId,
          provider: 'openai',
          model: 'gpt-4o',
          baseUrl: 'https://api.openai.com/v1',
          temperature: 0.7,
          maxTokens: 4096,
        },
      });
    }

    // Decrypt API key before returning to Client
    const decryptedApiKey = settings.apiKey ? decrypt(settings.apiKey) : '';

    return {
      settings: {
        ...settings,
        apiKey: decryptedApiKey,
      }
    };
  });

  // Update user settings (Prisma Database upsert with encryptions)
  fastify.put('/', {
    preHandler: [fastify.authenticate],
  }, async (request: any) => {
    const userId = request.user.userId;
    const data = request.body;

    // Encrypt the API Key before saving to Postgres/SQLite database
    const encryptedApiKey = data.apiKey ? encrypt(data.apiKey) : null;

    const settings = await prisma.userSettings.upsert({
      where: { userId },
      update: {
        provider: data.provider,
        apiKey: encryptedApiKey,
        model: data.model,
        baseUrl: data.baseUrl,
        temperature: parseFloat(data.temperature ?? 0.7),
        maxTokens: parseInt(data.maxTokens ?? 4096),
        fontSize: parseInt(data.fontSize ?? 14),
        tabSize: parseInt(data.tabSize ?? 2),
        wordWrap: Boolean(data.wordWrap),
        minimap: Boolean(data.minimap),
        lineNumbers: Boolean(data.lineNumbers),
        autoSave: Boolean(data.autoSave),
        autoComplete: Boolean(data.autoComplete),
        streaming: Boolean(data.streaming),
        theme: data.theme || 'dark',
      },
      create: {
        userId,
        provider: data.provider || 'openai',
        apiKey: encryptedApiKey,
        model: data.model || 'gpt-4o',
        baseUrl: data.baseUrl || 'https://api.openai.com/v1',
        temperature: parseFloat(data.temperature ?? 0.7),
        maxTokens: parseInt(data.maxTokens ?? 4096),
        fontSize: parseInt(data.fontSize ?? 14),
        tabSize: parseInt(data.tabSize ?? 2),
        wordWrap: Boolean(data.wordWrap),
        minimap: Boolean(data.minimap),
        lineNumbers: Boolean(data.lineNumbers),
        autoSave: Boolean(data.autoSave),
        autoComplete: Boolean(data.autoComplete),
        streaming: Boolean(data.streaming),
        theme: data.theme || 'dark',
      },
    });

    const decryptedApiKey = settings.apiKey ? decrypt(settings.apiKey) : '';

    return {
      settings: {
        ...settings,
        apiKey: decryptedApiKey,
      }
    };
  });

  // Validate API key
  fastify.post('/validate-key', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { provider, apiKey, baseUrl } = request.body as {
      provider: string;
      apiKey: string;
      baseUrl?: string;
    };

    try {
      const isValid = await validateApiKey(provider, apiKey, baseUrl);
      return { valid: isValid };
    } catch (error) {
      return { valid: false, error: String(error) };
    }
  });

  // Fetch available models dynamically
  fastify.post('/models', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { provider, apiKey, baseUrl } = request.body as {
      provider: string;
      apiKey: string;
      baseUrl?: string;
    };

    try {
      let models: string[] = [];

      if (provider === 'anthropic') {
        models = ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'];
      } else if (provider === 'ollama') {
        const url = `${baseUrl || 'http://localhost:11434'}/api/tags`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json() as any;
          if (Array.isArray(data.models)) {
            models = data.models.map((m: any) => m.name || m.id);
          }
        }
      } else if (provider === 'lmstudio') {
        const url = `${baseUrl || 'http://localhost:1234'}/v1/models`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json() as any;
          if (Array.isArray(data.data)) {
            models = data.data.map((m: any) => m.id);
          }
        }
      } else {
        // OpenAI-compatible / Zhipu API models endpoint
        const targetBaseUrl = baseUrl || getProviderBaseUrl(provider);
        const url = `${targetBaseUrl}/models`;
        const headers: any = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const res = await fetch(url, { headers });
        if (res.ok) {
          const data = await res.json() as any;
          if (Array.isArray(data.data)) {
            models = data.data.map((m: any) => m.id);
          }
        }
      }

      // Filter out empty or duplicate entries
      const uniqueModels = Array.from(new Set(models.filter(Boolean)));
      return { models: uniqueModels.length > 0 ? uniqueModels : getDefaultModels(provider) };
    } catch (error) {
      console.error('Fetch Models Error:', error);
      return { models: getDefaultModels(provider) };
    }
  });
}

// ============================================
// HELPERS
// ============================================

function getProviderBaseUrl(provider: string): string {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    deepseek: 'https://api.deepseek.com/v1',
    mistral: 'https://api.mistral.ai/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  };
  return urls[provider] || 'https://api.openai.com/v1';
}

function getDefaultModels(provider: string): string[] {
  const models: Record<string, string[]> = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    deepseek: ['deepseek-chat', 'deepseek-coder'],
    mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'open-mixtral-8x22b'],
    qwen: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-coder-plus'],
    zhipu: ['glm-5.1', 'glm-5v-turbo', 'glm-4-plus', 'glm-4-flash', 'glm-4-air', 'glm-4-long'],
    ollama: ['llama3.2', 'codellama', 'mistral', 'deepseek-coder', 'qwen2.5-coder'],
    lmstudio: ['local-model'],
  };
  return models[provider] || ['gpt-4o'];
}

async function validateApiKey(provider: string, apiKey: string, baseUrl?: string): Promise<boolean> {
  const testEndpoints: Record<string, { url: string; headers: Record<string, string>; body: any }> = {
    openai: {
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: null,
    },
    anthropic: {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: { model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    },
    groq: {
      url: 'https://api.groq.com/openai/v1/models',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: null,
    },
  };

  const config = testEndpoints[provider];
  if (!config) {
    if (provider === 'ollama' || provider === 'lmstudio') {
      return true;
    }
    return false;
  }

  try {
    const response = await fetch(config.url, {
      method: config.body ? 'POST' : 'GET',
      headers: config.headers,
      body: config.body ? JSON.stringify(config.body) : undefined,
    });

    return response.ok || response.status === 401 === false;
  } catch {
    return false;
  }
}
