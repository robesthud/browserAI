import { describe, it, expect } from 'vitest'
import { callLLMStream, getProviderCapabilities } from '../server/llmClient.js'

// These tests require live API keys. If the env vars are missing, the tests
// will automatically skip. This allows us to run them locally when we want
// to verify provider parity, and gracefully ignore them in public CI unless
// repository secrets are explicitly provided.
const providers = [
  {
    name: 'OpenRouter (Claude 3.5 Sonnet)',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    model: 'anthropic/claude-3.5-sonnet',
  },
  {
    name: 'Anthropic (Claude 3.5 Sonnet)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-3-5-sonnet-latest',
  },
  {
    name: 'Gemini (Gemini 2.5 Flash)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-2.5-flash',
  },
  {
    name: 'DeepSeek (DeepSeek Chat)',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat',
  },
  {
    name: 'Groq (Llama 3.3 70B)',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY,
    model: 'llama-3.3-70b-versatile',
  }
]

describe('v2.20: Provider Smoke Tests (Tool Calling + Streaming)', () => {
  for (const p of providers) {
    const runTest = p.apiKey ? it : it.skip

    runTest(`Smoke test: ${p.name}`, async () => {
      // 1. Check capabilities schema
      const caps = getProviderCapabilities(p.baseUrl, p.model)
      expect(caps).toHaveProperty('schema', 'browserai.provider_capabilities.v1')
      expect(caps).toHaveProperty('kind')
      expect(caps.features).toHaveProperty('streaming')
      
      const messages = [
        { role: 'user', content: 'What is 1234 + 5678? You MUST use the "calculator" tool to add these numbers and return the result.' }
      ]

      const tools = {
        calculator: {
          description: 'Adds two numbers together exactly.',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number', description: 'First number' },
              b: { type: 'number', description: 'Second number' }
            },
            required: ['a', 'b']
          }
        }
      }

      let textStreamed = false
      let toolCallStreamed = false
      let streamedChunks = ''

      const result = await callLLMStream({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model,
        messages,
        tools,
        toolChoice: 'auto',
        temperature: 0.1,
        onTextDelta: (chunk, meta) => {
          if (chunk) {
            textStreamed = true
            streamedChunks += chunk
          }
        },
        onToolCallDelta: () => {
          toolCallStreamed = true
        }
      })

      // We expect the provider to either return a structured tool call (native)
      // or to output text that looks like a tool call (XML).
      expect(result).toBeTypeOf('object')
      expect(result).toHaveProperty('text')
      expect(result).toHaveProperty('toolCalls')

      if (caps.features.nativeTools) {
        // Native tool calling provider
        if (result.toolCalls.length > 0) {
          const tc = result.toolCalls[0]
          expect(tc.name).toBe('calculator')
          expect(typeof tc.args).toBe('object')
          expect(tc.args.a).toBeTypeOf('number')
          expect(tc.args.b).toBeTypeOf('number')
          
          if (caps.features.streaming) {
             expect(toolCallStreamed).toBe(true)
          }
        } else {
          // Some models might stubbornly answer directly if the math is too easy,
          // but we prompted heavily to use the tool. If they still answer directly,
          // we at least ensure they streamed and got it right.
          expect(result.text).toContain('6912')
          if (caps.features.streaming) expect(textStreamed).toBe(true)
        }
      } else {
        // Universal XML fallback protocol
        expect(result.text).toContain('calculator')
        expect(result.text).toContain('<xai:function_call')
        if (caps.features.streaming) {
           expect(textStreamed).toBe(true)
        }
      }
    }, 30000) // 30s timeout per live API call
  }
})