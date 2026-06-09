import { describe, it, expect, vi, afterEach } from 'vitest'
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

// We'll mock invokeTool to fail specifically when we ask it to
vi.mock('../server/agentTools.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    TOOLS: { read_file: { params: { path: { type: 'string', required: true } } }, bash: { params: { command: { type: 'string', required: true } } } },
    invokeTool: vi.fn(async (tool, args, opts) => {
      opts?.onStdout?.('mock stdout progress')
      console.log('INVOKED TOOL:', tool, args);
      if (tool === 'read_file' && args.path === 'wrong.txt') {
         return { ok: false, error: 'File not found' }
      }
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

describe('v2.24 - Advanced error recovery', () => {
  afterEach(() => { vi.clearAllMocks() })
  it('should push back on schema validation error', async () => {
    llmClient.callLLMStream
      .mockImplementationOnce(async () => {
        return { text: '', toolCalls: [{ name: 'read_file', args: {}, id: 't1', raw: { type: 'function', function: { name: 'read_file', arguments: '{}' } } }], usage: {} }
      })
      .mockImplementationOnce(async () => {
        return { text: 'Fixed it', toolCalls: [], usage: {} }
      })

    const events = []
    const res = {
      setHeader: vi.fn(), flushHeaders: vi.fn(), end: vi.fn(), on: vi.fn(),
      write: vi.fn((chunk) => {
        chunk.split('\n').forEach(line => {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try { events.push(JSON.parse(line.substring(6))) } catch(e){}
          }
        })
      })
    }

    await runAgent({
      provider: { baseUrl: 'mock', apiKey: 'mock', model: 'mock' },
      history: [{ role: 'user', content: 'read file' }],
      res
    })

    const thoughts = events.filter(e => e.event === 'thought').map(e => e.payload.text)
    expect(thoughts.some(t => t.includes('ОШИБКА СХЕМЫ'))).toBe(true)
  })

  it('should push back on execution error (self-healing)', async () => {
    llmClient.callLLMStream
      .mockImplementationOnce(async () => {
        // This will trigger the invokeTool mock failure
        return { text: '', toolCalls: [{ name: 'read_file', args: { path: 'wrong.txt' }, id: 't2', raw: { type: 'function', function: { name: 'read_file', arguments: '{}' } } }], usage: {} }
      })
      .mockImplementationOnce(async () => {
        return { text: 'I understand', toolCalls: [], usage: {} }
      })

    const events = []
    const res = {
      setHeader: vi.fn(), flushHeaders: vi.fn(), end: vi.fn(), on: vi.fn(),
      write: vi.fn((chunk) => {
        chunk.split('\n').forEach(line => {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try { events.push(JSON.parse(line.substring(6))) } catch(e){}
          }
        })
      })
    }

    await runAgent({
      provider: { baseUrl: 'mock', apiKey: 'mock', model: 'mock' },
      history: [{ role: 'user', content: 'read file' }],
      res
    })

    const thoughts = events.filter(e => e.event === 'thought').map(e => e.payload.text)
    const toolResults = events.filter(e => e.event === 'tool_result'); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)
    expect(toolResults[0].payload.ok).toBe(false)
  })
})