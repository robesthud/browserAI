import { describe, expect, it } from 'vitest'
import { buildFinalStatus, isBlocked, isPartial, finalStatusToText } from './agentFinalStatus.js'

describe('buildFinalStatus', () => {
  it('returns taskCompleted=true with no history and no blockers', () => {
    const status = buildFinalStatus({ step: 0, maxSteps: 25 })
    expect(status.taskCompleted).toBe(true)
    expect(status.verified).toBe(true)
    expect(status.blockers).toEqual([])
    expect(status.localTests.passed).toBe(false)
  })

  it('flags blocked when max_steps reached', () => {
    const status = buildFinalStatus({ step: 25, maxSteps: 25, reason: 'final' })
    expect(status.taskCompleted).toBe(false)
    expect(isBlocked(status)).toBe(true)
    expect(status.blockers[0].type).toBe('max_steps')
  })

  it('flags blocked when deadline exceeded', () => {
    const status = buildFinalStatus({ reason: 'deadline' })
    expect(isBlocked(status)).toBe(true)
    expect(status.blockers[0].type).toBe('deadline')
  })

  it('flags missing_test when user asked for test but none attempted', () => {
    const status = buildFinalStatus({ userText: 'протестируй код', recentToolHistory: [] })
    expect(status.localTests.requested).toBe(true)
    expect(status.localTests.attempted).toBe(false)
    expect(status.blockers.some((b) => b.type === 'missing_test')).toBe(true)
    expect(isBlocked(status)).toBe(true)
  })

  it('flags test_failed when attempted but not passed', () => {
    const history = [
      { tool: 'npm_test', ok: false, args: '{"command":"npm test"}', outcome: 'failed exit=1' },
    ]
    const status = buildFinalStatus({ userText: 'npm test', recentToolHistory: history })
    expect(status.localTests.attempted).toBe(true)
    expect(status.localTests.passed).toBe(false)
    expect(status.blockers.some((b) => b.type === 'test_failed')).toBe(true)
  })

  it('does not flag missing_test when tests passed', () => {
    const history = [
      { tool: 'npm_test', ok: true, args: '{"command":"npm test"}', outcome: 'passed' },
    ]
    const status = buildFinalStatus({ userText: 'протестируй', recentToolHistory: history })
    expect(status.localTests.passed).toBe(true)
    expect(status.blockers.some((b) => b.type === 'missing_test')).toBe(false)
    expect(status.blockers.some((b) => b.type === 'test_failed')).toBe(false)
  })

  it('flags missing_verification when code changed but no verify after', () => {
    const history = [
      { tool: 'write_file', ok: true, args: '{"path":"foo.js"}', outcome: '42 bytes written' },
    ]
    const status = buildFinalStatus({ recentToolHistory: history })
    expect(status.blockers.some((b) => b.type === 'missing_verification')).toBe(true)
  })

  it('does not flag missing_verification when verify follows edit', () => {
    const history = [
      { tool: 'write_file', ok: true, args: '{"path":"foo.js"}', outcome: '42 bytes written' },
      { tool: 'verify_code', ok: true, args: '{"action":"code"}', outcome: 'valid' },
    ]
    const status = buildFinalStatus({ recentToolHistory: history })
    expect(status.blockers.some((b) => b.type === 'missing_verification')).toBe(false)
  })

  it('flags fabrication when failed reads never succeeded', () => {
    const status = buildFinalStatus({
      failedReadPaths: new Set(['/workspace/chats/abc/nonexistent.js']),
      okReadPaths: new Set(),
      recentToolHistory: [
        { tool: 'read_file', ok: false, args: '{"path":"nonexistent.js"}', outcome: 'ENOENT' },
      ],
    })
    expect(status.blockers.some((b) => b.type === 'fabrication')).toBe(true)
  })

  it('flags unmet_obligation when deploy is required but not done', () => {
    const status = buildFinalStatus({
      agentContext: { task: { obligations: { deploy: true, codeChange: true } } },
      recentToolHistory: [
        { tool: 'write_file', ok: true, args: '{"path":"foo.js"}', outcome: '42 bytes written' },
      ],
    })
    expect(status.blockers.some((b) => b.type === 'unmet_obligation')).toBe(true)
  })

  it('counts evidence summary correctly', () => {
    const history = [
      { tool: 'list_files', ok: true, args: '{}', outcome: '5 entries' },
      { tool: 'read_file', ok: true, args: '{"path":"a.js"}', outcome: '100 chars' },
      { tool: 'write_file', ok: true, args: '{"path":"b.js"}', outcome: '50 bytes written' },
      { tool: 'bash', ok: true, args: '{"command":"npm test"}', outcome: 'exit=0' },
      { tool: 'npm_test', ok: true, args: '{"command":"npm test"}', outcome: 'passed' },
      { tool: 'read_file', ok: false, args: '{"path":"c.js"}', outcome: 'ENOENT' },
    ]
    const status = buildFinalStatus({ recentToolHistory: history, step: 3, maxSteps: 30 })
    expect(status.evidenceSummary.filesRead).toBe(1)
    expect(status.evidenceSummary.filesChanged).toBe(1)
    expect(status.evidenceSummary.commandsRun).toBe(1)
    // Both bash with npm test and npm_test tool are counted as local tests
    expect(status.evidenceSummary.testsRun).toBe(2)
    expect(status.evidenceSummary.testsPassed).toBe(2)
    expect(status.evidenceSummary.errors).toBe(1)
    expect(status.evidenceSummary.totalSteps).toBe(3)
  })
})

describe('isBlocked', () => {
  it('returns true for blocked statuses', () => {
    expect(isBlocked(buildFinalStatus({ reason: 'deadline' }))).toBe(true)
    expect(isBlocked(buildFinalStatus({ aborted: true }))).toBe(true)
  })
  it('returns false for clean completion', () => {
    expect(isBlocked(buildFinalStatus({ step: 5, maxSteps: 30 }))).toBe(false)
  })
})

describe('isPartial', () => {
  it('returns true for incomplete with non-blocking reasons', () => {
    expect(isPartial(buildFinalStatus({ agentContext: { task: { obligations: { deploy: true } } }, recentToolHistory: [] }))).toBe(false) // because it is blocked by unmet_obligation
  })
})

describe('finalStatusToText', () => {
  it('renders a clean completion summary', () => {
    const status = buildFinalStatus({ step: 3, maxSteps: 30, recentToolHistory: [{ tool: 'read_file', ok: true, args: '{"path":"a.js"}', outcome: '100 chars' }] })
    const text = finalStatusToText(status)
    expect(text).toContain('✅ Task completed')
    expect(text).toContain('files read=1')
    expect(text).toContain('steps=3')
  })

  it('renders blockers when blocked', () => {
    const status = buildFinalStatus({ reason: 'deadline', step: 30, maxSteps: 30 })
    const text = finalStatusToText(status)
    expect(text).toContain('🔴 Blocked')
    expect(text).toContain('deadline')
  })
})
