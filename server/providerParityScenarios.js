export const PROVIDER_PARITY_SCENARIOS = [
  {
    id: 'chat_ok',
    type: 'chat',
    label: 'Plain chat OK reply',
    description: 'Provider returns a short direct answer for a trivial prompt.',
  },
  {
    id: 'agent_file_write',
    type: 'agent',
    label: 'Agent creates a file',
    description: 'Agent performs a minimal scoped workspace write and finishes cleanly.',
  },
  {
    id: 'agent_local_test',
    type: 'agent',
    label: 'Agent performs explicit local testing',
    description: 'Agent creates a tiny project and proves local test execution through runtime evidence.',
  },
]

export function listProviderParityScenarios() {
  return PROVIDER_PARITY_SCENARIOS.map((s) => ({ ...s }))
}

export function getProviderParityScenario(id = '') {
  return PROVIDER_PARITY_SCENARIOS.find((s) => s.id === String(id || '').trim()) || null
}

export function defaultProviderParityScenarioIds({ includeAgent = true } = {}) {
  return includeAgent
    ? ['chat_ok', 'agent_file_write', 'agent_local_test']
    : ['chat_ok']
}

export function scenarioChatMessages(id = '') {
  if (id === 'chat_ok') return [{ role: 'user', content: 'Ответь ровно: OK' }]
  return [{ role: 'user', content: 'Ответь ровно: OK' }]
}

export function scenarioAgentPrompt(id = '', filePrefix = 'provider-parity') {
  if (id === 'agent_file_write') {
    return `Создай в workspace файл ${filePrefix}-write.txt с текстом OK и ответь кратко. Ничего не деплой.`
  }
  if (id === 'agent_local_test') {
    return [
      `Создай в workspace папку ${filePrefix}-local-test.`,
      'Внутри создай локальный package.json, sum.js и test-sum.js.',
      'Обязательно выполни реальный локальный тест и укажи точный результат проверки.',
      'Ничего не деплой.',
    ].join(' ')
  }
  return `Создай в workspace файл ${filePrefix}-write.txt с текстом OK и ответь кратко. Ничего не деплой.`
}

export default PROVIDER_PARITY_SCENARIOS
