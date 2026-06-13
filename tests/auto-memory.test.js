import { describe, it, expect, vi } from 'vitest'
import { runAgent } from '../server/agentLoop.js'
import * as llmClient from '../server/llmClient.js'

vi.mock('../server/llmClient.js', () => {
  return {
    callLLMStream: vi.fn(),
    callLLM: vi.fn(),
    supportsNativeTools: vi.fn(() => true),
    supportsStreaming: vi.fn(() => true),
    normalizeProviderError: vi.fn((e) => ({
      schema: 'browserai.provider_error.v1',
      message: e.message,
    })),
  }
})

vi.mock('../server/contextManager.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    contextUsageFraction: vi.fn(() => 0.1),
    applyAnthropicCacheHints: vi.fn((m) => m),
    clipToolOutput: mod.clipToolOutput,
    manageContext: mod.manageContext,
    upsertAgentStateDigest: mod.upsertAgentStateDigest,
  }
})

vi.mock('../server/agentTools.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    invokeTool: vi.fn(async () => ({ ok: true, result: 'mocked tool result' })),
  }
})

vi.mock('../server/costTracker.js', () => {
  return {
    recordSpend: vi.fn(),
    checkCap: vi.fn(() => ({ ok: true, reason: '' })),
    chatTotalUsd: vi.fn(() => 0),
  }
})

describe('automatic memory preload', () => {
  it('does not auto-call recall_facts/kb_search before simple agent work', async () => {
    llmClient.callLLMStream.mockImplementationOnce(async ({ onTextDelta }) => {
      await onTextDelta('Final answer.', { kind: 'text' })
      return { text: 'Final answer.', reasoning: '', toolCalls: [], usage: { prompt: 20, completion: 10 } }
    })

    const events = []
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk) => {
        const lines = chunk.split('\n')
        let currentEvent = null
        for (const line of lines) {
          if (line.startsWith('event: ')) currentEvent = line.substring(7).trim()
          else if (line.startsWith('data: ')) {
            const dataStr = line.substring(6)
            if (dataStr === '[DONE]') continue
            try { events.push({ event: currentEvent, data: JSON.parse(dataStr) }) } catch { /* ignore */ }
          }
        }
      }),
      end: vi.fn(),
      on: vi.fn(),
    }

    await runAgent({
      provider: { baseUrl: 'mock', apiKey: 'mock', model: 'mock' },
      history: [{ role: 'user', content: 'Почини деплой на сервере Timeweb' }],
      extraSystem: '',
      workspaceScope: 'test-scope',
      userId: 'user1',
      res,
    })

    const autoMemoryStarts = events
      .filter(e => e.event === 'tool_start')
      .map(e => e.data.payload.name)
      .filter(name => ['recall_facts', 'kb_search'].includes(name))

    expect(autoMemoryStarts).toEqual([])
  })
})
