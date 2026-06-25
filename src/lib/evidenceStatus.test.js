import { describe, expect, it } from 'vitest'
import { classifyEvidenceStatus, summarizeEvidence } from './evidenceStatus.js'

/**
 * Pure-logic tests for the AgentEvidenceBlock status classifier.
 * Approach 7 — Trust UX.
 *
 * These tests verify the tone classification WITHOUT requiring React
 * render machinery, so they run with vitest's default node environment.
 */
describe('evidenceStatus: classifyEvidenceStatus', () => {
  it('classifies a fully-successful run as success', () => {
    const s = classifyEvidenceStatus({
      taskCompleted: true,
      verified: true,
      blockers: [],
      deploy: { requested: false, done: false, verified: false },
    })
    expect(s.tone).toBe('success')
    expect(s.label).toBe('Completed')
    expect(s.glyph).toBe('✓')
  })

  it('classifies a blocked run as blocked (even if taskCompleted=true)', () => {
    const s = classifyEvidenceStatus({
      taskCompleted: true,
      verified: true,
      blockers: [{ type: 'fabrication' }],
    })
    expect(s.tone).toBe('blocked')
  })

  it('classifies an interrupted crash as interrupted', () => {
    const s = classifyEvidenceStatus({ reason: 'crash', taskCompleted: false, blockers: [] })
    expect(s.tone).toBe('interrupted')
    expect(s.label).toBe('Interrupted')
  })

  it('classifies llm-error as interrupted', () => {
    expect(classifyEvidenceStatus({ reason: 'llm-error', taskCompleted: false }).tone).toBe('interrupted')
  })

  it('classifies cap-reached as interrupted', () => {
    expect(classifyEvidenceStatus({ reason: 'cap-reached', taskCompleted: false }).tone).toBe('interrupted')
  })

  it('classifies a partial run (completed but unverified) as partial', () => {
    const s = classifyEvidenceStatus({
      taskCompleted: true,
      verified: false,
      blockers: [],
    })
    expect(s.tone).toBe('partial')
    expect(s.label).toBe('Partial')
  })

  it('classifies a complete run with unverified deploy as partial', () => {
    const s = classifyEvidenceStatus({
      taskCompleted: true,
      verified: true,
      blockers: [],
      deploy: { requested: true, done: true, verified: false },
    })
    expect(s.tone).toBe('partial')
  })

  it('returns unknown for empty finalStatus', () => {
    const s = classifyEvidenceStatus({})
    expect(s.tone).toBe('unknown')
  })
})

describe('evidenceStatus: summarizeEvidence', () => {
  it('falls back to zeros when neither summary nor evidenceSummary is provided', () => {
    const s = summarizeEvidence({})
    expect(s).toEqual({
      filesRead: 0, filesChanged: 0, commandsRun: 0,
      testsRun: 0, testsPassed: 0, errors: 0, totalSteps: 0,
    })
  })

  it('uses provided summary argument', () => {
    const s = summarizeEvidence({}, { filesRead: 3, filesChanged: 1, commandsRun: 2, testsRun: 1, testsPassed: 1, errors: 0, totalSteps: 5 })
    expect(s.filesRead).toBe(3)
    expect(s.filesChanged).toBe(1)
    expect(s.totalSteps).toBe(5)
  })

  it('falls back to evidenceSummary when summary is null', () => {
    const s = summarizeEvidence({ evidenceSummary: { filesRead: 9 } }, null)
    expect(s.filesRead).toBe(9)
  })
})
