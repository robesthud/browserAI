// ============================================
// AI CODE STUDIO - SETTINGS ROUTES
// ============================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../index.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  // Get user settings
  fastify.get('/', {
    preHandler: [fastify.authenticate],
  }, async (request: any) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { settings: true },
    });

    return { settings: user?.settings ? JSON.parse(user.settings) : getDefaultSettings() };
  });

  // Update user settings
  fastify.put('/', {
    preHandler: [fastify.authenticate],
  }, async (request: any) => {
    const settings = request.body;

    // Validate settings
    const validatedSettings = validateSettings(settings);

    await prisma.user.update({
      where: { id: request.user.userId },
      data: { settings: JSON.stringify(validatedSettings) },
    });

    return { settings: validatedSettings };
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
}

// ============================================
// HELPERS
// ============================================

function getDefaultSettings() {
  return {
    // AI Settings
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 4096,
    
    // Editor Settings
    fontSize: 14,
    tabSize: 2,
    wordWrap: true,
    minimap: true,
    lineNumbers: true,
    autoSave: true,
    autoComplete: true,
    streaming: true,
    
    // Appearance
    theme: 'dark',
  };
}

function validateSettings(settings: any) {
  const defaults = getDefaultSettings();
  
  return {
    provider: settings.provider || defaults.provider,
    model: settings.model || defaults.model,
    temperature: Math.min(Math.max(settings.temperature ?? defaults.temperature, 0), 1),
    maxTokens: Math.min(Math.max(settings.maxTokens ?? defaults.maxTokens, 100), 32000),
    fontSize: Math.min(Math.max(settings.fontSize ?? defaults.fontSize, 10), 24),
    tabSize: Math.min(Math.max(settings.tabSize ?? defaults.tabSize, 1), 8),
    wordWrap: settings.wordWrap ?? defaults.wordWrap,
    minimap: settings.minimap ?? defaults.minimap,
    lineNumbers: settings.lineNumbers ?? defaults.lineNumbers,
    autoSave: settings.autoSave ?? defaults.autoSave,
    autoComplete: settings.autoComplete ?? defaults.autoComplete,
    streaming: settings.streaming ?? defaults.streaming,
    theme: ['dark', 'light'].includes(settings.theme) ? settings.theme : defaults.theme,
  };
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
    // For local providers, just return true
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
