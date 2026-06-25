/**
 * runResume.js
 *
 * Approach 7 — Trust UX + Prod Readiness. Stream resilience helpers.
 *
 * - listRunsByChat(chatId) — every run log for a given chatId, sorted desc
 * - getLastRun(chatId) — most recent run for the chat (completed or interrupted)
 * - getReplayForRun(runId) — replay artifact (or null)
 * - summarizeForResume(runId) — compact summary for UI "Resume last run" button
 */

import { listRunLogIds, loadRunLog, summarizeRunLog } from './runLogs.js'
import { loadReplay } from './replayArtifact.js'

export function listRunsByChat(chatId = '', { limit = 20 } = {}) {
  const target = String(chatId || '')
  if (!target) return []
  const max = Math.max(1, Math.min(100, Number(limit) || 20))
  const out = []
  for (const id of listRunLogIds({ limit: max * 4 })) {
    const log = loadRunLog(id)
    if (!log) continue
    if (log?.task?.chatId === target) {
      out.push(summarizeRunLog(log))
      if (out.length >= max) break
    }
  }
  return out
}

export function getLastRun(chatId = '') {
  const runs = listRunsByChat(chatId, { limit: 1 })
  return runs[0] || null
}

export function getReplayForRun(runId = '') {
  if (!runId) return null
  return loadReplay(runId)
}

export function summarizeForResume(runId = '') {
  const log = loadRunLog(runId)
  if (!log) return null
  return {
    runId: log.runId,
    chatId: log?.task?.chatId || null,
    provider: log?.provider?.id || null,
    taskType: log?.task?.type || null,
    startedAt: log?.startedAt || null,
    finishedAt: log?.finishedAt || null,
    durationMs: log?.durationMs || 0,
    reason: log?.finalization?.reason || null,
    taskCompleted: Boolean(log?.finalization?.taskCompleted),
    verified: Boolean(log?.finalization?.verified),
    blockers: log?.finalization?.blockers || [],
    summary: log?.summary || {},
    canResume: log?.finalization?.reason === 'crash' || log?.finalization?.reason === 'llm-error' || log?.finalization?.reason === 'max-steps' || log?.finalization?.reason === 'deadline',
  }
}

export default { listRunsByChat, getLastRun, getReplayForRun, summarizeForResume }
