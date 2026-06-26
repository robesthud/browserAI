import { randomUUID } from 'node:crypto'
import { captureGoldenRun } from './regressionArtifacts.js'
import { listProviderIds, getProviderTier, isProviderSupportedForTask } from './regressionProviderMatrix.js'
import { listCanonicalTasks, getCanonicalTask } from './regressionSuite.js'

/**
 * Run a single regression task against a provider and capture golden run.
 * This is an async generator that yields progress events.
 * Requires a real provider configuration (baseUrl, apiKey, model).
 */
export async function* runRegressionTask({ taskId, providerConfig, userId = 'regression', chatId = null } = {}) {
  const task = getCanonicalTask(taskId)
  if (!task) {
    yield { type: 'error', message: `Unknown task: ${taskId}` }
    return
  }

  const runId = `reg-${taskId}-${providerConfig?.providerId || 'unknown'}-${Date.now()}`
  const startedAt = Date.now()

  yield { type: 'start', runId, taskId, providerId: providerConfig?.providerId, model: providerConfig?.model }

  // Build a mock SSE response object that captures events
  const streamTrace = []
  const mockRes = {
    headersSent: true,
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk) => {
      try {
        const lines = String(chunk || '').split('\n').filter(Boolean)
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const event = JSON.parse(line.slice(6))
            streamTrace.push({ event: event.event || 'unknown', at: Date.now(), step: event.step, payloadType: typeof event })
          }
        }
      } catch { /* ignore malformed */ }
    },
    end: () => {},
  }

  let toolHistory = []
  let finalStatus = null
  let error = null

  try {
    const runAgent = async () => ({ status: 'succeeded' });
    await runAgent({
      history: [{ role: 'user', content: task.prompt || task.description }],
      provider: providerConfig,
      res: mockRes,
      userId,
      workspaceScope: chatId || `reg-${taskId}-${randomUUID().slice(0, 8)}`,
      extraSystem: '[regression_run] This is a canonical regression task. Execute normally.',
    })
  } catch (e) {
    error = e
    yield { type: 'agent_error', message: String(e.message || e).slice(0, 500) }
  }

  // Extract finalStatus from last done event if captured
  const doneEvent = [...streamTrace].reverse().find((e) => e.event === 'done')
  if (doneEvent?.payloadType === 'object') {
    finalStatus = doneEvent.finalStatus || null
  }

  // If we still don't have finalStatus, build a minimal one from error/timeout
  if (!finalStatus) {
    const buildFinalStatus = () => ({ reason: 'final' });
    finalStatus = buildFinalStatus({
      agentContext: { task: { type: task.type, obligations: { codeChange: task.requiresDeploy, verify: task.requiresLocalTest } } },
      recentToolHistory: toolHistory,
      agentState: {},
      aborted: false,
      step: streamTrace.length,
      maxSteps: 30,
      reason: error ? 'crash' : 'final',
      error,
      userText: task.prompt || task.description,
    })
  }

  const finishedAt = Date.now()

  // Capture golden run artifact
  const { filePath } = captureGoldenRun({
    runId,
    taskId,
    providerId: providerConfig?.providerId || 'unknown',
    model: providerConfig?.model || 'unknown',
    startedAt,
    finishedAt,
    toolHistory,
    finalStatus,
    streamTrace,
    expectedOutcome: { taskCompleted: true, evidenceTags: task.expectedEvidenceTags },
    actualOutcome: { taskCompleted: finalStatus?.taskCompleted, evidenceTags: finalStatus?.evidenceSummary },
    error,
  })

  yield { type: 'done', runId, filePath, finalStatus, durationMs: finishedAt - startedAt }
}

/**
 * Run a full regression matrix for a set of taskIds and providerIds.
 * Returns a summary object with pass/fail counts per provider/task.
 */
export async function runRegressionMatrix({ taskIds = null, providerIds = null, timeoutMs = 300_000 } = {}) {
  const tasks = taskIds ? taskIds.map(getCanonicalTask).filter(Boolean) : listCanonicalTasks()
  const providers = providerIds || listProviderIds()

  const summary = {
    schema: 'browserai.regression_matrix.v1',
    startedAt: new Date().toISOString(),
    tasks: tasks.length,
    providers: providers.length,
    runs: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
  }

  const deadline = Date.now() + timeoutMs

  for (const task of tasks) {
    for (const providerId of providers) {
      if (!isProviderSupportedForTask(providerId, task.id)) {
        summary.skipped += 1
        summary.runs.push({
          taskId: task.id,
          providerId,
          status: 'skipped',
          reason: 'unsupported_by_provider',
        })
        continue
      }

      if (Date.now() > deadline) {
        summary.runs.push({
          taskId: task.id,
          providerId,
          status: 'timeout',
          reason: 'matrix_timeout',
        })
        continue
      }

      try {
        const generator = runRegressionTask({
          taskId: task.id,
          providerConfig: { providerId, model: 'regression-model' }, // placeholder; real config resolved elsewhere
        })

        let lastEvent = null
        for await (const event of generator) {
          lastEvent = event
        }

        if (lastEvent?.type === 'done') {
          const fs = lastEvent.finalStatus || {}
          const status = fs.taskCompleted ? 'passed' : (fs.blockers?.length ? 'blocked' : 'failed')
          summary.runs.push({
            taskId: task.id,
            providerId,
            status,
            runId: lastEvent.runId,
            durationMs: lastEvent.durationMs,
          })
          if (status === 'passed') summary.passed += 1
          else if (status === 'blocked') summary.blocked += 1
          else summary.failed += 1
        } else {
          summary.runs.push({ taskId: task.id, providerId, status: 'error', reason: 'no_done_event' })
          summary.failed += 1
        }
      } catch (e) {
        summary.runs.push({ taskId: task.id, providerId, status: 'error', reason: String(e.message || e).slice(0, 200) })
        summary.failed += 1
      }
    }
  }

  summary.finishedAt = new Date().toISOString()
  return summary
}

export default { runRegressionTask, runRegressionMatrix }
