import fs from 'node:fs'
import path from 'node:path'

/**
 * replayArtifact.js
 *
 * Approach 6 — Observability. One replay artifact per run.
 *
 * Schema: `browserai.replay.v1`
 *
 * An artifact bundles everything needed to reproduce the run reasoning:
 *   - input (last user ask, full convo summary)
 *   - normalized tool history (from agentRuntimeSemantics)
 *   - structured finalStatus (from agentFinalStatus)
 *   - SSE event trace summary (counts + first/last + critical events)
 *   - run log reference
 *
 * Storage: `${DATA_DIR}/replays/${runId}.json`
 */

const SCHEMA = 'browserai.replay.v1'
function getDataDir() { return process.env.DATA_DIR || '/data' }

function ensureDir() {
  try { fs.mkdirSync(path.join(getDataDir(), 'replays'), { recursive: true }) } catch { /* ignore */ }
}

function replayPath(runId) {
  // A — strip path separators from runId to prevent traversal outside replays/
  const safe = String(runId || '').replace(/[/\\\0.]/g, '_').slice(0, 128)
  return path.join(getDataDir(), 'replays', `${safe}.json`)
}

export function buildReplayArtifact({
  runId = '',
  runLog = null,
  finalStatus = null,
  reason = null,
  history = [],
  sseTrace = [],
  provider = {},
  input = {},
  meta = {},
} = {}) {
  const runLogState = runLog?.getState ? runLog.getState() : runLog
  const normalizedHistory = (history || []).map((h) => ({
    tool: h.tool || null,
    family: h.semantic?.family || null,
    action: h.semantic?.action || null,
    path: h.semantic?.path || null,
    command: h.semantic?.command || null,
    args: h.args ? (typeof h.args === 'string' ? h.args : JSON.stringify(h.args)).slice(0, 240) : null,
    ok: Boolean(h.ok),
    outcome: h.outcome || null,
    evidenceTags: h.semantic?.evidenceTags || [],
    isCommit: h.semantic?.isCommit || false,
    isLocalTest: h.semantic?.isLocalTest || false,
    isVerify: h.semantic?.isVerify || false,
    isDeploy: h.semantic?.isDeploy || false,
    isHealthCheck: h.semantic?.isHealthCheck || false,
    isLogsCheck: h.semantic?.isLogsCheck || false,
    isInspect: h.semantic?.isInspect || false,
    verificationKind: h.semantic?.verificationKind || null,
    at: h.at || null,
  }))

  const sseSummary = summarizeSseTrace(sseTrace)
  const workspaceChanges = summarizeWorkspaceChanges(sseTrace)

  // The finalStatus block already carries the structured blockers/etc.
  // We attach the termination reason as a sibling so downstream KPI
  // aggregation can detect provider failures / max-steps / etc.
  // without re-parsing sseTrace.
  const finalStatusWithReason = finalStatus
    ? { reason: reason || finalStatus?.reason || null, ...finalStatus }
    : null

  const artifact = {
    schema: SCHEMA,
    runId,
    capturedAt: new Date().toISOString(),
    provider: {
      id: String(provider?.baseUrl || provider?.id || 'mock'),
      model: provider?.model || null,
    },
    input: {
      lastUserAsk: String(input?.lastUserAsk || '').slice(0, 2000),
      historySize: Number(input?.historySize) || 0,
      chatId: String(input?.chatId || ''),
      taskType: String(input?.taskType || 'task'),
    },
    run: runLogState ? {
      schema: runLogState.schema || 'browserai.run_log.v1',
      startedAt: runLogState.startedAt || null,
      finishedAt: runLogState.finishedAt || null,
      durationMs: runLogState.durationMs || 0,
      summary: runLogState.summary || {},
    } : null,
    history: normalizedHistory,
    historySummary: summarizeHistory(normalizedHistory),
    workspaceChanges,
    finalStatus: finalStatusWithReason,
    sseTrace: sseTrace || [],
    sseSummary,
    meta: meta || {},
  }

  return artifact
}

export function summarizeHistory(history = []) {
  const ok = history.filter((h) => h.ok)
  return {
    total: history.length,
    okCount: ok.length,
    failCount: history.length - ok.length,
    filesRead: ok.filter((h) => h.family === 'file' && h.action === 'read').length,
    filesChanged: ok.filter((h) => h.family === 'file' && ['write', 'edit'].includes(h.action)).length,
    commandsRun: ok.filter((h) => h.family === 'shell').length,
    // testsRun counts both passed AND failed attempts (failed tests are still "ran")
    testsRun: history.filter((h) => h.isLocalTest).length,
    testsPassed: ok.filter((h) => h.isLocalTest).length,
    healthChecks: ok.filter((h) => h.isHealthCheck).length,
    logsChecks: ok.filter((h) => h.isLogsCheck).length,
    deploys: ok.filter((h) => h.isDeploy).length,
    commits: ok.filter((h) => h.isCommit).length,
  }
}

export function summarizeWorkspaceChanges(events = []) {
  const fileChangeEvents = (events || []).filter((e) => String(e?.event || '') === 'file_change')
  const paths = []
  const diffs = []
  for (const e of fileChangeEvents) {
    const payload = e?.payload?.payload || e?.payload || {}
    const runId = payload.runId || ''
    for (const evt of payload.events || []) {
      if (evt?.path && !paths.includes(evt.path)) paths.push(evt.path)
      if (evt?.meta?.diff?.patch) {
        diffs.push({
          runId: runId || evt.runId || evt.meta?.runId || '',
          path: evt.path || evt.meta.diff.path || '',
          type: evt.type || 'file_changed',
          tool: evt.tool || payload.name || '',
          patch: String(evt.meta.diff.patch || '').slice(0, 16000),
          truncated: Boolean(evt.meta.diff.truncated),
        })
      }
    }
  }
  return {
    eventCount: fileChangeEvents.length,
    changedFileCount: paths.length,
    paths: paths.slice(0, 100),
    diffCount: diffs.length,
    diffs: diffs.slice(0, 30),
  }
}

export function summarizeSseTrace(events = []) {
  const counts = {}
  let firstEventAt = null
  let lastEventAt = null
  let lastError = null
  let doneReason = null
  let sawDone = false
  for (const e of events) {
    const name = String(e?.event || 'unknown')
    counts[name] = (counts[name] || 0) + 1
    if (e?.at != null) {
      if (!firstEventAt) firstEventAt = e.at
      lastEventAt = e.at
    }
    if (name === 'error') lastError = e?.payload?.message || e?.payload?.error?.message || null
    if (name === 'done') {
      sawDone = true
      doneReason = e?.payload?.reason || e?.payload?.payload?.reason || null
    }
  }
  // streamCut: stream started but never emitted a 'done' event.
  const streamCut = events.length > 0 && !sawDone
  return {
    totalEvents: events.length,
    countsByEvent: counts,
    firstEventAt,
    lastEventAt,
    doneReason,
    lastError,
    streamCut,
  }
}

export function saveReplay(artifact = {}) {
  ensureDir()
  if (!artifact.runId) return null
  try {
    const json = JSON.stringify(artifact, null, 2)  // B — may throw on circular refs in artifact.sseTrace
    fs.writeFileSync(replayPath(artifact.runId), json)
    return replayPath(artifact.runId)
  } catch { return null }
}

export function loadReplay(runId = '') {
  try {
    const raw = fs.readFileSync(replayPath(runId), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

export function listReplayIds({ limit = 100 } = {}) {
  try {
    const files = fs.readdirSync(path.join(getDataDir(), 'replays')).sort().reverse()
    return files.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))).map((f) => f.replace(/\.json$/, ''))
  } catch { return [] }
}

export default buildReplayArtifact
