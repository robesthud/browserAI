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
      // Simulate live progress streaming (stdout)
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

describe('SSE Stream Shape (v2.19 - Strict Arena Parity)', () => {
  it('should emit the exact sequence and schema of SSE events', async () => {
    // 1. Prepare Mock: Step 1 emits a thought and a tool call (with thinking_delta)
    llmClient.callLLMStream
      .mockImplementationOnce(async ({ onTextDelta }) => {
        await onTextDelta('', { kind: 'thinking' })
        const toolCall = {
          name: 'read_file',
          args: { path: 'notes.txt' }
        }
        return { text: 'I need to read a file.', reasoning: 'I need to look at notes.txt.', toolCalls: [toolCall], usage: { prompt: 10, completion: 5 } }
      })
      // Step 2 emits the final streamed text
      .mockImplementationOnce(async ({ onTextDelta }) => {
        await onTextDelta('The', { kind: 'text' })
        await onTextDelta(' file is good.', { kind: 'text' })
        return { text: 'The file is good.', reasoning: '', toolCalls: [], usage: { prompt: 20, completion: 10 } }
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
              const payload = JSON.parse(dataStr)
              events.push({ event: currentEvent, data: payload })
            } catch (e) {
              console.error("Failed to parse SSE data:", dataStr)
            }
          }
        }
      }),
      end: vi.fn(),
      on: vi.fn(),
    }

    await runAgent({
      provider: { baseUrl: 'mock', apiKey: 'mock', model: 'mock' },
      history: [{ role: 'user', content: 'Say hello' }],
      extraSystem: '',
      workspaceScope: 'test-scope',
      userId: 'user1',
      res,
    })

    // Strict Envelope Checks
    let expectedSeq = 1
    for (const e of events) {
      const data = e.data
      
      // 1. Envelope Schema Check
      expect(['browserai.agent_stream_event.v1', 'browserai.agent_context.v1', 'browserai.agent_state.v1', 'browserai.tool_result.v1', 'browserai.provider_error.v1']).toContain(data.schema)
      
      // 2. Event name matches wrapper
      expect(data.event).toBe(e.event)
      
      // 3. Strict Sequence increments by 1
      expect(data.seq).toBe(expectedSeq++)
      
      // 4. Timestamp is present and looks like ISO
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      
      // 5. Payload vs Legacy fields parity
      // In normaliseSsePayload, payload object is spread at the top level
      if (data.payload) {
        for (const key of Object.keys(data.payload)) {
          expect(data[key]).toEqual(data.payload[key])
        }
      }
    }

    const eventNames = events.map(e => e.event)
    
    // Strict Start Sequence
    expect(eventNames[0]).toBe('stream_protocol')
    expect(eventNames[1]).toBe('agent_context')
    expect(eventNames[2]).toBe('agent_state')
    
    // Check specific event inner schemas
    const contextData = events.find(e => e.event === 'agent_context').data.payload
    expect(contextData.schema).toBe('browserai.agent_context.v1')
    expect(contextData).toHaveProperty('workspace')
    expect(contextData).toHaveProperty('model')
    expect(contextData).toHaveProperty('task')

    const stateData = events.find(e => e.event === 'agent_state').data.payload
    expect(stateData.schema).toBe('browserai.agent_state.v1')
    expect(stateData).toHaveProperty('status')
    expect(stateData).toHaveProperty('goal')
    expect(stateData).toHaveProperty('plan')

    // Tool lifecycle completeness
    expect(eventNames).toContain('thinking') // Emitted at start of step
    expect(eventNames).toContain('thought') // Contains "I need to read a file."
    expect(eventNames).toContain('tool_start')
    expect(eventNames).toContain('tool_progress') // We must see stdout streamed!
    expect(eventNames).toContain('tool_result')
    expect(eventNames.filter(e => e === 'agent_state').length).toBeGreaterThan(1) // state updates after tool
    
    const thoughtData = events.find(e => e.event === 'thought').data.payload
    expect(thoughtData).toHaveProperty('text', 'I need to read a file.')

    const toolResultData = events.find(e => e.event === 'tool_result').data.payload
    expect(toolResultData.structured.schema).toBe('browserai.tool_result.v1')
    expect(toolResultData.structured).toHaveProperty('ok', true)

    // Final answer streamed
    expect(eventNames).toContain('assistant_delta')
    expect(eventNames).toContain('assistant') // MUST flush final complete text

    const assistantData = events.find(e => e.event === 'assistant').data.payload
    expect(assistantData).toHaveProperty('text', 'The file is good.')

    // Done at the end
    expect(eventNames[eventNames.length - 1]).toBe('done')
    const doneData = events[events.length - 1].data.payload
    expect(doneData).toHaveProperty('reason', 'final')
    expect(doneData).toHaveProperty('tokens')
  })
})
