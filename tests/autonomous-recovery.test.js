import { describe, expect, it } from 'vitest'
import { classifyFailure, recommendAutoFix } from '../server/failureClassifier.js'
import { recoveryGraph, shouldAutoRecover, superviseRecoveries } from '../server/autonomousRecovery.js'

describe('autonomous recovery router', () => {
  it('allows safe code recovery but blocks approval-required ops', () => {
    const testRec = recommendAutoFix(classifyFailure({ error: 'AssertionError test failed' }))
    expect(testRec.safeToAutoStart).toBe(true)
    expect(shouldAutoRecover({ recommendation: testRec, source: 'job', entityType: 'job', entityId: `j-${Date.now()}`, userId: 'u' }).ok).toBe(true)

    const deployRec = recommendAutoFix(classifyFailure({ error: 'DEPLOY FAILED health connection refused' }))
    expect(deployRec.requiresApproval).toBe(true)
    expect(shouldAutoRecover({ recommendation: deployRec, source: 'deploy', entityType: 'deploy', entityId: `d-${Date.now()}`, userId: 'u' }).ok).toBe(false)
  })

  it('exposes recovery graph and supervision safely', () => {
    const graph = recoveryGraph({ userId: 'u-test', limit: 5 })
    expect(Array.isArray(graph.nodes)).toBe(true)
    expect(Array.isArray(graph.edges)).toBe(true)
    expect(Array.isArray(superviseRecoveries({ limit: 5 }))).toBe(true)
  })
})
