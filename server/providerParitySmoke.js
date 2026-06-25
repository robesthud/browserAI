import { listKeysSafe } from './db.js'
import { callLLM } from './llmClient.js'
import { runAgent } from './agentLoop.js'
import { createAgentSseCapture } from './agentSseCapture.js'
import { resolveProviderFromInput } from './providerResolution.js'
import { safeErrorMessage, safeProviderError } from './errorSanitizer.js'
import {
  listProviderParityScenarios,
  getProviderParityScenario,
  defaultProviderParityScenarioIds,
  scenarioChatMessages,
  scenarioAgentPrompt,
} from './providerParityScenarios.js'

function providerDescriptor(key = {}) {
  return {
    keyId: key.id,
    name: key.name || key.id,
    baseUrl: key.baseUrl,
    model: key.model,
    hasSecret: Boolean(key.hasSecret),
    useStoredSecret: Boolean(key.useStoredSecret),
  }
}

export function listProviderParityTargets({ activeOnly = false } = {}) {
  const keys = listKeysSafe()
  const filtered = activeOnly ? keys.filter((k) => k.active) : keys
  return filtered.filter((k) => k.baseUrl && k.model && k.hasSecret).map(providerDescriptor)
}

async function runChatScenario({ keyId = '', model = '', scenarioId = 'chat_ok' } = {}) {
  const provider = resolveProviderFromInput({ keyId, useStoredSecret: true, model }, { requireBearer: true })
  const reply = await callLLM({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authType: provider.authType || 'bearer',
    authHeader: provider.authHeader || '',
    extraHeaders: provider.extraHeaders || {},
    model: provider.model,
    messages: scenarioChatMessages(scenarioId),
    temperature: 0,
  })
  const text = String(reply?.text || '').trim()
  return { ok: Boolean(text), text: text.slice(0, 200) }
}

async function runAgentScenario({ keyId = '', model = '', chatId = '', scenarioId = 'agent_file_write' } = {}) {
  const provider = resolveProviderFromInput({ keyId, useStoredSecret: true, model, forceAgent: true }, { requireBearer: true })
  const res = createAgentSseCapture()
  const prompt = scenarioAgentPrompt(scenarioId, `provider-smoke-${keyId}`)
  const maxSteps = scenarioId === 'agent_local_test' ? 20 : 12
  await runAgent({
    provider,
    history: [{ role: 'user', content: prompt }],
    workspaceScope: chatId,
    maxSteps,
    res,
  })
  const events = res.getEvents()
  const done = events.find((e) => e.event === 'done')?.payload || null
  const assistant = res.getAssistantText()
  const runtimeEvidenceMentioned = /Runtime evidence/i.test(String(assistant || ''))
  return {
    ok: Boolean(done?.reason === 'final' && assistant),
    doneReason: done?.reason || '',
    assistant: String(assistant || '').slice(0, 500),
    eventCount: events.length,
    runtimeEvidenceMentioned,
  }
}

function summarizeMatrix(rows = []) {
  const scenarioMap = new Map()
  for (const row of rows) {
    for (const scenario of row.scenarios || []) {
      if (!scenarioMap.has(scenario.id)) scenarioMap.set(scenario.id, { id: scenario.id, passed: 0, failed: 0 })
      const item = scenarioMap.get(scenario.id)
      if (scenario.ok) item.passed += 1
      else item.failed += 1
    }
  }
  return [...scenarioMap.values()]
}

export async function runProviderParitySmoke({ keyIds = [], activeOnly = false, includeAgent = true } = {}) {
  return runProviderParityMatrix({ keyIds, activeOnly, scenarioIds: defaultProviderParityScenarioIds({ includeAgent }) })
}

export async function runProviderParityMatrix({ keyIds = [], activeOnly = false, scenarioIds = [], maxProviders = 0 } = {}) {
  let targets = listProviderParityTargets({ activeOnly }).filter((k) => !keyIds.length || keyIds.includes(k.keyId))
  if (Number(maxProviders) > 0) targets = targets.slice(0, Number(maxProviders))
  const selectedScenarios = (scenarioIds.length ? scenarioIds : defaultProviderParityScenarioIds({ includeAgent: true }))
    .map((id) => getProviderParityScenario(id))
    .filter(Boolean)
  const startedAt = new Date().toISOString()
  const results = []
  for (const target of targets) {
    const row = { provider: target, scenarios: [], ok: false }
    for (const scenario of selectedScenarios) {
      const result = { id: scenario.id, type: scenario.type, ok: false }
      try {
        if (scenario.type === 'chat') Object.assign(result, await runChatScenario({ ...target, scenarioId: scenario.id }))
        else Object.assign(result, await runAgentScenario({ ...target, scenarioId: scenario.id, chatId: `provider-smoke-${target.keyId}-${scenario.id}` }))
      } catch (e) {
        result.error = safeErrorMessage(e)
        result.providerError = safeProviderError(e?.providerError || null)
      }
      result.ok = Boolean(result.ok)
      row.scenarios.push(result)
    }
    row.ok = row.scenarios.every((s) => s.ok)
    results.push(row)
  }
  return {
    schema: 'browserai.provider_parity_smoke.v2',
    startedAt,
    scenarios: selectedScenarios.map((s) => ({ id: s.id, type: s.type, label: s.label })),
    count: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    scenarioSummary: summarizeMatrix(results),
    results,
  }
}

export default runProviderParitySmoke
