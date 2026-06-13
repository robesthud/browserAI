import { describe, expect, it } from 'vitest'
import { allowedToolsForTask, isToolAllowed, toolProfileForTask } from '../server/toolAllowlist.js'

describe('tool allowlist', () => {
  it('maps task types to profiles', () => {
    expect(toolProfileForTask({ type: 'coding_change' })).toBe('code')
    expect(toolProfileForTask({ type: 'deploy_ops' })).toBe('ops')
    expect(toolProfileForTask({ type: 'research' })).toBe('research')
  })

  it('allows coding tools but blocks browser-only tools in code profile', () => {
    const allowed = allowedToolsForTask({ type: 'coding_change' })
    expect(isToolAllowed('edit_file', allowed)).toBe(true)
    expect(isToolAllowed('npm_test', allowed)).toBe(true)
    expect(isToolAllowed('browser_click', allowed)).toBe(false)
  })

  it('returns no restrictions for lite runs', () => {
    expect(allowedToolsForTask({ type: 'simple_answer' }, { lite: true })).toBeNull()
  })
})
