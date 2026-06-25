/**
 * Agent State Machine — explicit phases, transitions, guards, retry budgets,
 * stuck detection, and escalation strategy for BrowserAI agent loop.
 *
 * Phases: discover → plan → execute → verify → finalize | blocked
 */

function parseArgs(args = '') {
  try { return typeof args === 'string' ? JSON.parse(args || '{}') : (args || {}) } catch { return {} }
}

function isCodeLikePath(path = '') {
  return /\.(js|mjs|cjs|jsx|ts|tsx|json|css|html|yml|yaml)$/i.test(String(path || ''))
}

function okTools(history = []) {
  return new Set((history || []).filter((h) => h?.ok).map((h) => h.tool))
}

// ── Legacy helpers (backward compatible) ─────────────────────────────

export function hasUnverifiedCodeEdit(history = []) {
  let lastCodeEdit = -1
  for (let i = 0; i < history.length; i += 1) {
    const h = history[i]
    if (!h?.ok || !['write_file', 'edit_file'].includes(h.tool)) continue
    const args = parseArgs(h.args)
    const p = args.path || args.file_path || ''
    if (isCodeLikePath(p)) lastCodeEdit = i
  }
  if (lastCodeEdit < 0) return false
  return !history.slice(lastCodeEdit + 1).some((h) => h?.ok && ['verify_code', 'npm_test', 'verify_task'].includes(h.tool))
}

// ── Phase constants ────────────────────────────────────────────────────

export const PHASES = {
  DISCOVER: 'discover',
  PLAN: 'plan',
  EXECUTE: 'execute',
  VERIFY: 'verify',
  FINALIZE: 'finalize',
  BLOCKED: 'blocked',
  RECOVER: 'recover',
}

export const PHASE_ORDER = [PHASES.DISCOVER, PHASES.PLAN, PHASES.EXECUTE, PHASES.VERIFY, PHASES.FINALIZE]

export const TRANSITIONS = {
  [PHASES.DISCOVER]: [PHASES.PLAN, PHASES.EXECUTE, PHASES.FINALIZE, PHASES.BLOCKED, PHASES.RECOVER],
  [PHASES.PLAN]: [PHASES.EXECUTE, PHASES.DISCOVER, PHASES.BLOCKED, PHASES.RECOVER],
  [PHASES.EXECUTE]: [PHASES.VERIFY, PHASES.FINALIZE, PHASES.EXECUTE, PHASES.BLOCKED, PHASES.RECOVER],
  [PHASES.VERIFY]: [PHASES.FINALIZE, PHASES.EXECUTE, PHASES.BLOCKED, PHASES.RECOVER],
  [PHASES.FINALIZE]: [PHASES.BLOCKED, PHASES.RECOVER],
  [PHASES.RECOVER]: [PHASES.DISCOVER, PHASES.PLAN, PHASES.EXECUTE, PHASES.BLOCKED],
  [PHASES.BLOCKED]: [],
}

// Tool constraints by phase (soft — used for advisory/pushback, not hard blocking)
const DISALLOWED_ADVISORY = {
  [PHASES.DISCOVER]: new Set(['write_file', 'edit_file', 'delete_file', 'bash', 'shell_session_run', 'verify_code', 'npm_test', 'ops_run_action']),
  [PHASES.PLAN]: new Set(['write_file', 'edit_file', 'delete_file', 'bash', 'shell_session_run', 'verify_code', 'npm_test', 'ops_run_action']),
  [PHASES.EXECUTE]: new Set([]),
  [PHASES.VERIFY]: new Set(['write_file', 'edit_file', 'delete_file']),
  [PHASES.FINALIZE]: new Set(['write_file', 'edit_file', 'delete_file', 'bash', 'shell_session_run', 'shell_background_start', 'verify_code', 'npm_test', 'ops_run_action', 'docker_ps', 'docker_logs']),
  [PHASES.RECOVER]: new Set([]),
  [PHASES.BLOCKED]: new Set([]),
}

export function isTransitionAllowed(fromPhase, toPhase) {
  const allowed = TRANSITIONS[fromPhase] || []
  return allowed.includes(toPhase)
}

export function isToolAllowedInPhase(tool, phase) {
  if (!phase || phase === PHASES.BLOCKED) return false
  const disallowed = DISALLOWED_ADVISORY[phase]
  if (disallowed && disallowed.has(tool)) return false
  return true
}

// Legacy alias
export function isAllowedInPhase(tool, phase) {
  return isToolAllowedInPhase(tool, phase)
}

// Legacy alias — returns advisory set for prompt guidance (not hard cage)
export function allowedToolsForPhase(_phase = 'execute') {
  return null
}

// Retry budget tracking
export function createRetryBudget() {
  return {
    toolCalls: new Map(),
    verifyRetryCount: 0,
    maxToolRetries: 3,
    maxVerifyRetries: 2,
    maxConsecutiveSameTool: 5,
  }
}

export function recordToolCall(budget, tool, args = {}, step = 0) {
  const path = args.path || args.file_path || ''
  const key = path ? `${tool}:${path}` : tool
  const entry = budget.toolCalls.get(key) || { count: 0, lastStep: 0, steps: [] }
  entry.count += 1
  entry.steps.push(step)
  entry.lastStep = step
  budget.toolCalls.set(key, entry)
  return entry
}

export function isRetryBudgetExceeded(budget, tool, args = {}) {
  const path = args.path || args.file_path || ''
  const key = path ? `${tool}:${path}` : tool
  const entry = budget.toolCalls.get(key)
  if (!entry) return false
  return entry.count >= budget.maxToolRetries
}

export function isConsecutiveSameToolExceeded(budget, recentToolHistory = [], window = 5) {
  if (recentToolHistory.length < window) return false
  const last = recentToolHistory.slice(-window)
  const tools = last.map((h) => h.tool)
  if (tools.every((t) => t === tools[0])) return true
  const fingerprints = last.map((h) => {
    const a = typeof h.args === 'string' ? (() => { try { return JSON.parse(h.args) } catch { return {} } })() : (h.args || {})
    return `${h.tool}:${a.path || a.file_path || ''}`
  })
  if (fingerprints.every((f) => f === fingerprints[0] && f !== `${tools[0]}:`)) return true
  return false
}

export function isVerifyRetryBudgetExceeded(budget) {
  return budget.verifyRetryCount >= budget.maxVerifyRetries
}

export function incrementVerifyRetry(budget) {
  budget.verifyRetryCount += 1
  return budget.verifyRetryCount
}

// Stuck detection
export function detectStuck({
  recentToolHistory = [],
  budget = null,
  phase = '',
  step = 0,
  planState = { done: new Set() },
  lastPhaseChangeStep = 0,
  maxStepsWithoutProgress = 8,
} = {}) {
  const stuck = { stuck: false, reason: '', type: '' }

  if (!budget) return stuck

  if (isConsecutiveSameToolExceeded(budget, recentToolHistory)) {
    stuck.stuck = true
    stuck.type = 'consecutive_same_tool'
    stuck.reason = `Same tool called ${budget.maxConsecutiveSameTool}+ times consecutively.`
    return stuck
  }

  if (lastPhaseChangeStep > 0 && step - lastPhaseChangeStep > maxStepsWithoutProgress) {
    stuck.stuck = true
    stuck.type = 'phase_stuck'
    stuck.reason = `No phase progress for ${step - lastPhaseChangeStep} steps (max ${maxStepsWithoutProgress}).`
    return stuck
  }

  if (phase === PHASES.PLAN && planState.done.size === 0 && step > 3) {
    stuck.stuck = true
    stuck.type = 'plan_stuck'
    stuck.reason = 'Plan created but no steps marked done after 3 steps.'
    return stuck
  }

  const last5 = recentToolHistory.slice(-5)
  const phases5 = last5.map((h) => h.phase || '').filter(Boolean)
  if (phases5.length >= 4) {
    const oscillation = phases5.every((p, i) => i === 0 || p !== phases5[i - 1])
    if (oscillation) {
      stuck.stuck = true
      stuck.type = 'oscillation'
      stuck.reason = 'Phase oscillating every step (verify↔execute loop).'
      return stuck
    }
  }

  return stuck
}

// Phase derivation based on evidence (replaces legacy deriveTaskPhase)
export function derivePhaseFromEvidence({
  agentContext = {},
  recentToolHistory = [],
  planState = { done: new Set() },
  currentPhase = PHASES.DISCOVER,
  step = 0,
} = {}) {
  const hasPlan = Array.isArray(agentContext?.task?.plan?.steps) && agentContext.task.plan.steps.length > 0
  const hasCodeChanges = recentToolHistory.some((h) => h?.ok && (h.semantic?.isWrite || h.semantic?.isEdit))
  const hasVerify = recentToolHistory.some((h) => h?.ok && h.semantic?.isVerify)
  const hasTest = recentToolHistory.some((h) => h?.ok && h.semantic?.isLocalTest)
  const hasInspect = recentToolHistory.some((h) => h?.ok && h.semantic?.isInspect)
  const allPlanDone = hasPlan && planState.done.size >= (agentContext?.task?.plan?.steps?.length || 0)
  const lastFailed = recentToolHistory.length > 0 && !recentToolHistory[recentToolHistory.length - 1].ok

  if (lastFailed && currentPhase !== PHASES.RECOVER && currentPhase !== PHASES.BLOCKED) {
    return { phase: PHASES.RECOVER, reason: 'Last tool failed — entering recovery.' }
  }

  if (currentPhase === PHASES.DISCOVER) {
    if (hasInspect && hasPlan) return { phase: PHASES.PLAN, reason: 'Discovery complete, plan exists.' }
    if (hasInspect && !hasPlan && step > 2) return { phase: PHASES.EXECUTE, reason: 'Discovery complete, no plan needed.' }
    return { phase: PHASES.DISCOVER, reason: 'Gathering context.' }
  }

  if (currentPhase === PHASES.PLAN) {
    if (allPlanDone) return { phase: PHASES.EXECUTE, reason: 'Plan complete, executing.' }
    if (step > 3 && hasCodeChanges) return { phase: PHASES.EXECUTE, reason: 'Plan skipped, changes started.' }
    return { phase: PHASES.PLAN, reason: 'Planning in progress.' }
  }

  if (currentPhase === PHASES.EXECUTE) {
    if (hasCodeChanges && (hasVerify || hasTest)) return { phase: PHASES.VERIFY, reason: 'Changes made, verifying.' }
    if (!hasCodeChanges && hasInspect) return { phase: PHASES.FINALIZE, reason: 'No changes, ready to finalize.' }
    return { phase: PHASES.EXECUTE, reason: 'Executing changes.' }
  }

  if (currentPhase === PHASES.VERIFY) {
    if (hasTest && hasVerify) return { phase: PHASES.FINALIZE, reason: 'Verification passed.' }
    if (hasCodeChanges && !hasTest && step > 4) return { phase: PHASES.EXECUTE, reason: 'Verification failed, retry execute.' }
    return { phase: PHASES.VERIFY, reason: 'Verifying changes.' }
  }

  if (currentPhase === PHASES.FINALIZE) {
    return { phase: PHASES.FINALIZE, reason: 'Finalizing response.' }
  }

  if (currentPhase === PHASES.RECOVER) {
    if (hasInspect) return { phase: PHASES.DISCOVER, reason: 'Recovered, re-discovering.' }
    return { phase: PHASES.RECOVER, reason: 'Recovering from failure.' }
  }

  return { phase: currentPhase, reason: 'Phase unchanged.' }
}

// Legacy alias for backward compatibility
export function deriveTaskPhase({ agentContext = {}, agentState = {}, recentToolHistory = [] } = {}) {
  return derivePhaseFromEvidence({ agentContext, recentToolHistory, planState: { done: new Set(agentState?.plan?.done || []) }, currentPhase: agentState?.phase || PHASES.EXECUTE, step: 0 })
}

// Escalation strategy
export function shouldEscalate({ stuck, budget, step, maxSteps = 25 } = {}) {
  if (stuck?.stuck) return { escalate: true, reason: stuck.reason, type: stuck.type }
  if (maxSteps > 0 && step > maxSteps * 0.8) return { escalate: true, reason: `Approaching max steps (${step}/${maxSteps}).`, type: 'max_steps_warning' }
  return { escalate: false }
}

export function buildEscalationPrompt({ stuck, currentPhase, step } = {}) {
  return `[escalation] The agent appears stuck (${stuck?.reason || 'unknown'}). Current phase: ${currentPhase}, step: ${step}.\n\nTake a step back:\n1. Review what has been accomplished.\n2. Identify the blocker or mistake.\n3. Pick ONE clear next action.\n4. Do NOT repeat the same tool call without a new reason.\n[/escalation]`
}

export function guardToolCall({ tool, phase, budget, args = {}, recentToolHistory = [], step = 0 } = {}) {
  if (!isToolAllowedInPhase(tool, phase)) {
    return { blocked: true, reason: `Tool "${tool}" is not recommended in phase "${phase}". Consider switching phase or using a different tool.`, advisory: true }
  }

  if (budget && isRetryBudgetExceeded(budget, tool, args)) {
    return { blocked: true, reason: `Retry budget exceeded for "${tool}".`, advisory: false }
  }

  const stuck = detectStuck({ recentToolHistory, budget, phase, step })
  if (stuck.stuck) {
    return { blocked: true, reason: stuck.reason, stuck: true, advisory: false }
  }

  return { blocked: false }
}

export function nextPhase({ currentPhase, targetPhase, evidence = {} } = {}) {
  if (!isTransitionAllowed(currentPhase, targetPhase)) {
    return { phase: currentPhase, changed: false, reason: `Transition ${currentPhase} → ${targetPhase} is not allowed.` }
  }
  return { phase: targetPhase, changed: true, reason: `Transition ${currentPhase} → ${targetPhase} approved.` }
}

export default {
  PHASES, PHASE_ORDER, TRANSITIONS,
  isTransitionAllowed, isToolAllowedInPhase, isAllowedInPhase, allowedToolsForPhase,
  createRetryBudget, recordToolCall, isRetryBudgetExceeded, isConsecutiveSameToolExceeded,
  isVerifyRetryBudgetExceeded, incrementVerifyRetry,
  detectStuck, derivePhaseFromEvidence, deriveTaskPhase, shouldEscalate, buildEscalationPrompt,
  guardToolCall, nextPhase, hasUnverifiedCodeEdit,
}
