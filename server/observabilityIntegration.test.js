import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent } from './agentLoop.js'
import { recentKpis, aggregateKpis } from './qualityKpis.js'
import { summarizeRunLog, loadRunLog } from './runLogs.js'
import { loadReplay } from './replayArtifact.js'

/**
 * Approach 6 — Observability. End-to-end integration: each runAgent() call
 * must produce BOTH a run log AND a replay artifact, and recentKpis() must
 * pick them up.
 */
describe('observability end-to-end integration', () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'browserai-obs-'))
    process.env.DATA_DIR = tmp
  })
  afterEach(() => {
    delete process.env.DATA_DIR
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  async function fakeRun({ scope = 'obs-test-1', maxSteps = 0 } = {}) {
    const writes = []
    const res = {
      setHeader() {}, flushHeaders() {},
      write(chunk) { writes.push(String(chunk)) },
      flush() {}, end() {}, on() {},
    }
    await runAgent({
      provider: { baseUrl: 'mock', model: 'mock-model', forceAgent: true },
      history: [{ role: 'user', content: 'сделай что-нибудь' }],
      maxSteps,
      workspaceScope: scope,
      res,
    })
    return writes
  }

  it('produces a run log and a replay artifact for a single run', async () => {
    await fakeRun()
    const runs = readdirSync(join(tmp, 'runs'))
    const replays = readdirSync(join(tmp, 'replays'))
    expect(runs.length).toBe(1)
    expect(replays.length).toBe(1)
    const log = JSON.parse(readFileSync(join(tmp, 'runs', runs[0]), 'utf8'))
    expect(log.schema).toBe('browserai.run_log.v1')
    expect(log.events.length).toBeGreaterThan(0)
    const replay = JSON.parse(readFileSync(join(tmp, 'replays', replays[0]), 'utf8'))
    expect(replay.schema).toBe('browserai.replay.v1')
    expect(replay.runId).toBe(log.runId)
  })

  it('sseTrace in the replay artifact captures stream_protocol, error, done events', async () => {
    await fakeRun()
    const runs = readdirSync(join(tmp, 'runs'))
    const log = JSON.parse(readFileSync(join(tmp, 'runs', runs[0]), 'utf8'))
    const replay = loadReplay(log.runId)
    expect(replay.sseTrace.length).toBeGreaterThan(0)
    const names = replay.sseTrace.map((e) => e.event)
    expect(names).toContain('stream_protocol')
    expect(names).toContain('error')
    expect(names).toContain('done')
  })

  it('recentKpis aggregates the persisted replays', async () => {
    await fakeRun({ scope: 'obs-1' })
    await fakeRun({ scope: 'obs-2' })
    await fakeRun({ scope: 'obs-3' })
    const k = recentKpis({ limit: 100 })
    expect(k.total).toBe(3)
    expect(k.successRate).toBe(0)  // all 'no-provider' (providerFailure)
    expect(k.providerFailureRate).toBe(1.0)
  })

  it('summarizeRunLog returns compact summary from disk', async () => {
    await fakeRun()
    const runs = readdirSync(join(tmp, 'runs'))
    const log = loadRunLog(runs[0].replace(/\.json$/, ''))
    const s = summarizeRunLog(log)
    expect(s.runId).toBe(log.runId)
    expect(s.finalization.reason).toBe('no-provider')
  })

  it('aggregateKpis respects byProvider breakdown', async () => {
    await fakeRun()
    await fakeRun()
    const k = recentKpis({ limit: 100 })
    expect(k.byProvider).toBeDefined()
    expect(k.byProvider.mock || k.byProvider['mock']).toBeDefined()
  })

  it('multiple runs land in the index with stable run ids', async () => {
    await fakeRun({ scope: 'a' })
    await fakeRun({ scope: 'b' })
    await fakeRun({ scope: 'c' })
    const runs = readdirSync(join(tmp, 'runs'))
    const replays = readdirSync(join(tmp, 'replays'))
    expect(runs.length).toBe(3)
    expect(replays.length).toBe(3)
    const runIds = new Set(runs)
    const replayIds = new Set(replays)
    expect([...runIds].sort().join(',')).toBe([...replayIds].sort().join(','))
  })
})
