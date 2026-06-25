import { describe, expect, it } from 'vitest'
import { aggregateKpis, summarizeReplay } from './qualityKpis.js'

function replayFixture({
  runId = 'r',
  provider = 'mock',
  finalStatus = {},
  sseSummary = {},
  input = {},
} = {}) {
  return {
    runId,
    provider: { id: provider },
    input: { chatId: 'c', taskType: 'dev_task', ...input },
    run: { startedAt: '2026-06-20T00:00:00Z', durationMs: 1000, summary: { toolCalls: 4 } },
    finalStatus: {
      reason: 'final',
      taskCompleted: true,
      verified: true,
      blockers: [],
      localTests: { requested: false, attempted: false, passed: false },
      deploy: { requested: false, done: false, verified: false },
      ...finalStatus,
    },
    sseSummary: { totalEvents: 5, streamCut: false, ...sseSummary },
  }
}

describe('qualityKpis: aggregateKpis', () => {
  it('returns null ratios on empty input', () => {
    const k = aggregateKpis([])
    expect(k.total).toBe(0)
    expect(k.successRate).toBeNull()
    expect(k.byProvider).toEqual({})
    expect(k.byTaskType).toEqual({})
  })

  it('computes successRate / falseFinalRate / maxStepsRate / streamCutRate', () => {
    const replays = [
      replayFixture({ runId: 'a', finalStatus: { reason: 'final', taskCompleted: true, verified: true, blockers: [] } }),  // success
      replayFixture({ runId: 'b', finalStatus: { reason: 'final', taskCompleted: true, verified: false, blockers: [{type: 'missing_verification'}] } }),  // false-final
      replayFixture({ runId: 'c', finalStatus: { reason: 'max-steps', taskCompleted: false, verified: false, blockers: [{type: 'max_steps'}] } }),  // max-steps
      replayFixture({ runId: 'd', sseSummary: { streamCut: true }, finalStatus: { reason: 'final', taskCompleted: true, verified: true, blockers: [] } }),  // streamCut (but still success)
      replayFixture({ runId: 'e', finalStatus: { reason: 'final', taskCompleted: true, verified: true, blockers: [] } }),  // success
    ]
    const k = aggregateKpis(replays)
    expect(k.total).toBe(5)
    expect(k.successRate).toBe(0.6)        // 3/5 success
    expect(k.falseFinalRate).toBe(0.2)     // 1/5 false-final
    expect(k.maxStepsRate).toBe(0.2)       // 1/5 max-steps
    expect(k.streamCutRate).toBe(0.2)      // 1/5 stream-cut
    expect(k.verificationMissingRate).toBe(0.2)
    expect(k.providerFailureRate).toBe(0)
  })

  it('breakdown by provider works', () => {
    const replays = [
      replayFixture({ runId: 'a', provider: 'mock' }),
      replayFixture({ runId: 'b', provider: 'mock', finalStatus: { reason: 'final', taskCompleted: true, verified: true, blockers: [] } }),
      replayFixture({ runId: 'c', provider: 'gemini', finalStatus: { reason: 'no-provider', taskCompleted: false, verified: false, blockers: [] } }),
    ]
    const k = aggregateKpis(replays)
    expect(k.byProvider.mock.total).toBe(2)
    expect(k.byProvider.mock.successRate).toBe(1.0)
    expect(k.byProvider.gemini.providerFailureRate).toBe(1.0)
  })

  it('breakdown by taskType works', () => {
    const replays = [
      replayFixture({ runId: 'a', input: { taskType: 'dev_task' } }),
      replayFixture({ runId: 'b', input: { taskType: 'dev_task' } }),
      replayFixture({ runId: 'c', input: { taskType: 'research' }, finalStatus: { reason: 'final', taskCompleted: false, verified: false, blockers: [] } }),
    ]
    const k = aggregateKpis(replays)
    expect(k.byTaskType.dev_task.total).toBe(2)
    expect(k.byTaskType.dev_task.successRate).toBe(1.0)
    expect(k.byTaskType.research.successRate).toBe(0)
  })

  it('windowStart / windowEnd reflect min/max startedAt', () => {
    const replays = [
      replayFixture({ runId: 'a' }),
      replayFixture({ runId: 'b' }),
    ]
    replays[0].run.startedAt = '2026-06-19T00:00:00Z'
    replays[1].run.startedAt = '2026-06-20T00:00:00Z'
    const k = aggregateKpis(replays)
    expect(k.windowStart).toBe('2026-06-19T00:00:00Z')
    expect(k.windowEnd).toBe('2026-06-20T00:00:00Z')
  })
})

describe('qualityKpis: summarizeReplay', () => {
  it('flags success/falseFinal/maxSteps/streamCut/providerFailure correctly', () => {
    const a = replayFixture({ finalStatus: { reason: 'final', taskCompleted: true, verified: true, blockers: [] } })
    expect(summarizeReplay(a).isSuccess).toBe(true)
    expect(summarizeReplay(a).isFalseFinal).toBe(false)

    const b = replayFixture({ finalStatus: { reason: 'final', taskCompleted: true, verified: true, blockers: [{type: 'fabrication'}] } })
    expect(summarizeReplay(b).isSuccess).toBe(false)
    expect(summarizeReplay(b).isFalseFinal).toBe(true)

    const c = replayFixture({ finalStatus: { reason: 'max-steps', taskCompleted: false, verified: false, blockers: [{type: 'max_steps'}] } })
    expect(summarizeReplay(c).isMaxSteps).toBe(true)

    const d = replayFixture({ sseSummary: { streamCut: true } })
    expect(summarizeReplay(d).isStreamCut).toBe(true)

    const e = replayFixture({ finalStatus: { reason: 'no-provider', taskCompleted: false, verified: false, blockers: [] } })
    expect(summarizeReplay(e).hasProviderFailure).toBe(true)
  })
})
