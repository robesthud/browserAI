import { describe, expect, it } from 'vitest'
import { normalizeProjectPolicy, evaluateProjectPolicy, applyPolicyToSuperOptions, pathMatchesPolicyPattern } from '../server/operatorProjectPolicies.js'

describe('operator project policies v2', () => {
  it('normalizes presets and denies disabled actions', () => {
    const policy = normalizeProjectPolicy({ preset: 'safe' })
    expect(policy.allowed.code).toBe(true)
    expect(policy.allowed.merge).toBe(false)
    const decision = evaluateProjectPolicy(policy, 'code.merge', { ciOk: true, confirm: true })
    expect(decision.ok).toBe(false)
    expect(decision.blockers.map((b) => b.message).join('\n')).toContain('disables PR merge')
  })

  it('requires confirmation and green ci for balanced merge', () => {
    const policy = normalizeProjectPolicy({ preset: 'balanced' })
    expect(evaluateProjectPolicy(policy, 'code.merge', { ciOk: false, confirm: true }).ok).toBe(false)
    expect(evaluateProjectPolicy(policy, 'code.merge', { ciOk: true, confirm: false }).ok).toBe(false)
    expect(evaluateProjectPolicy(policy, 'code.merge', { ciOk: true, confirm: true }).ok).toBe(true)
  })

  it('blocks protected paths and changed-file limits', () => {
    const policy = normalizeProjectPolicy({ preset: 'balanced', limits: { maxChangedFiles: 2 } })
    const protectedDecision = evaluateProjectPolicy(policy, 'code.review_files', { files: ['src/App.jsx', '.env'] })
    expect(protectedDecision.ok).toBe(false)
    expect(protectedDecision.blockers[0].message).toContain('Protected paths')
    const limitDecision = evaluateProjectPolicy(policy, 'code.review_files', { files: ['a.js', 'b.js', 'c.js'] })
    expect(limitDecision.ok).toBe(false)
    expect(limitDecision.blockers[0].message).toContain('changed-file limit')
  })

  it('matches glob-like policy paths', () => {
    expect(pathMatchesPolicyPattern('nested/.env', ['**/.env'])).toBe(true)
    expect(pathMatchesPolicyPattern('server/auth/login.js', ['**/auth/**'])).toBe(true)
  })

  it('applies policy to super workflow options while preserving explicit confirmation', () => {
    const balanced = normalizeProjectPolicy({ preset: 'balanced' })
    expect(applyPolicyToSuperOptions({ autoMerge: true, confirmMerge: false }, balanced).autoMerge).toBe(false)
    expect(applyPolicyToSuperOptions({ autoMerge: true, confirmMerge: true }, balanced).autoMerge).toBe(true)
    const safe = normalizeProjectPolicy({ preset: 'safe' })
    expect(applyPolicyToSuperOptions({ autoFinalize: true, autoMerge: true, confirmMerge: true }, safe).autoFinalize).toBe(false)
    expect(applyPolicyToSuperOptions({ autoFinalize: true, autoMerge: true, confirmMerge: true }, safe).autoMerge).toBe(false)
  })
})
