import { describe, expect, it } from 'vitest'
import { allowedToolsForTask, isToolAllowed, toolProfileForTask } from '../server/toolAllowlist.js'

describe('tool allowlist', () => {
  it('maps all real tasks to the broad automatic main agent profile', () => {
    expect(toolProfileForTask({ type: 'coding_change' })).toBe('main_agent')
    expect(toolProfileForTask({ type: 'deploy_ops' })).toBe('main_agent')
    expect(toolProfileForTask({ type: 'research' })).toBe('main_agent')
  })

  it('keeps core automatic agent tools available together', () => {
    const allowed = allowedToolsForTask({ type: 'coding_change' })
    expect(isToolAllowed('edit_file', allowed)).toBe(true)
    expect(isToolAllowed('npm_test', allowed)).toBe(true)
    expect(isToolAllowed('browser_click', allowed)).toBe(true)
    expect(isToolAllowed('git_clone', allowed)).toBe(true)
    expect(isToolAllowed('shell_session_run', allowed)).toBe(true)
  })

  it('returns no restrictions for lite runs', () => {
    expect(allowedToolsForTask({ type: 'simple_answer' }, { lite: true })).toBeNull()
  })
})
