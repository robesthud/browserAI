import { describe, it, expect, vi } from 'vitest'
import { runAgent } from '../server/agentLoop.js'
import * as llmClient from '../server/llmClient.js'
import * as agentTools from '../server/agentTools.js'

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
    upsertAgentStateDigest: mod.upsertAgentStateDigest
  }
})

vi.mock('../server/agentTools.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    invokeTool: vi.fn(async (tool, args, opts) => {
      opts?.onStdout?.('mock stdout progress')
      return { ok: true, result: 'mocked tool result' }
    })
  }
})

vi.mock('../server/costTracker.js', () => {
  return {
    recordSpend: vi.fn(),
    checkCap: vi.fn(() => ({ ok: true, reason: '' })),
    chatTotalUsd: vi.fn(() => 0),
  }
})

describe('v2.22 - Automatic Memory Integration', () => {
  it('should auto-call recall_facts and kb_search for a high complexity task', async () => {
    llmClient.callLLMStream
      .mockImplementationOnce(async ({ onTextDelta }) => {
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
          if (line.startsWith('event: ')) {
            currentEvent = line.substring(7).trim()
          } else if (line.startsWith('data: ')) {
            const dataStr = line.substring(6)
            if (dataStr === '[DONE]') continue
            try {
              events.push({ event: currentEvent, data: JSON.parse(dataStr) })
            } catch (e) { }
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

    const eventNames = events.map(e => e.event)
    
    // We expect tool_start for recall_facts and kb_search before the first LLM call (which emits thinking/assistant)
    const toolStarts = events.filter(e => e.event === 'tool_start')
    expect(toolStarts.length).toBeGreaterThanOrEqual(2)
    expect(toolStarts[0].data.payload.name).toBe('recall_facts')
    expect(toolStarts[1].data.payload.name).toBe('kb_search')

    // Confirm they ran with step 0
    expect(toolStarts[0].data.payload.step).toBe(0)
    expect(toolStarts[1].data.payload.step).toBe(0)
  })
})
