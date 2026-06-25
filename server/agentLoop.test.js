import { describe, expect, it } from 'vitest'
import { __test, runAgent } from './agentLoop.js'

const digest = (args) => JSON.stringify(args)

describe('agentLoop universal consolidated-tool guards', () => {
  it('recognizes explicit local test attempts through consolidated shell history', () => {
    const history = [
      { tool: 'shell', ok: true, args: digest({ action: 'run', command: 'cd env-gated-runner && node test-import.js' }), outcome: 'exit=0 duration=100ms' },
    ]

    expect(__test.askedForExplicitLocalTest('Обязательно протестируй локально и запусти test-import.js')).toBe(true)
    expect(__test.hasLocalTestAttempt(history)).toBe(true)
    expect(__test.hasSuccessfulLocalTest(history)).toBe(true)
  })

  it('requires verification after consolidated file writes until a real verify step appears', () => {
    const beforeVerify = [
      { tool: 'file', ok: true, args: digest({ action: 'write', path: 'env-gated-runner/main.js' }), outcome: '120 bytes written' },
    ]
    const afterVerify = [
      ...beforeVerify,
      { tool: 'verify', ok: true, args: digest({ action: 'code', path: 'env-gated-runner/main.js' }), outcome: 'valid/skipped' },
    ]

    expect(__test.needsVerificationSinceLastEdit(beforeVerify)).toBe(true)
    expect(__test.needsVerificationSinceLastEdit(afterVerify)).toBe(false)
  })

  it('counts consolidated file/verify actions toward obligations', () => {
    const history = [
      { tool: 'file', ok: true, args: digest({ action: 'list', path: '' }), outcome: '3 entries' },
      { tool: 'file', ok: true, args: digest({ action: 'read', path: 'env-gated-runner/main.js' }), outcome: '300 chars' },
      { tool: 'file', ok: true, args: digest({ action: 'write', path: 'env-gated-runner/main.js' }), outcome: '300 bytes written' },
      { tool: 'verify', ok: true, args: digest({ action: 'task' }), outcome: 'passed 2 checks' },
    ]

    const status = __test.obligationCompletionStatus({ inspect: true, codeChange: true, verify: true }, history)
    expect(status.inspect).toBe(true)
    expect(status.codeChange).toBe(true)
    expect(status.verify).toBe(true)
  })

  it('initializes a scoped workspace before the agent loop starts', async () => {
    const writes = []
    const res = {
      setHeader() {},
      flushHeaders() {},
      write(chunk) { writes.push(String(chunk)) },
      flush() {},
      end() {},
      on() {},
    }

    await expect(runAgent({
      provider: { baseUrl: 'mock', model: 'mock-model', forceAgent: true },
      history: [{ role: 'user', content: 'привет' }],
      maxSteps: 0,
      workspaceScope: 'vitest-agent-scope',
      res,
    })).resolves.toBeUndefined()

    expect(writes.some((chunk) => chunk.includes('event: stream_protocol'))).toBe(true)
  })
})
