import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLog, newRunId } from './runLogs.js'
import { saveReplay, buildReplayArtifact } from './replayArtifact.js'
import { listRunsByChat, getLastRun, getReplayForRun, summarizeForResume } from './runResume.js'

describe('runResume: listRunsByChat + getLastRun', () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'browserai-resume-'))
    process.env.DATA_DIR = tmp
  })
  afterEach(() => {
    delete process.env.DATA_DIR
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function makeRun(chatId, runId, opts = {}) {
    const log = createRunLog({
      runId,
      provider: { baseUrl: 'mock' },
      routeMode: 'agent',
      taskType: 'dev_task',
      chatId,
      maxSteps: 10,
    })
    log.run_start({ firstUserAsk: opts.ask || 'hi' })
    log.finalization({ reason: opts.reason || 'final', taskCompleted: opts.completed ?? true, verified: true, blockers: [] })
    log.run_end({ durationMs: opts.durationMs || 100, endedStep: 1 })
    log.persist()
    saveReplay(buildReplayArtifact({ runId, runLog: log, finalStatus: { reason: opts.reason || 'final', taskCompleted: true, verified: true, blockers: [] } }))
  }

  it('lists runs by chatId in descending order', () => {
    makeRun('chat-A', 'r-a1', { reason: 'final', durationMs: 100 })
    makeRun('chat-A', 'r-a2', { reason: 'crash', durationMs: 200 })
    makeRun('chat-B', 'r-b1', { reason: 'final', durationMs: 300 })
    const a = listRunsByChat('chat-A', { limit: 10 })
    expect(a.map((r) => r.runId).sort().reverse()).toEqual(['r-a2', 'r-a1'])
    const b = listRunsByChat('chat-B', { limit: 10 })
    expect(b.map((r) => r.runId)).toEqual(['r-b1'])
  })

  it('getLastRun returns the most recent run for a chat', () => {
    makeRun('chat-X', 'r-x1', { reason: 'final' })
    makeRun('chat-X', 'r-x2', { reason: 'max-steps' })
    const last = getLastRun('chat-X')
    expect(last).not.toBeNull()
    expect(['r-x2', 'r-x1']).toContain(last.runId)
  })

  it('getLastRun returns null when no runs exist for chat', () => {
    makeRun('chat-1', 'r-1')
    expect(getLastRun('chat-does-not-exist')).toBeNull()
  })

  it('getReplayForRun returns the persisted replay artifact', () => {
    makeRun('chat-Y', 'r-y1')
    const r = getReplayForRun('r-y1')
    expect(r).not.toBeNull()
    expect(r.schema).toBe('browserai.replay.v1')
    expect(r.runId).toBe('r-y1')
  })

  it('summarizeForResume marks canResume for crash / max-steps / deadline', () => {
    makeRun('chat-Z', 'r-z-crash', { reason: 'crash' })
    makeRun('chat-Z', 'r-z-steps', { reason: 'max-steps' })
    makeRun('chat-Z', 'r-z-deadline', { reason: 'deadline' })
    makeRun('chat-Z', 'r-z-final', { reason: 'final' })
    expect(summarizeForResume('r-z-crash').canResume).toBe(true)
    expect(summarizeForResume('r-z-steps').canResume).toBe(true)
    expect(summarizeForResume('r-z-deadline').canResume).toBe(true)
    expect(summarizeForResume('r-z-final').canResume).toBe(false)
  })

  it('summarizeForResume returns null for unknown runId', () => {
    expect(summarizeForResume('does-not-exist')).toBeNull()
  })
})
