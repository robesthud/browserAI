import { describe, expect, it } from 'vitest'
import { categoryOf, normalizePolicy, requiresApproval, savePolicy } from '../server/approvalGate.js'

describe('approval policy', () => {
  it('uses the same categories as the UI', () => {
    expect(categoryOf('bash')).toBe('bash')
    expect(categoryOf('verify_code')).toBe('bash')
    expect(categoryOf('ops_run_action')).toBe('deploy')
    expect(categoryOf('web_search')).toBe('net')
    expect(categoryOf('edit_file')).toBe('write')
    expect(categoryOf('mcp__github__search')).toBe('mcp')
    expect(categoryOf('github_actions_wait')).toBe('read')
    expect(categoryOf('app_health_check')).toBe('read')
  })

  it('normalizes v2 policy values', () => {
    const p = normalizePolicy({ bash: 'auto', deploy: 'ask', git: 'wat' })
    expect(p.bash).toBe('auto')
    expect(p.deploy).toBe('ask')
    expect(p.git).toBe('ask')
  })

  it('honors saved per-user policy for bash/git/deploy', () => {
    const userId = `approval-test-${Date.now()}-${Math.random()}`
    savePolicy(userId, { read: 'auto', write: 'auto', net: 'auto', bash: 'auto', git: 'auto', mcp: 'auto', deploy: 'auto' })
    expect(requiresApproval('bash', userId)).toBe(false)
    expect(requiresApproval('git_push', userId)).toBe(false)
    expect(requiresApproval('ops_run_action', userId)).toBe(false)

    savePolicy(userId, { read: 'auto', write: 'auto', net: 'auto', bash: 'ask', git: 'ask', mcp: 'ask', deploy: 'ask' })
    expect(requiresApproval('bash', userId)).toBe(true)
    expect(requiresApproval('git_push', userId)).toBe(true)
    expect(requiresApproval('ops_run_action', userId)).toBe(true)
    expect(requiresApproval('web_search', userId)).toBe(false)
  })
})
