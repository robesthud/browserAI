import { describe, expect, it } from 'vitest'
import { buildFinalStatus, isBlocked, isPartial, finalStatusToText } from './agentFinalStatus.js'

/**
 * Approach 2 — Finalization parity across termination reasons.
 *
 * Every termination path in `agentLoop.js` (final, deadline, max-steps,
 * crash, llm-error, cap-reached, no-provider, no-blank-reply) must emit
 * the SAME finalStatus shape so that downstream consumers (UI, replay,
 * KPIs) don't have to handle provider-specific shapes.
 *
 * The agent loop currently calls buildFinalStatus with the following
 * reason values: 'final', 'deadline', 'max-steps', 'crash', 'llm-error',
 * 'cap-reached', 'no-provider'. These tests pin that contract.
 */
describe('finalization parity across termination paths', () => {
  const EMPTY_CTX = { agentContext: {}, recentToolHistory: [], agentState: {}, userText: '', failedReadPaths: new Set(), okReadPaths: new Set() }
  const FINAL_CTX = {
    agentContext: { task: { type: 'dev_task', obligations: { inspect: true, codeChange: true, verify: true } } },
    recentToolHistory: [
      { tool: 'file', ok: true, args: JSON.stringify({ action: 'list' }), outcome: '5 entries' },
      { tool: 'read_file', ok: true, args: JSON.stringify({ path: 'src/app.js' }), outcome: '300 chars' },
      { tool: 'write_file', ok: true, args: JSON.stringify({ path: 'src/app.js', content: 'x' }), outcome: '120 bytes' },
      { tool: 'verify_code', ok: true, args: JSON.stringify({ path: 'src/app.js' }), outcome: 'valid/skipped' },
    ],
    agentState: {},
    userText: 'добавь console.log в src/app.js',
    failedReadPaths: new Set(),
    okReadPaths: new Set(['src/app.js']),
  }

  const EXPECTED_KEYS = ['taskCompleted', 'verified', 'localTests', 'deploy', 'blockers', 'evidenceSummary', 'claimIssues']
  const LOCAL_TESTS_KEYS = ['requested', 'attempted', 'passed']
  const DEPLOY_KEYS = ['requested', 'done', 'verified']
  const EVIDENCE_KEYS = ['filesRead', 'filesChanged', 'commandsRun', 'testsRun', 'testsPassed', 'errors', 'totalSteps']

  it('every termination reason produces the same finalStatus shape', () => {
    const reasons = ['final', 'deadline', 'max-steps', 'crash', 'llm-error', 'cap-reached', 'no-provider']
    const results = {}
    for (const reason of reasons) {
      results[reason] = buildFinalStatus({
        ...EMPTY_CTX,
        reason,
        aborted: reason === 'cap-reached',
        error: ['crash', 'llm-error'].includes(reason) ? new Error('boom') : null,
        step: reason === 'max-steps' ? 15 : 1,
        maxSteps: 15,
      })
    }
    for (const reason of reasons) {
      const fs = results[reason]
      expect(Object.keys(fs).sort()).toEqual([...EXPECTED_KEYS].sort())
      expect(Object.keys(fs.localTests).sort()).toEqual([...LOCAL_TESTS_KEYS].sort())
      expect(Object.keys(fs.deploy).sort()).toEqual([...DEPLOY_KEYS].sort())
      expect(Object.keys(fs.evidenceSummary).sort()).toEqual([...EVIDENCE_KEYS].sort())
      expect(Array.isArray(fs.blockers)).toBe(true)
      expect(typeof fs.taskCompleted).toBe('boolean')
      expect(typeof fs.verified).toBe('boolean')
    }
  })

  it('happy-path task is taskCompleted=true, verified=true, blockers=[]', () => {
    const fs = buildFinalStatus({ ...FINAL_CTX, reason: 'final', step: 4, maxSteps: 15 })
    expect(fs.taskCompleted).toBe(true)
    expect(fs.verified).toBe(true)
    expect(fs.blockers).toEqual([])
    expect(fs.evidenceSummary.filesRead).toBe(1)
    expect(fs.evidenceSummary.filesChanged).toBe(1)
  })

  it('deadline termination adds deadline blocker and is blocked', () => {
    const fs = buildFinalStatus({ ...EMPTY_CTX, reason: 'deadline', step: 15, maxSteps: 15 })
    expect(isBlocked(fs)).toBe(true)
    expect(fs.blockers.some((b) => b.type === 'deadline')).toBe(true)
    expect(fs.taskCompleted).toBe(false)
  })

  it('max-steps termination adds max_steps blocker and is blocked', () => {
    const fs = buildFinalStatus({ ...EMPTY_CTX, reason: 'max-steps', step: 15, maxSteps: 15 })
    expect(isBlocked(fs)).toBe(true)
    expect(fs.blockers.some((b) => b.type === 'max_steps')).toBe(true)
  })

  it('crash termination adds runtime_error blocker and is blocked', () => {
    const fs = buildFinalStatus({ ...EMPTY_CTX, reason: 'crash', error: new Error('Something exploded'), step: 3, maxSteps: 15 })
    expect(isBlocked(fs)).toBe(true)
    expect(fs.blockers.some((b) => b.type === 'runtime_error')).toBe(true)
  })

  it('llm-error termination adds runtime_error blocker and is blocked', () => {
    const fs = buildFinalStatus({ ...EMPTY_CTX, reason: 'llm-error', error: new Error('Provider returned 500'), step: 3, maxSteps: 15 })
    expect(isBlocked(fs)).toBe(true)
    expect(fs.blockers.some((b) => b.type === 'runtime_error')).toBe(true)
  })

  it('cap-reached (aborted) termination adds aborted blocker', () => {
    const fs = buildFinalStatus({ ...EMPTY_CTX, reason: 'cap-reached', aborted: true, step: 3, maxSteps: 15 })
    expect(isBlocked(fs)).toBe(true)
    expect(fs.blockers.some((b) => b.type === 'aborted')).toBe(true)
  })

  it('no-provider termination has no specific blocker but is not completed', () => {
    const fs = buildFinalStatus({ ...EMPTY_CTX, reason: 'no-provider', step: 0, maxSteps: 15 })
    expect(fs.taskCompleted).toBe(false)
    expect(fs.evidenceSummary.totalSteps).toBe(0)
  })

  it('fabrication blocker when failed reads were never successfully read', () => {
    const fs = buildFinalStatus({
      ...FINAL_CTX,
      reason: 'final',
      step: 4,
      maxSteps: 15,
      failedReadPaths: new Set(['imaginary/path.js']),
      okReadPaths: new Set(['src/app.js']),
    })
    expect(fs.blockers.some((b) => b.type === 'fabrication')).toBe(true)
  })

  it('missing_verification blocker when code changed but no verify after', () => {
    const fs = buildFinalStatus({
      ...EMPTY_CTX,
      reason: 'final',
      step: 3,
      maxSteps: 15,
      recentToolHistory: [
        { tool: 'write_file', ok: true, args: JSON.stringify({ path: 'src/app.js', content: 'x' }), outcome: '120 bytes written' },
      ],
      okReadPaths: new Set(),
    })
    expect(fs.blockers.some((b) => b.type === 'missing_verification')).toBe(true)
  })

  it('unmet_obligation blockers are emitted for every required obligation', () => {
    const fs = buildFinalStatus({
      ...EMPTY_CTX,
      reason: 'final',
      step: 1,
      maxSteps: 15,
      agentContext: { task: { obligations: { inspect: true, codeChange: true, verify: true, deploy: true } } },
    })
    const types = fs.blockers.map((b) => b.type)
    expect(types.filter((t) => t === 'unmet_obligation').length).toBe(4)
  })

  it('isPartial returns true only when not completed and not blocked', () => {
    const completed = buildFinalStatus({ ...FINAL_CTX, reason: 'final', step: 4, maxSteps: 15 })
    expect(isPartial(completed)).toBe(false)
    expect(isBlocked(completed)).toBe(false)
    const blocked = buildFinalStatus({ ...EMPTY_CTX, reason: 'deadline', step: 15, maxSteps: 15 })
    expect(isPartial(blocked)).toBe(false)
    expect(isBlocked(blocked)).toBe(true)
  })

  it('finalStatusToText renders all major sections', () => {
    const fs = buildFinalStatus({ ...FINAL_CTX, reason: 'final', step: 4, maxSteps: 15 })
    const txt = finalStatusToText(fs)
    expect(txt).toMatch(/Task completed/)
    expect(txt).toMatch(/Verified/)
    expect(txt).toMatch(/Evidence:/)
  })

  it('localTests.requested/attempted/passed are wired correctly', () => {
    const history = [
      { tool: 'file', ok: true, args: JSON.stringify({ action: 'read', path: 'a.js' }), outcome: '10 chars' },
      { tool: 'bash', ok: true, args: JSON.stringify({ command: 'npm test' }), outcome: 'exit=0 duration=100ms' },
    ]
    const fs = buildFinalStatus({
      ...EMPTY_CTX,
      reason: 'final',
      step: 2,
      maxSteps: 15,
      recentToolHistory: history,
      userText: 'запусти тесты локально',
    })
    expect(fs.localTests.requested).toBe(true)
    expect(fs.localTests.attempted).toBe(true)
    expect(fs.localTests.passed).toBe(true)
  })
})
