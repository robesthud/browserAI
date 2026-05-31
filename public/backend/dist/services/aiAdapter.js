// ============================================
// AI CODE STUDIO - UNIVERSAL AI ADAPTER (BACKEND)
// Supports: OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, Qwen, Ollama, LM Studio
// ============================================
// Provider-specific configurations
const PROVIDER_CONFIGS = {
    openai: {
        defaultBaseUrl: 'https://api.openai.com/v1',
        format: 'openai',
        defaultModel: 'gpt-4o',
    },
    anthropic: {
        defaultBaseUrl: 'https://api.anthropic.com/v1',
        format: 'anthropic',
        defaultModel: 'claude-sonnet-4-20250514',
    },
    google: {
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        format: 'google',
        defaultModel: 'gemini-2.5-flash',
    },
    groq: {
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        format: 'openai',
        defaultModel: 'llama-3.3-70b-versatile',
    },
    deepseek: {
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        format: 'openai',
        defaultModel: 'deepseek-chat',
    },
    mistral: {
        defaultBaseUrl: 'https://api.mistral.ai/v1',
        format: 'openai',
        defaultModel: 'mistral-large-latest',
    },
    qwen: {
        defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        format: 'openai',
        defaultModel: 'qwen-max',
    },
    ollama: {
        defaultBaseUrl: 'http://localhost:11434/v1',
        format: 'openai',
        defaultModel: 'llama3.2',
    },
    lmstudio: {
        defaultBaseUrl: 'http://localhost:1234/v1',
        format: 'openai',
        defaultModel: 'local-model',
    },
};
export class AIAdapter {
    // Non-streaming chat
    static async chat(config, messages) {
        const providerConfig = PROVIDER_CONFIGS[config.provider] || PROVIDER_CONFIGS.openai;
        const baseUrl = config.baseUrl || providerConfig.defaultBaseUrl;
        const model = config.model || providerConfig.defaultModel;
        switch (providerConfig.format) {
            case 'openai':
                return this.chatOpenAI(baseUrl, config.apiKey, model, messages, config);
            case 'anthropic':
                return this.chatAnthropic(baseUrl, config.apiKey, model, messages, config);
            case 'google':
                return this.chatGoogle(baseUrl, config.apiKey, model, messages, config);
            default:
                throw new Error(`Unsupported provider: ${config.provider}`);
        }
    }
    // Streaming chat
    static async streamChat(config, messages, callbacks) {
        const providerConfig = PROVIDER_CONFIGS[config.provider] || PROVIDER_CONFIGS.openai;
        const baseUrl = config.baseUrl || providerConfig.defaultBaseUrl;
        const model = config.model || providerConfig.defaultModel;
        try {
            switch (providerConfig.format) {
                case 'openai':
                    await this.streamOpenAI(baseUrl, config.apiKey, model, messages, config, callbacks);
                    break;
                case 'anthropic':
                    await this.streamAnthropic(baseUrl, config.apiKey, model, messages, config, callbacks);
                    break;
                case 'google':
                    await this.streamGoogle(baseUrl, config.apiKey, model, messages, config, callbacks);
                    break;
                default:
                    throw new Error(`Unsupported provider: ${config.provider}`);
            }
        }
        catch (error) {
            callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        }
    }
    // ============================================
    // OPENAI-COMPATIBLE PROVIDERS
    // ============================================
    static async chatOpenAI(baseUrl, apiKey, model, messages, config) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: config.temperature ?? 0.7,
                max_tokens: config.maxTokens ?? 4096,
            }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }
    static async streamOpenAI(baseUrl, apiKey, model, messages, config, callbacks) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: config.temperature ?? 0.7,
                max_tokens: config.maxTokens ?? 4096,
                stream: true,
            }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('Response body is not readable');
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]')
                        continue;
                    try {
                        const parsed = JSON.parse(data);
                        const token = parsed.choices?.[0]?.delta?.content || '';
                        if (token) {
                            fullText += token;
                            callbacks.onToken(token);
                        }
                    }
                    catch { }
                }
            }
        }
        callbacks.onComplete(fullText);
    }
    // ============================================
    // ANTHROPIC (CLAUDE)
    // ============================================
    static async chatAnthropic(baseUrl, apiKey, model, messages, config) {
        const systemMessage = messages.find(m => m.role === 'system');
        const otherMessages = messages.filter(m => m.role !== 'system');
        const response = await fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                max_tokens: config.maxTokens ?? 4096,
                system: systemMessage?.content || 'You are a helpful AI assistant.',
                messages: otherMessages,
            }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }
        const data = await response.json();
        return data.content?.[0]?.text || '';
    }
    static async streamAnthropic(baseUrl, apiKey, model, messages, config, callbacks) {
        const systemMessage = messages.find(m => m.role === 'system');
        const otherMessages = messages.filter(m => m.role !== 'system');
        const response = await fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                max_tokens: config.maxTokens ?? 4096,
                system: systemMessage?.content || 'You are a helpful AI assistant.',
                messages: otherMessages,
                stream: true,
            }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('Response body is not readable');
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const parsed = JSON.parse(line.slice(6));
                        if (parsed.type === 'content_block_delta') {
                            const token = parsed.delta?.text || '';
                            if (token) {
                                fullText += token;
                                callbacks.onToken(token);
                            }
                        }
                    }
                    catch { }
                }
            }
        }
        callbacks.onComplete(fullText);
    }
    // ============================================
    // GOOGLE (GEMINI)
    // ============================================
    static async chatGoogle(baseUrl, apiKey, model, messages, config) {
        const systemMessage = messages.find(m => m.role === 'system');
        const otherMessages = messages.filter(m => m.role !== 'system');
        const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: otherMessages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }],
                })),
                systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
                generationConfig: {
                    temperature: config.temperature ?? 0.7,
                    maxOutputTokens: config.maxTokens ?? 4096,
                },
            }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    static async streamGoogle(baseUrl, apiKey, model, messages, config, callbacks) {
        const systemMessage = messages.find(m => m.role === 'system');
        const otherMessages = messages.filter(m => m.role !== 'system');
        const response = await fetch(`${baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: otherMessages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }],
                })),
                systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
                generationConfig: {
                    temperature: config.temperature ?? 0.7,
                    maxOutputTokens: config.maxTokens ?? 4096,
                },
            }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('Response body is not readable');
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const parsed = JSON.parse(line.slice(6));
                        const token = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        if (token) {
                            fullText += token;
                            callbacks.onToken(token);
                        }
                    }
                    catch { }
                }
            }
        }
        callbacks.onComplete(fullText);
    }
    // ============================================
    // CODE COMPLETION
    // ============================================
    static async complete(config, prefix, suffix, language) {
        const messages = [
            {
                role: 'system',
                content: `You are a code completion AI. Complete the ${language} code at the cursor position. Return ONLY the completion text, no explanations, no markdown code blocks.`,
            },
            {
                role: 'user',
                content: `Complete this ${language} code:\n\n${prefix}<CURSOR>${suffix}\n\nReturn only what should replace <CURSOR>. Be concise.`,
            },
        ];
        // Use faster model for completions
        const fastModels = {
            openai: 'gpt-4o-mini',
            anthropic: 'claude-3-5-haiku-20241022',
            google: 'gemini-2.0-flash',
            groq: 'llama-3.1-8b-instant',
            deepseek: 'deepseek-chat',
            mistral: 'mistral-small-latest',
        };
        const completionConfig = {
            ...config,
            model: fastModels[config.provider] || config.model,
            temperature: 0.1,
            maxTokens: 150,
        };
        return this.chat(completionConfig, messages);
    }
}
