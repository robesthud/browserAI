import { listReplayIds, loadReplay } from './replayArtifact.js'
import { listRunLogIds, loadRunLog } from './runLogs.js'

/**
 * qualityKpis.js
 *
 * Approach 6 — Observability. Aggregate Quality KPIs across runs/replays.
 *
 * KPI definitions:
 *   successRate         — fraction of runs with taskCompleted=true AND verified=true AND no blockers
 *   falseFinalRate      — fraction of runs that ended "completed" (taskCompleted=true) but had blockers
 *                         or had a false_finalization classified error
 *   maxStepsRate        — fraction of runs that hit step limit (max-steps / deadline)
 *   streamCutRate       — fraction of replays whose SSE trace never emitted a 'done' event
 *   verificationMissingRate — fraction of replays whose history shows code changes
 *                              but no verification-after-edit
 *   providerFailureRate — fraction of replays whose finalStatus has a 'provider' or 'auth'
 *                         classified error or no_provider termination
 *
 * All fractions are floats 0..1.
 */

function isSuccess(artifact) {
  const fs = artifact?.finalStatus || {}
  if (!fs.taskCompleted) return false
  if (fs.verified === false) return false
  if ((fs.blockers || []).length > 0) return false
  if (fs.deploy?.requested && (!fs.deploy?.done || !fs.deploy?.verified)) return false
  return true
}

function isFalseFinal(artifact) {
  const fs = artifact?.finalStatus || {}
  if (!fs.taskCompleted) return false
  // claimed success but had blockers
  if ((fs.blockers || []).length > 0) return true
  // claimed success but had a fabrication/missing_verification/etc.
  const t = (fs.blockers || []).map((b) => b.type)
  if (t.some((x) => ['fabrication', 'missing_verification', 'verification_missing'].includes(x))) return true
  return false
}

function isMaxSteps(artifact) {
  const r = artifact?.finalStatus?.reason
  return r === 'max-steps' || r === 'deadline'
}

function isStreamCut(artifact) {
  return Boolean(artifact?.sseSummary?.streamCut)
}

function hasVerificationMissing(artifact) {
  const fs = artifact?.finalStatus || {}
  const t = (fs.blockers || []).map((b) => b.type)
  return t.includes('missing_verification') || t.includes('verification_missing')
}

function hasProviderFailure(artifact) {
  const fs = artifact?.finalStatus || {}
  if (fs.reason === 'no-provider' || fs.reason === 'llm-error') return true
  const t = (fs.blockers || []).map((b) => b.type)
  if (t.some((x) => ['provider', 'auth'].includes(x))) return true
  return false
}

export function summarizeReplay(artifact = {}) {
  if (!artifact) return null
  return {
    runId: artifact.runId,
    provider: artifact?.provider?.id || null,
    taskType: artifact?.input?.taskType || null,
    chatId: artifact?.input?.chatId || null,
    startedAt: artifact?.run?.startedAt || null,
    durationMs: artifact?.run?.durationMs || 0,
    steps: artifact?.run?.summary?.toolCalls || 0,
    finalReason: artifact?.finalStatus?.reason || null,
    taskCompleted: Boolean(artifact?.finalStatus?.taskCompleted),
    verified: Boolean(artifact?.finalStatus?.verified),
    blockerCount: (artifact?.finalStatus?.blockers || []).length,
    isSuccess: isSuccess(artifact),
    isFalseFinal: isFalseFinal(artifact),
    isMaxSteps: isMaxSteps(artifact),
    isStreamCut: isStreamCut(artifact),
    hasVerificationMissing: hasVerificationMissing(artifact),
    hasProviderFailure: hasProviderFailure(artifact),
  }
}

export function aggregateKpis(replays = []) {
  const total = replays.length
  if (!total) {
    return {
      total: 0,
      successRate: null,
      falseFinalRate: null,
      maxStepsRate: null,
      streamCutRate: null,
      verificationMissingRate: null,
      providerFailureRate: null,
      byProvider: {},
      byTaskType: {},
      windowStart: null,
      windowEnd: null,
    }
  }
  let success = 0, falseFinal = 0, maxSteps = 0, streamCut = 0, verifMissing = 0, providerFail = 0
  const byProvider = {}
  const byTaskType = {}
  let minStart = null
  let maxStart = null
  for (const r of replays) {
    const s = summarizeReplay(r)
    if (!s) continue
    if (s.isSuccess) success += 1
    if (s.isFalseFinal) falseFinal += 1
    if (s.isMaxSteps) maxSteps += 1
    if (s.isStreamCut) streamCut += 1
    if (s.hasVerificationMissing) verifMissing += 1
    if (s.hasProviderFailure) providerFail += 1
    const p = s.provider || 'unknown'
    if (!byProvider[p]) byProvider[p] = { total: 0, success: 0, falseFinal: 0, maxSteps: 0, streamCut: 0, verifMissing: 0, providerFail: 0 }
    byProvider[p].total += 1
    if (s.isSuccess) byProvider[p].success += 1
    if (s.isFalseFinal) byProvider[p].falseFinal += 1
    if (s.isMaxSteps) byProvider[p].maxSteps += 1
    if (s.isStreamCut) byProvider[p].streamCut += 1
    if (s.hasVerificationMissing) byProvider[p].verifMissing += 1
    if (s.hasProviderFailure) byProvider[p].providerFail += 1
    const t = s.taskType || 'unknown'
    if (!byTaskType[t]) byTaskType[t] = { total: 0, success: 0 }
    byTaskType[t].total += 1
    if (s.isSuccess) byTaskType[t].success += 1
    if (s.startedAt) {
      if (!minStart || s.startedAt < minStart) minStart = s.startedAt
      if (!maxStart || s.startedAt > maxStart) maxStart = s.startedAt
    }
  }
  const ratio = (n) => Number((n / total).toFixed(4))
  const ratioFor = (g) => {
    const t = g.total || 0
    if (!t) return 0
    return Number((g.success / t).toFixed(4))
  }
  const ratios = {}
  for (const [p, g] of Object.entries(byProvider)) {
    ratios[p] = {
      total: g.total,
      successRate: ratioFor(g),
      falseFinalRate: Number((g.falseFinal / t_safe(g.total)).toFixed(4)),
      maxStepsRate: Number((g.maxSteps / t_safe(g.total)).toFixed(4)),
      streamCutRate: Number((g.streamCut / t_safe(g.total)).toFixed(4)),
      verificationMissingRate: Number((g.verifMissing / t_safe(g.total)).toFixed(4)),
      providerFailureRate: Number((g.providerFail / t_safe(g.total)).toFixed(4)),
    }
  }
  const taskRatios = {}
  for (const [t, g] of Object.entries(byTaskType)) taskRatios[t] = { total: g.total, successRate: ratioFor(g) }
  return {
    total,
    successRate: ratio(success),
    falseFinalRate: ratio(falseFinal),
    maxStepsRate: ratio(maxSteps),
    streamCutRate: ratio(streamCut),
    verificationMissingRate: ratio(verifMissing),
    providerFailureRate: ratio(providerFail),
    byProvider: ratios,
    byTaskType: taskRatios,
    windowStart: minStart,
    windowEnd: maxStart,
  }
}

function t_safe(n) { return n > 0 ? n : 1 }

export function loadRecentReplays({ limit = 100 } = {}) {
  // KPI-1: cap at 50 to prevent OOM (each replay artifact can be 1-5 MB)
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 50))
  const ids = listReplayIds({ limit: safeLimit })
  return ids.map((id) => loadReplay(id)).filter(Boolean)
}

export function loadRecentRunLogs({ limit = 100 } = {}) {
  const ids = listRunLogIds({ limit })
  return ids.map((id) => loadRunLog(id)).filter(Boolean)
}

export function recentKpis({ limit = 100 } = {}) {
  const replays = loadRecentReplays({ limit })
  return aggregateKpis(replays)
}

export default { aggregateKpis, summarizeReplay, recentKpis, loadRecentReplays }
