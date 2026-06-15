import { describe, expect, it } from 'vitest'
import { allowedToolsForPhase, deriveTaskPhase, hasUnverifiedCodeEdit, isAllowedInPhase } from '../server/taskStateMachine.js'

describe('task state machine', () => {
  it('starts medium/high tasks in discovery until grounded', () => {
    const phase = deriveTaskPhase({
      agentContext: { task: { type: 'repo_analysis', complexity: 'high' } },
      agentState: { plan: { steps: [] } },
      recentToolHistory: [],
    })
    expect(phase.phase).toBe('discover')
  })

  it('moves to plan after discovery for complex tasks without a plan', () => {
    const phase = deriveTaskPhase({
      agentContext: { task: { type: 'coding_change', complexity: 'high' } },
      agentState: { plan: { steps: [] } },
      recentToolHistory: [{ tool: 'list_files', ok: true }],
    })
    expect(phase.phase).toBe('plan')
  })

  it('moves to verify after code edits until verification runs', () => {
    const history = [{ tool: 'edit_file', ok: true, args: '{"path":"src/App.jsx"}' }]
    expect(hasUnverifiedCodeEdit(history)).toBe(true)
    expect(deriveTaskPhase({ agentContext: { task: { type: 'coding_change', complexity: 'high' } }, agentState: { plan: { steps: [{ idx: 1, done: true }] } }, recentToolHistory: history }).phase).toBe('verify')
    expect(hasUnverifiedCodeEdit([...history, { tool: 'verify_code', ok: true }])).toBe(false)
  })

  it('uses phases as guidance without blocking automatic agent tools', () => {
    expect(isAllowedInPhase('edit_file', 'discover')).toBe(true)
    expect(isAllowedInPhase('shell_session_run', 'verify')).toBe(true)
    expect(isAllowedInPhase('verify_code', 'verify')).toBe(true)
    expect(allowedToolsForPhase('execute')).toBeNull()
    expect(allowedToolsForPhase('verify')).toBeNull()
  })
})
