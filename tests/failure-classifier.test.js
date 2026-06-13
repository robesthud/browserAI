import { describe, expect, it } from 'vitest'
import { classifyFailure, recommendAutoFix } from '../server/failureClassifier.js'

describe('failure classifier and auto-fix policy', () => {
  it('classifies common failure categories', () => {
    expect(classifyFailure({ error: 'npm ERR! test failed' }).category).toBe('dependency_failure')
    expect(classifyFailure({ error: 'DEPLOY FAILED health curl (7) connection refused' }).category).toBe('health_failure')
    expect(classifyFailure({ error: 'fatal: Unable to create .git/index.lock' }).category).toBe('git_lock_failure')
    expect(classifyFailure({ error: '401 bad credentials' }).category).toBe('auth_failure')
    expect(classifyFailure({ error: 'No space left on device' }).category).toBe('disk_failure')
  })

  it('returns safe recommendations and approval requirements', () => {
    const auth = recommendAutoFix(classifyFailure({ error: '403 forbidden' }))
    expect(auth.requiresApproval).toBe(true)
    const test = recommendAutoFix(classifyFailure({ error: 'AssertionError expected true' }))
    expect(test.action).toBe('code_task')
    expect(test.safeToAutoStart).toBe(true)
  })
})
