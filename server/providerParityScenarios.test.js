import { describe, expect, it } from 'vitest'
import {
  listProviderParityScenarios,
  getProviderParityScenario,
  defaultProviderParityScenarioIds,
  scenarioChatMessages,
  scenarioAgentPrompt,
} from './providerParityScenarios.js'

describe('providerParityScenarios', () => {
  it('lists stable scenarios with ids and types', () => {
    const scenarios = listProviderParityScenarios()
    expect(Array.isArray(scenarios)).toBe(true)
    expect(scenarios.length).toBeGreaterThanOrEqual(3)
    expect(scenarios.every((s) => s.id && s.type)).toBe(true)
  })

  it('provides default scenario ids for smoke and includes agent cases by default', () => {
    const ids = defaultProviderParityScenarioIds({ includeAgent: true })
    expect(ids).toContain('chat_ok')
    expect(ids).toContain('agent_file_write')
    expect(ids).toContain('agent_local_test')
  })

  it('returns scenario-specific prompts/messages', () => {
    expect(scenarioChatMessages('chat_ok')[0].content).toContain('OK')
    expect(scenarioAgentPrompt('agent_local_test', 'x')).toContain('реальный локальный тест')
    expect(getProviderParityScenario('agent_file_write')?.type).toBe('agent')
  })
})
