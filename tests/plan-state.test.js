import { describe, expect, it } from 'vitest'
import { createAgentState, updateAgentStateFromTool } from '../server/agentCore.js'
import { renderAgentStateDigest } from '../server/contextManager.js'

describe('agent plan state and action memory', () => {
  it('accepts plan_set result.steps and advances with plan_check', () => {
    const state = createAgentState({ agentContext: { task: { goal: 'test goal' } }, history: [] })
    updateAgentStateFromTool(state, 'plan_set', {
      ok: true,
      result: { title: 'Plan', steps: [{ idx: 1, text: 'Read files' }, { idx: 2, text: 'Patch code' }] },
    })
    expect(state.plan.steps).toHaveLength(2)
    expect(state.currentStep).toBe('Read files')

    updateAgentStateFromTool(state, 'plan_check', { ok: true, result: { checked: [1] } })
    expect(state.plan.steps[0].done).toBe(true)
    expect(state.currentStep).toBe('Patch code')
  })

  it('renders recent tool names with compact args in the digest', () => {
    const state = createAgentState({ agentContext: { task: { goal: 'test goal' } }, history: [] })
    const digest = renderAgentStateDigest(state, [
      { tool: 'read_file', ok: true, args: '{"path":"README.md"}' },
      { tool: 'edit_file', ok: false, args: '{"path":"src/App.jsx"}' },
    ])
    expect(digest).toContain('✓ read_file({"path":"README.md"})')
    expect(digest).toContain('✗ edit_file({"path":"src/App.jsx"})')
  })
})
