import { describe, expect, it } from 'vitest'
import { initOperatorMode, listOperatorProjects, OPERATOR_MISSION_TYPES } from '../server/operatorMode.js'

describe('operator mode', () => {
  it('initializes default personal BrowserAI project and mission catalog', () => {
    initOperatorMode()
    const userId = `op-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const projects = listOperatorProjects({ userId })
    expect(projects.some((p) => p.id === 'browserai')).toBe(true)
    expect(projects.find((p) => p.id === 'browserai')?.productionPath).toBeTruthy()
    expect(OPERATOR_MISSION_TYPES.map((m) => m.id)).toContain('custom_agent')
    expect(OPERATOR_MISSION_TYPES.map((m) => m.id)).toContain('safe_deploy')
  })
})
