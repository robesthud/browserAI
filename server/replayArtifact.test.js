import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReplayArtifact, saveReplay, loadReplay, listReplayIds, summarizeHistory, summarizeSseTrace, summarizeWorkspaceChanges } from './replayArtifact.js'

describe('replayArtifact: buildReplayArtifact', () => {
  it('produces a valid browserai.replay.v1 object', () => {
    const a = buildReplayArtifact({
      runId: 'r1',
      provider: { baseUrl: 'mock', model: 'mock' },
      input: { lastUserAsk: 'fix bug', chatId: 'c1', taskType: 'dev_task', historySize: 3 },
      history: [
        { tool: 'file', ok: true, args: '{"action":"list"}', outcome: '5 entries', semantic: { family: 'file', action: 'list', evidenceTags: ['inspect'] } },
        { tool: 'write_file', ok: true, args: '{"path":"a.js"}', outcome: '120 bytes written', semantic: { family: 'file', action: 'write', path: 'a.js', evidenceTags: ['change'] } },
        { tool: 'verify_code', ok: true, args: '{"path":"a.js"}', outcome: 'valid/skipped', semantic: { family: 'verify', action: 'code', path: 'a.js', verificationKind: 'code', isVerify: true, evidenceTags: ['verify'] } },
      ],
      finalStatus: {
        taskCompleted: true, verified: true,
        localTests: { requested: false, attempted: false, passed: false },
        deploy: { requested: false, done: false, verified: false },
        blockers: [],
        evidenceSummary: { filesRead: 0, filesChanged: 1, commandsRun: 0, testsRun: 0, testsPassed: 0, errors: 0, totalSteps: 3 },
      },
      sseTrace: [
        { event: 'stream_protocol', at: 't0' },
        { event: 'tool_start', at: 't1' },
        { event: 'tool_result', at: 't2' },
        { event: 'done', at: 't3', payload: { reason: 'final' } },
      ],
    })
    expect(a.schema).toBe('browserai.replay.v1')
    expect(a.runId).toBe('r1')
    expect(a.history.length).toBe(3)
    expect(a.historySummary.filesChanged).toBe(1)
    expect(a.sseSummary.totalEvents).toBe(4)
    expect(a.sseSummary.doneReason).toBe('final')
    expect(a.sseSummary.streamCut).toBe(false)
    expect(a.finalStatus.taskCompleted).toBe(true)
  })

  it('marks streamCut=true when no done event is present', () => {
    const a = buildReplayArtifact({ runId: 'r2', sseTrace: [{ event: 'stream_protocol' }, { event: 'tool_start' }] })
    expect(a.sseSummary.streamCut).toBe(true)
  })

  it('captures semantic family/action/path/command in history entries', () => {
    const a = buildReplayArtifact({
      runId: 'r3',
      history: [
        { tool: 'file', ok: true, args: '{"action":"read","path":"src/x.js"}', semantic: { family: 'file', action: 'read', path: 'src/x.js', evidenceTags: ['inspect'] } },
        { tool: 'bash', ok: true, args: '{"command":"ls"}', semantic: { family: 'shell', action: 'run', command: 'ls' } },
      ],
    })
    expect(a.history[0].family).toBe('file')
    expect(a.history[0].path).toBe('src/x.js')
    expect(a.history[1].family).toBe('shell')
    expect(a.history[1].command).toBe('ls')
  })
})

describe('replayArtifact: summarizeHistory', () => {
  it('counts filesRead / filesChanged / commandsRun / testsRun / healthChecks / deploys', () => {
    const h = [
      { ok: true, family: 'file', action: 'read', isLocalTest: false, isHealthCheck: false, isDeploy: false },
      { ok: true, family: 'file', action: 'write', isLocalTest: false, isHealthCheck: false, isDeploy: false },
      { ok: true, family: 'file', action: 'edit', isLocalTest: false, isHealthCheck: false, isDeploy: false },
      { ok: true, family: 'shell', action: 'run', command: 'ls', isLocalTest: false, isHealthCheck: false, isDeploy: false },
      { ok: true, family: 'verify', action: 'npm_test', isLocalTest: true, isHealthCheck: false, isDeploy: false },
      { ok: true, family: 'docker', action: 'ps', isHealthCheck: true, isDeploy: false, isLocalTest: false },
      { ok: true, family: 'ops', action: 'run', isHealthCheck: false, isDeploy: true, isLocalTest: false },
      { ok: false, family: 'verify', action: 'task', isLocalTest: true },
    ]
    const s = summarizeHistory(h)
    expect(s.total).toBe(8)
    expect(s.okCount).toBe(7)
    expect(s.failCount).toBe(1)
    expect(s.filesRead).toBe(1)
    expect(s.filesChanged).toBe(2)
    expect(s.commandsRun).toBe(1)
    expect(s.testsRun).toBe(2)
    expect(s.testsPassed).toBe(1)
    expect(s.healthChecks).toBe(1)
    expect(s.deploys).toBe(1)
  })
})

describe('replayArtifact: summarizeWorkspaceChanges', () => {
  it('extracts file_change paths and diff patches for replay artifacts', () => {
    const s = summarizeWorkspaceChanges([
      { event: 'file_change', payload: { runId: 'run-1', name: 'edit_file', events: [
        { type: 'file_modified', path: 'src/a.js', tool: 'edit_file', meta: { runId: 'run-1', diff: { path: 'src/a.js', patch: '--- a/src/a.js\n+++ b/src/a.js\n-old\n+new' } } },
      ] } },
    ])
    expect(s.eventCount).toBe(1)
    expect(s.changedFileCount).toBe(1)
    expect(s.paths).toEqual(['src/a.js'])
    expect(s.diffCount).toBe(1)
    expect(s.diffs[0].runId).toBe('run-1')
    expect(s.diffs[0].patch).toContain('+new')
  })
})

describe('replayArtifact: summarizeSseTrace', () => {
  it('counts events by type and captures done reason', () => {
    const s = summarizeSseTrace([
      { event: 'stream_protocol', at: 'a' },
      { event: 'thinking_delta', at: 'b' },
      { event: 'tool_start', at: 'c' },
      { event: 'tool_result', at: 'd' },
      { event: 'done', at: 'e', payload: { reason: 'final' } },
    ])
    expect(s.totalEvents).toBe(5)
    expect(s.countsByEvent.done).toBe(1)
    expect(s.doneReason).toBe('final')
    expect(s.streamCut).toBe(false)
  })

  it('marks streamCut=true when no done event', () => {
    const s = summarizeSseTrace([{ event: 'stream_protocol' }, { event: 'tool_start' }])
    expect(s.streamCut).toBe(true)
  })

  it('captures last error from error event', () => {
    const s = summarizeSseTrace([
      { event: 'error', at: 'a', payload: { message: 'LLM failed: 500' } },
      { event: 'done', at: 'b', payload: { reason: 'llm-error' } },
    ])
    expect(s.lastError).toBe('LLM failed: 500')
  })
})

describe('replayArtifact: persistence', () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'browserai-rp-'))
    process.env.DATA_DIR = tmp
  })
  afterEach(() => {
    delete process.env.DATA_DIR
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('saveReplay + loadReplay round-trips the artifact', () => {
    const a = buildReplayArtifact({ runId: 'r-save-1', provider: { baseUrl: 'mock' } })
    const p = saveReplay(a)
    expect(p).toBe(join(tmp, 'replays', 'r-save-1.json'))
    expect(existsSync(p)).toBe(true)
    const reloaded = loadReplay('r-save-1')
    expect(reloaded.runId).toBe('r-save-1')
    expect(reloaded.schema).toBe('browserai.replay.v1')
  })

  it('listReplayIds returns sorted ids', () => {
    saveReplay(buildReplayArtifact({ runId: 'a' }))
    saveReplay(buildReplayArtifact({ runId: 'b' }))
    const ids = listReplayIds({ limit: 10 })
    expect(ids[0]).toBe('b')
    expect(ids[1]).toBe('a')
  })
})
