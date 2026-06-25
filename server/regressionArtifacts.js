import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Capture a golden run artifact for regression analysis.
 * Writes structured JSON to DATA_DIR/regression/golden-runs/.
 */
export function captureGoldenRun({
  runId,
  taskId,
  providerId,
  model,
  startedAt,
  finishedAt,
  messages,
  toolHistory,
  finalStatus,
  streamTrace,
  expectedOutcome,
  actualOutcome,
  error,
} = {}) {
  const dataDir = process.env.DATA_DIR || '/data'
  // RA-1: sanitize runId to prevent path traversal
  const safeRunId = String(runId || 'unknown').replace(/[/\\\0.]/g, '_').slice(0, 128)
  const outDir = join(dataDir, 'regression', 'golden-runs', safeRunId)
  mkdirSync(outDir, { recursive: true })

  const artifact = {
    schema: 'browserai.golden_run.v1',
    runId: String(runId || ''),
    taskId: String(taskId || ''),
    providerId: String(providerId || ''),
    model: String(model || ''),
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
    durationMs: startedAt && finishedAt ? finishedAt - startedAt : null,
    messages: (messages || []).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 50000) : '[non-string]',
      tool_calls: m.tool_calls ? m.tool_calls.map((tc) => ({ name: tc.name || tc.function?.name, id: tc.id })) : undefined,
    })),
    toolHistory: (toolHistory || []).map((h) => ({
      tool: h.tool,
      ok: h.ok,
      at: h.at,
      semantic: h.semantic ? {
        family: h.semantic.family,
        action: h.semantic.action,
        path: h.semantic.path,
        command: h.semantic.command,
        verificationKind: h.semantic.verificationKind,
        evidenceTags: h.semantic.evidenceTags,
      } : undefined,
    })),
    finalStatus: finalStatus || null,
    streamTrace: (streamTrace || []).map((e) => ({
      event: e.event,
      step: e.step,
      at: e.at,
      payloadType: typeof e.payload,
    })),
    expectedOutcome: expectedOutcome || null,
    actualOutcome: actualOutcome || null,
    error: error ? { message: String(error.message || error).slice(0, 2000) } : null,
  }

  const filePath = join(outDir, 'artifact.json')
  // RA-3: JSON.stringify may throw on circular refs; writeFileSync may throw on disk full
  try {
    writeFileSync(filePath, JSON.stringify(artifact, null, 2))
  } catch (e) {
    console.warn('[regressionArtifacts] captureGoldenRun write failed:', e.message)
    return { filePath: null, artifact, error: e.message }
  }
  return { filePath, artifact }
}

/**
 * Load a golden run artifact by runId.
 */
export function loadGoldenRun(runId) {
  try {
    const dataDir = process.env.DATA_DIR || '/data'
    const safeId2 = String(runId || '').replace(/[/\\\0.]/g, '_').slice(0, 128)
    const filePath = join(dataDir, 'regression', 'golden-runs', safeId2, 'artifact.json')
    const content = readFileSync(filePath, 'utf8')  // RA-2: use ESM import, not require()
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * Compare two golden runs and return diff summary.
 */
export function diffGoldenRuns(baseline, current) {
  const diffs = []
  if (!baseline || !current) {
    diffs.push({ type: 'missing', message: 'One of the runs is missing.' })
    return diffs
  }

  const baselineTags = new Set((baseline.toolHistory || []).flatMap((h) => h.semantic?.evidenceTags || []))
  const currentTags = new Set((current.toolHistory || []).flatMap((h) => h.semantic?.evidenceTags || []))

  const missingTags = [...baselineTags].filter((t) => !currentTags.has(t))
  const extraTags = [...currentTags].filter((t) => !baselineTags.has(t))

  if (missingTags.length) diffs.push({ type: 'missing_evidence', tags: missingTags, message: `Missing expected evidence tags: ${missingTags.join(', ')}` })
  if (extraTags.length) diffs.push({ type: 'extra_evidence', tags: extraTags, message: `Unexpected evidence tags: ${extraTags.join(', ')}` })

  const baselineBlocked = Boolean(baseline.finalStatus?.blockers?.length)
  const currentBlocked = Boolean(current.finalStatus?.blockers?.length)
  if (baselineBlocked !== currentBlocked) {
    diffs.push({ type: 'status_change', message: `Blocker status changed: baseline=${baselineBlocked}, current=${currentBlocked}` })
  }

  if (baseline.finalStatus?.taskCompleted !== current.finalStatus?.taskCompleted) {
    diffs.push({ type: 'completion_change', message: `taskCompleted changed: baseline=${baseline.finalStatus?.taskCompleted}, current=${current.finalStatus?.taskCompleted}` })
  }

  return diffs
}

export function listGoldenRunIds() {
  try {
    const dataDir = process.env.DATA_DIR || '/data'
    const dir = join(dataDir, 'regression', 'golden-runs')
    return readdirSync(dir).filter((d) => d !== '.' && d !== '..')  // RA-2: use ESM import
  } catch {
    return []
  }
}

export default { captureGoldenRun, loadGoldenRun, diffGoldenRuns, listGoldenRunIds }
