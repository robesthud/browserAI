import { describe, expect, it } from 'vitest'
import { initOperatorMode, listOperatorProjects, OPERATOR_MISSION_TYPES, classifyOperatorGoal, addOperatorMissionEvent, listOperatorMissionEvents } from '../server/operatorMode.js'

describe('operator mode', () => {
  it('initializes default personal BrowserAI project and mission catalog', () => {
    initOperatorMode()
    const userId = `op-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const projects = listOperatorProjects({ userId })
    expect(projects.some((p) => p.id === 'browserai')).toBe(true)
    expect(projects.find((p) => p.id === 'browserai')?.productionPath).toBeTruthy()
    expect(OPERATOR_MISSION_TYPES.map((m) => m.id)).toContain('universal_dev_task')
    expect(OPERATOR_MISSION_TYPES.map((m) => m.id)).toContain('code_task')
    expect(OPERATOR_MISSION_TYPES.map((m) => m.id)).toContain('custom_agent')
    expect(OPERATOR_MISSION_TYPES.map((m) => m.id)).toContain('safe_deploy')
  })

  it('routes arbitrary operator goals to a safe first action', () => {
    expect(classifyOperatorGoal('проверь почему деплой падает и логи').route).toBe('fix_deploy')
    expect(classifyOperatorGoal('задеплой новую версию').route).toBe('safe_deploy')
    expect(classifyOperatorGoal('добавь кнопку в интерфейс и протестируй').route).toBe('code_task')
    expect(classifyOperatorGoal('перезапусти сервис и проверь health').route).toBe('self_heal_restart')
  })


  it('records mission timeline events', () => {
    const missionId = `op-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    addOperatorMissionEvent({ missionId, userId: 'u1', type: 'info', title: 'Started', message: 'hello', data: { ok: true } })
    const events = listOperatorMissionEvents({ missionId, userId: 'u1' })
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].title).toBe('Started')
  })
})
