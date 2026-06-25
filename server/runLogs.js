import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { classifyError } from './errorTaxonomy.js'

/**
 * runLogs.js
 *
 * Approach 6 — Observability. Per-run structured log of agent events.
 *
 * Storage: NDJSON-style file at `${DATA_DIR}/runs/${runId}.json`
 *   - The file is a JSON object `{schema, runId, events: [...]}` (we use a single
 *     object so a partial write is still valid JSON if appended).
 *   - Each `events[i]` is one NDJSON-shaped event.
 *
 * Schema: `browserai.run_log.v1`
 *
 * Event types emitted:
 *   run_start      — provider, route mode, task type, max steps, scope
 *   phase          — phase transitions
 *   tool_call      — tool name, args digest, ok, semantic family
 *   semantic_fail  — failed verification / fabrication / missing-test etc.
 *   finalization   — reason, blockers, taskCompleted, verified
 *   error          — classified via errorTaxonomy
 *   run_end        — total duration, steps, token summary
 */

const SCHEMA = 'browserai.run_log.v1'
function getDataDir() { return process.env.DATA_DIR || '/data' }

function ensureDir() {
  try { fs.mkdirSync(path.join(getDataDir(), 'runs'), { recursive: true }) } catch { /* ignore */ }
}

function runPath(runId) {
  // RL-1: sanitize runId to prevent path traversal (same fix as replayArtifact.js)
  const safe = String(runId || '').replace(/[/\\\0.]/g, '_').slice(0, 128)
  return path.join(getDataDir(), 'runs', `${safe}.json`)
}

export function newRunId(prefix = 'run') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

export function createRunLog({
  runId = newRunId(),
  provider = {},
  routeMode = 'agent',
  taskType = 'task',
  userId = '',
  chatId = '',
  maxSteps = 0,
  route = '',
  scope = '',
  meta = {},
} = {}) {
  ensureDir()
  const state = {
    schema: SCHEMA,
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    provider: {
      id: String(provider?.id || provider?.baseUrl || 'mock'),
      baseUrl: provider?.baseUrl || null,
      model: provider?.model || null,
      authType: provider?.authType || null,
      managed: Boolean(provider?.managed),
    },
    route: { mode: routeMode, path: route || null },
    task: { type: taskType, chatId: String(chatId || ''), scope: String(scope || ''), userId: String(userId || '') },
    runtime: { maxSteps: Number(maxSteps) || 0, startedStep: 0, endedStep: 0 },
    summary: {
      filesRead: 0,
      filesChanged: 0,
      commandsRun: 0,
      testsRun: 0,
      testsPassed: 0,
      errors: 0,
      toolCalls: 0,
    },
    finalization: { reason: null, taskCompleted: null, verified: null, blockers: [] },
    events: [],
    meta: meta || {},
  }

  const append = (eventType, payload = {}) => {
    const evt = {
      ts: new Date().toISOString(),
      runId,
      type: eventType,
      ...payload,
    }
    state.events.push(evt)
    return evt
  }

  const log = {
    state,
    runId,
    run_start(meta2 = {}) {
      append('run_start', { ...meta2 })
      return this
    },
    phase(from = null, to = null, meta2 = {}) {
      append('phase', { from, to, ...meta2 })
      return this
    },
    toolCall({ tool = '', args = null, ok = null, semantic = null, outcome = null, error = null, durationMs = null } = {}) {
      append('tool_call', {
        tool,
        family: semantic?.family || null,
        action: semantic?.action || null,
        path: semantic?.path || null,
        command: semantic?.command || null,
        argsDigest: args ? (typeof args === 'string' ? args : JSON.stringify(args)).slice(0, 240) : null,
        ok,
        outcome,
        error: error ? String(error).slice(0, 240) : null,
        durationMs,
      })
      state.summary.toolCalls += 1
      if (ok === false) state.summary.errors += 1
      if (semantic?.family === 'file') {
        if (semantic?.action === 'read' && ok) state.summary.filesRead += 1
        if ((semantic?.action === 'write' || semantic?.action === 'edit') && ok) state.summary.filesChanged += 1
      }
      if (semantic?.family === 'shell' && ok) state.summary.commandsRun += 1
      if (semantic?.isLocalTest) {
        state.summary.testsRun += 1
        if (ok) state.summary.testsPassed += 1
      }
      return this
    },
    semanticFail(reason = '', details = {}) {
      append('semantic_fail', { reason, ...details })
      return this
    },
    finalization({ reason = null, taskCompleted = null, verified = null, blockers = [] } = {}) {
      state.finalization.reason = reason
      state.finalization.taskCompleted = taskCompleted
      state.finalization.verified = verified
      state.finalization.blockers = blockers
      append('finalization', { reason, taskCompleted, verified, blockerCount: (blockers || []).length, blockerTypes: (blockers || []).map((b) => b.type) })
      return this
    },
    error(input = {}) {
      const cls = classifyError({ ...input, context: { ...(input?.context || {}), runId } })
      append('error', { ...cls })
      state.summary.errors += 1
      return this
    },
    run_end(meta2 = {}) {
      state.finishedAt = new Date().toISOString()
      state.durationMs = meta2?.durationMs || (Date.now() - new Date(state.startedAt).getTime())
      state.runtime.endedStep = meta2?.endedStep || 0
      append('run_end', {
        durationMs: state.durationMs,
        endedStep: state.runtime.endedStep,
        summary: state.summary,
        finalization: state.finalization,
      })
      return this
    },
    persist() {
      ensureDir()
      try {
        // RL-2: JSON.stringify may throw on circular refs in events
        const json = JSON.stringify(state, null, 2)
        fs.writeFileSync(runPath(runId), json)
        return runPath(runId)
      } catch { return null }
    },
    getState() { return state },
    getEvents() { return state.events.slice() },
  }

  log.run_start = log.run_start.bind(log)
  log.phase = log.phase.bind(log)
  log.toolCall = log.toolCall.bind(log)
  log.semanticFail = log.semanticFail.bind(log)
  log.finalization = log.finalization.bind(log)
  log.error = log.error.bind(log)
  log.run_end = log.run_end.bind(log)

  return log
}

export function loadRunLog(runId = '') {
  try {
    const raw = fs.readFileSync(runPath(runId), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

export function listRunLogIds({ limit = 100 } = {}) {
  try {
    const files = fs.readdirSync(path.join(getDataDir(), 'runs')).sort().reverse()
    return files.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))).map((f) => f.replace(/\.json$/, ''))
  } catch { return [] }
}

export function summarizeRunLog(runLogOrState = null) {
  const s = runLogOrState?.state || runLogOrState
  if (!s) return null
  return {
    runId: s.runId,
    schema: s.schema,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    durationMs: s.durationMs,
    provider: s.provider?.id || null,
    route: s.route?.mode || null,
    task: s.task?.type || null,
    chatId: s.task?.chatId || null,
    finalization: s.finalization,
    summary: s.summary,
    eventCount: (s.events || []).length,
  }
}

export default createRunLog
