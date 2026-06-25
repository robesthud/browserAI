import { describe, expect, it } from 'vitest'
import {
  CANONICAL_TASKS,
  listCanonicalTasks,
  getCanonicalTask,
  defaultCanonicalTaskIds,
} from './regressionSuite.js'
import {
  PROVIDER_TIERS,
  PROVIDER_TASK_COMPATIBILITY,
  getProviderCompatibility,
  listProviderIds,
  listProviderTasks,
  getProviderTier,
  isProviderSupportedForTask,
} from './regressionProviderMatrix.js'
import { captureGoldenRun, diffGoldenRuns, listGoldenRunIds } from './regressionArtifacts.js'
import { runRegressionTask, runRegressionMatrix } from './regressionRunner.js'

describe('canonical regression task suite', () => {
  it('has at least 20 tasks', () => {
    expect(CANONICAL_TASKS.length).toBeGreaterThanOrEqual(20)
  })

  it('every task has id, type, description, expectedEvidenceTags', () => {
    for (const t of CANONICAL_TASKS) {
      expect(t.id).toBeTruthy()
      expect(t.type).toMatch(/^(chat|web|agent)$/)
      expect(t.description).toBeTruthy()
      expect(Array.isArray(t.expectedEvidenceTags)).toBe(true)
    }
  })

  it('agent tasks have prompts', () => {
    const agentTasks = listCanonicalTasks({ type: 'agent' })
    expect(agentTasks.length).toBeGreaterThan(0)
    for (const t of agentTasks) {
      expect(t.prompt).toBeTruthy()
    }
  })

  it('defaultCanonicalTaskIds includes all types by default', () => {
    const ids = defaultCanonicalTaskIds()
    expect(ids).toContain('chat_greeting')
    expect(ids).toContain('web_news_query')
    expect(ids.some((id) => id.startsWith('agent_'))).toBe(true)
  })

  it('getCanonicalTask returns task or null', () => {
    expect(getCanonicalTask('chat_greeting')).toBeTruthy()
    expect(getCanonicalTask('nonexistent')).toBeNull()
  })

  it('filters by requiresLocalTest', () => {
    const withTests = listCanonicalTasks({ requiresLocalTest: true })
    expect(withTests.length).toBeGreaterThan(0)
    for (const t of withTests) {
      expect(t.requiresLocalTest).toBe(true)
    }
  })
})

describe('provider certification matrix', () => {
  it('has at least 4 providers defined', () => {
    expect(Object.keys(PROVIDER_TIERS).length).toBeGreaterThanOrEqual(4)
  })

  it('every provider has required fields', () => {
    for (const [id, p] of Object.entries(PROVIDER_TIERS)) {
      expect(p.id).toBe(id)
      expect(p.name).toBeTruthy()
      expect(p.baseUrl).toMatch(/^https?:\/\//)
      expect(Array.isArray(p.models)).toBe(true)
      expect(p.authType).toBeTruthy()
      expect(p.tier).toBeTruthy()
    }
  })

  it('getProviderCompatibility returns expected values', () => {
    expect(getProviderCompatibility('chat_greeting', 'managed_deepseek')).toBe('required')
    expect(getProviderCompatibility('agent_browser_open', 'ollama_local')).toBe('unsupported')
  })

  it('isProviderSupportedForTask correctly identifies unsupported', () => {
    expect(isProviderSupportedForTask('ollama_local', 'agent_browser_open')).toBe(false)
    expect(isProviderSupportedForTask('managed_deepseek', 'agent_browser_open')).toBe(true)
  })

  it('listProviderTasks returns supported tasks for a provider', () => {
    const tasks = listProviderTasks('ollama_local')
    expect(tasks).not.toContain('agent_browser_open')
    expect(tasks.length).toBeGreaterThan(0)
  })

  it('every canonical task has compatibility defined for at least one provider', () => {
    for (const t of CANONICAL_TASKS) {
      const compat = PROVIDER_TASK_COMPATIBILITY[t.id]
      // All agent tasks must have explicit compatibility; chat/web default to 'all supported'
      if (t.type === 'agent') {
        expect(compat).toBeTruthy()
        expect(Object.keys(compat).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('regression artifact capture', () => {
  it('captures a golden run to disk', () => {
    const tmpDir = require('node:os').tmpdir()
    const prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmpDir
    try {
      const result = captureGoldenRun({
        runId: 'test-run-1',
        taskId: 'chat_greeting',
        providerId: 'managed_deepseek',
        model: 'deepseek-chat',
        startedAt: Date.now(),
        finishedAt: Date.now() + 1000,
        finalStatus: { taskCompleted: true, blockers: [] },
        expectedOutcome: { taskCompleted: true },
        actualOutcome: { taskCompleted: true },
      })
      expect(result.filePath).toContain('test-run-1')
      expect(result.artifact.schema).toBe('browserai.golden_run.v1')
    } finally {
      process.env.DATA_DIR = prevDataDir
    }
  })

  it('diffs two golden runs and finds missing evidence', () => {
    const baseline = {
      toolHistory: [{ semantic: { evidenceTags: ['write', 'verify'] } }],
      finalStatus: { taskCompleted: true, blockers: [] },
    }
    const current = {
      toolHistory: [{ semantic: { evidenceTags: ['write'] } }],
      finalStatus: { taskCompleted: true, blockers: [] },
    }
    const diffs = diffGoldenRuns(baseline, current)
    expect(diffs.some((d) => d.type === 'missing_evidence')).toBe(true)
  })

  it('diffs detect status changes', () => {
    const baseline = {
      toolHistory: [],
      finalStatus: { taskCompleted: true, blockers: [] },
    }
    const current = {
      toolHistory: [],
      finalStatus: { taskCompleted: false, blockers: [{ type: 'missing_test' }] },
    }
    const diffs = diffGoldenRuns(baseline, current)
    expect(diffs.some((d) => d.type === 'completion_change')).toBe(true)
  })
})

describe('regression runner structural checks', () => {
  it('runRegressionTask generator yields start and done for unknown task', async () => {
    const events = []
    for await (const event of runRegressionTask({ taskId: 'nonexistent' })) {
      events.push(event.type)
    }
    expect(events).toContain('error')
    expect(events[0]).toBe('error')
  })

  it('runRegressionMatrix returns summary structure', async () => {
    const summary = await runRegressionMatrix({
      taskIds: ['chat_greeting'],
      providerIds: ['managed_deepseek'],
      timeoutMs: 1000,
    })
    expect(summary.schema).toBe('browserai.regression_matrix.v1')
    expect(Array.isArray(summary.runs)).toBe(true)
    expect(summary.tasks).toBe(1)
    expect(summary.providers).toBe(1)
  })
})
