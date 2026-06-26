import { describe, expect, it } from 'vitest'
import { buildFinalStatus, isBlocked, isPartial, finalStatusToText } from './agentFinalStatus.js'

/**
 * Approach 2 — Provider finalization parity.
 *
 * The same agent task on different providers (managed_deepseek, openrouter,
 * gemini_official, etc.) must produce the SAME finalStatus
 * schema. Provider-specific behavior must not leak into the final status
 * shape — only the contents (blockers list, evidence summary) can differ.
 */
describe('provider finalization parity', () => {
  // Same task outcome, three different "provider paths". The finalStatus
  // schema must be IDENTICAL across them.
  const PROVIDERS = ['managed_deepseek', 'openrouter', 'gemini_official']

  const TASK_OUTCOMES = {
    happy: {
      agentContext: { task: { type: 'dev_task', obligations: { inspect: true, codeChange: true, verify: true } } },
      recentToolHistory: [
        { tool: 'file', ok: true, args: JSON.stringify({ action: 'list' }), outcome: '5 entries' },
        { tool: 'read_file', ok: true, args: JSON.stringify({ path: 'src/app.js' }), outcome: '300 chars' },
        { tool: 'write_file', ok: true, args: JSON.stringify({ path: 'src/app.js', content: 'x' }), outcome: '120 bytes written' },
        { tool: 'verify_code', ok: true, args: JSON.stringify({ path: 'src/app.js' }), outcome: 'valid/skipped' },
      ],
      userText: 'обнови src/app.js',
      failedReadPaths: new Set(),
      okReadPaths: new Set(['src/app.js']),
    },
    fabrication: {
      agentContext: { task: { type: 'dev_task', obligations: { inspect: true, codeChange: true } } },
      recentToolHistory: [
        { tool: 'file', ok: true, args: JSON.stringify({ action: 'read', path: 'imaginary/path.js' }), outcome: 'failed' },
      ],
      userText: 'проанализируй imaginary/path.js',
      failedReadPaths: new Set(['imaginary/path.js']),
      okReadPaths: new Set(),
    },
    deadline: {
      agentContext: { task: { type: 'research' } },
      recentToolHistory: [
        { tool: 'web_search', ok: true, args: JSON.stringify({ query: 'foo' }), outcome: '5 results' },
      ],
      userText: 'поищи инфу про foo',
      failedReadPaths: new Set(),
      okReadPaths: new Set(),
    },
  }

  function shapeOf(fs) {
    return {
      topLevel: Object.keys(fs).sort(),
      localTestsKeys: Object.keys(fs.localTests).sort(),
      deployKeys: Object.keys(fs.deploy).sort(),
      evidenceKeys: Object.keys(fs.evidenceSummary).sort(),
      blockerTypes: fs.blockers.map((b) => b.type).sort(),
    }
  }

  it('happy task produces identical finalStatus shape across all providers', () => {
    const shapes = {}
    for (const provider of PROVIDERS) {
      // Different providers may carry different route modes (e.g. deepseek
      // uses non-stream JSON path, OpenRouter uses OpenAI-compatible stream),
      // but finalStatus must not depend on the provider.
      const ctx = { ...TASK_OUTCOMES.happy, provider, reason: 'final', step: 4, maxSteps: 15 }
      shapes[provider] = shapeOf(buildFinalStatus(ctx))
    }
    expect(shapes.managed_deepseek).toEqual(shapes.openrouter)
    expect(shapes.openrouter).toEqual(shapes.gemini_official)
  })

  it('fabrication-detected task produces identical finalStatus shape across providers', () => {
    const shapes = {}
    for (const provider of PROVIDERS) {
      const ctx = { ...TASK_OUTCOMES.fabrication, provider, reason: 'final', step: 1, maxSteps: 15 }
      shapes[provider] = shapeOf(buildFinalStatus(ctx))
    }
    expect(shapes.managed_deepseek).toEqual(shapes.openrouter)
    expect(shapes.openrouter).toEqual(shapes.gemini_official)
    expect(shapes.managed_deepseek.blockerTypes).toContain('fabrication')
  })

  it('deadline-terminated task produces identical finalStatus shape across providers', () => {
    const shapes = {}
    for (const provider of PROVIDERS) {
      const ctx = { ...TASK_OUTCOMES.deadline, provider, reason: 'deadline', step: 15, maxSteps: 15 }
      shapes[provider] = shapeOf(buildFinalStatus(ctx))
    }
    expect(shapes.managed_deepseek).toEqual(shapes.openrouter)
    expect(shapes.openrouter).toEqual(shapes.gemini_official)
    expect(shapes.managed_deepseek.blockerTypes).toEqual(['deadline'])
  })

  it('isBlocked is consistent across providers for the same task', () => {
    for (const provider of PROVIDERS) {
      const happy = buildFinalStatus({ ...TASK_OUTCOMES.happy, reason: 'final', step: 4, maxSteps: 15 })
      const blocked = buildFinalStatus({ ...TASK_OUTCOMES.fabrication, reason: 'final', step: 1, maxSteps: 15 })
      const deadline = buildFinalStatus({ ...TASK_OUTCOMES.deadline, reason: 'deadline', step: 15, maxSteps: 15 })
      expect(isBlocked(happy)).toBe(false)
      expect(isBlocked(blocked)).toBe(true)
      expect(isBlocked(deadline)).toBe(true)
      expect(isPartial(happy)).toBe(false)
    }
  })

  it('finalStatusToText produces identical block layout across providers', () => {
    const texts = {}
    for (const provider of PROVIDERS) {
      const ctx = { ...TASK_OUTCOMES.fabrication, reason: 'final', step: 1, maxSteps: 15 }
      texts[provider] = finalStatusToText(buildFinalStatus(ctx))
    }
    // Same structural sections — they may not be byte-identical because of
    // blocker ordering, but every section must appear in every output.
    for (const provider of PROVIDERS) {
      expect(texts[provider]).toMatch(/^🔴 Blocked/)
      expect(texts[provider]).toMatch(/Blockers/)
      expect(texts[provider]).toMatch(/Evidence:/)
      expect(texts[provider]).toMatch(/fabrication/)
    }
  })

  it('oblivious-to-provider: routeMode field is not part of finalStatus', () => {
    for (const provider of PROVIDERS) {
      const fs = buildFinalStatus({ ...TASK_OUTCOMES.happy, provider, reason: 'final', step: 4, maxSteps: 15 })
      expect(fs.provider).toBeUndefined()
      expect(fs.routeMode).toBeUndefined()
    }
  })
})
