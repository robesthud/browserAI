import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLog, newRunId, loadRunLog, listRunLogIds, summarizeRunLog } from './runLogs.js'

describe('runLogs: createRunLog + lifecycle', () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'browserai-rl-'))
    process.env.DATA_DIR = tmp
  })
  afterEach(() => {
    delete process.env.DATA_DIR
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('creates a log with the canonical schema and run metadata', () => {
    const log = createRunLog({
      runId: 'test-run-1',
      provider: { baseUrl: 'https://api.example', model: 'gpt-x' },
      routeMode: 'agent',
      taskType: 'dev_task',
      chatId: 'chat-42',
      maxSteps: 10,
      route: '/api/agent/chat',
    })
    expect(log.runId).toBe('test-run-1')
    expect(log.getState().schema).toBe('browserai.run_log.v1')
    expect(log.getState().provider.id).toBe('https://api.example')
    expect(log.getState().task.chatId).toBe('chat-42')
    expect(log.getState().runtime.maxSteps).toBe(10)
  })

  it('emits run_start / phase / tool_call / finalization / run_end events in order', () => {
    const log = createRunLog({ runId: 'order-test', provider: { baseUrl: 'mock', model: 'mock' }, routeMode: 'agent', taskType: 'dev_task' })
    log.run_start({ firstUserAsk: 'fix bug' })
    log.phase(null, 'discover')
    log.toolCall({ tool: 'file', args: '{"action":"list"}', ok: true, semantic: { family: 'file', action: 'list' } })
    log.toolCall({ tool: 'write_file', args: '{"path":"a.js"}', ok: true, semantic: { family: 'file', action: 'write', path: 'a.js' } })
    log.toolCall({ tool: 'verify_code', args: '{"path":"a.js"}', ok: true, semantic: { family: 'verify', action: 'code', path: 'a.js' } })
    log.finalization({ reason: 'final', taskCompleted: true, verified: true, blockers: [] })
    log.run_end({ durationMs: 1000, endedStep: 4 })
    const events = log.getEvents()
    expect(events.map((e) => e.type)).toEqual(['run_start', 'phase', 'tool_call', 'tool_call', 'tool_call', 'finalization', 'run_end'])
    expect(log.getState().summary.toolCalls).toBe(3)
    expect(log.getState().summary.filesRead).toBe(0)  // list ≠ read
    expect(log.getState().summary.filesChanged).toBe(1)  // write_file
    expect(log.getState().summary.testsRun).toBe(0)
  })

  it('tracks tests / commands / errors in summary', () => {
    const log = createRunLog({ runId: 'sum-test', provider: { baseUrl: 'mock' }, routeMode: 'agent', taskType: 'dev_task' })
    log.toolCall({ tool: 'bash', args: '{}', ok: true, semantic: { family: 'shell', action: 'run', command: 'ls' } })
    log.toolCall({ tool: 'npm_test', args: '{}', ok: true, semantic: { family: 'verify', action: 'npm_test', isLocalTest: true } })
    log.toolCall({ tool: 'verify_task', args: '{}', ok: false, semantic: { family: 'verify', action: 'task', isLocalTest: true }, error: 'failed' })
    log.toolCall({ tool: 'read_file', args: '{}', ok: true, semantic: { family: 'file', action: 'read', path: 'a.js' } })
    const s = log.getState().summary
    expect(s.commandsRun).toBe(1)
    expect(s.testsRun).toBe(2)
    expect(s.testsPassed).toBe(1)
    expect(s.errors).toBe(1)
    expect(s.filesRead).toBe(1)
  })

  it('persists to ${DATA_DIR}/runs/${runId}.json and can be reloaded', () => {
    const log = createRunLog({ runId: 'persist-1', provider: { baseUrl: 'mock' }, routeMode: 'agent', taskType: 'dev_task' })
    log.run_start({ firstUserAsk: 'fix bug' })
    log.finalization({ reason: 'final', taskCompleted: true, verified: true, blockers: [] })
    log.run_end({ durationMs: 200, endedStep: 2 })
    const p = log.persist()
    expect(p).toBe(join(tmp, 'runs', 'persist-1.json'))
    expect(existsSync(p)).toBe(true)
    const reloaded = loadRunLog('persist-1')
    expect(reloaded.runId).toBe('persist-1')
    expect(reloaded.events.length).toBe(3)
    expect(reloaded.finalization.taskCompleted).toBe(true)
  })

  it('records semantic_fail events', () => {
    const log = createRunLog({ runId: 'sem-fail', provider: { baseUrl: 'mock' }, routeMode: 'agent', taskType: 'dev_task' })
    log.semanticFail('fabrication', { tool: 'read_file', path: 'imaginary/path.js' })
    const events = log.getEvents()
    expect(events[0].type).toBe('semantic_fail')
    expect(events[0].reason).toBe('fabrication')
  })

  it('records classified error events', () => {
    const log = createRunLog({ runId: 'err-test', provider: { baseUrl: 'mock' }, routeMode: 'agent', taskType: 'dev_task' })
    log.error({ err: new Error('401 Unauthorized'), tool: 'bash' })
    const events = log.getEvents()
    expect(events[0].type).toBe('error')
    expect(events[0].category).toBe('auth')
    expect(events[0].fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('lists run ids sorted by name desc', () => {
    const a = createRunLog({ runId: 'aaa', provider: { baseUrl: 'mock' }, routeMode: 'agent', taskType: 'dev_task' }); a.persist()
    const b = createRunLog({ runId: 'bbb', provider: { baseUrl: 'mock' }, routeMode: 'agent', taskType: 'dev_task' }); b.persist()
    const ids = listRunLogIds({ limit: 10 })
    expect(ids[0]).toBe('bbb')
    expect(ids[1]).toBe('aaa')
  })

  it('newRunId returns unique identifiers', () => {
    const ids = new Set()
    for (let i = 0; i < 5; i += 1) ids.add(newRunId())
    expect(ids.size).toBe(5)
    expect([...ids].every((id) => /^run-\d+-[0-9a-f]{8}$/.test(id))).toBe(true)
  })

  it('summarizeRunLog returns compact summary without events', () => {
    const log = createRunLog({ runId: 'summarize-test', provider: { baseUrl: 'mock' }, routeMode: 'agent', taskType: 'dev_task' })
    log.toolCall({ tool: 'write_file', args: '{}', ok: true, semantic: { family: 'file', action: 'write', path: 'a.js' } })
    log.finalization({ reason: 'final', taskCompleted: true, verified: true, blockers: [] })
    log.run_end({ durationMs: 100, endedStep: 1 })
    const s = summarizeRunLog(log.getState())
    expect(s.runId).toBe('summarize-test')
    expect(s.finalization.taskCompleted).toBe(true)
    expect(s.summary.filesChanged).toBe(1)
    expect(s.eventCount).toBe(3)  // tool_call, finalization, run_end
  })
})
