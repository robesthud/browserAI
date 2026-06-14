import { describe, expect, it } from 'vitest'
import { buildAutonomousRuntimeDirective, buildDoneCriteriaDirective } from '../server/agentCore.js'

describe('done criteria directives', () => {
  it('defines coding change completion requirements', () => {
    const text = buildDoneCriteriaDirective({ task: { type: 'coding_change' } })
    expect(text).toContain('[done_criteria]')
    expect(text).toContain('verify_code')
    expect(text).toContain('npm_test')
  })

  it('defines repo analysis grounding requirements', () => {
    const text = buildDoneCriteriaDirective({ task: { type: 'repo_analysis' } })
    expect(text).toContain('list_files')
    expect(text).toContain('read README')
  })

  it('does not add criteria for generic/simple tasks', () => {
    expect(buildDoneCriteriaDirective({ task: { type: 'general_agent_task' } })).toBe('')
    expect(buildDoneCriteriaDirective({ task: { type: 'simple_answer' } })).toBe('')
  })

  it('adds autonomous bash execution guidance for real work', () => {
    const text = buildAutonomousRuntimeDirective({ task: { type: 'coding_change', complexity: 'high' } })
    expect(text).toContain('[autonomous_agent_mode]')
    expect(text).toContain('call bash yourself')
    expect(text).toContain('inspect with list_files/read_file/bash')
    expect(buildAutonomousRuntimeDirective({ task: { type: 'simple_answer', complexity: 'low' } })).toBe('')
  })
})
