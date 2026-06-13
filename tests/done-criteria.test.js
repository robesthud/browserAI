import { describe, expect, it } from 'vitest'
import { buildDoneCriteriaDirective } from '../server/agentCore.js'

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
})
