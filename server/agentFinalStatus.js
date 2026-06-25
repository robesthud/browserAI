import {
  runtimeSemantics,
  hasLocalTestAttempt,
  hasSuccessfulLocalTest,
  askedForExplicitLocalTest,
  obligationCompletionStatus,
} from './agentRuntimeSemantics.js'

export function buildFinalStatus({
  agentContext = {},
  recentToolHistory = [],
  agentState = {},
  aborted = false,
  step = 0,
  maxSteps = 0,
  reason = 'final',
  error = null,
  userText = '',
  failedReadPaths = new Set(),
  okReadPaths = new Set(),
  claimIssues = null,
} = {}) {
  const ok = recentToolHistory.filter((h) => h?.ok)
  const failed = recentToolHistory.filter((h) => !h?.ok)

  // Вычисляем семантику один раз для каждой записи — O(N) вместо O(N×K)
  const allSemantics = recentToolHistory.map((h) => h?.semantic || runtimeSemantics(h))
  const okSemantics = ok.map((h, i) => {
    // Находим индекс в исходном массиве для правильной семантики
    const idx = recentToolHistory.indexOf(h)
    return idx >= 0 ? allSemantics[idx] : (h?.semantic || runtimeSemantics(h))
  })

  const filesRead = okSemantics.filter((s) => s.isRead).length
  const filesChanged = okSemantics.filter((s) => s.isWrite || s.isEdit).length
  const commandsRun = okSemantics.filter((s) => s.family === 'shell').length
  // testsRun = все попытки (включая failed), testsPassed = только успешные
  const testsRun = allSemantics.filter((s) => s.isLocalTest).length
  const testsPassed = okSemantics.filter((s) => s.isLocalTest).length

  const explicitTestRequested = askedForExplicitLocalTest(userText)
  const testAttempted = hasLocalTestAttempt(recentToolHistory)
  const testPassed = hasSuccessfulLocalTest(recentToolHistory)

  const obligations = agentContext?.task?.obligations || {}
  const obligationStatus = obligationCompletionStatus(obligations, recentToolHistory)

  const blockers = []

  // Check for unmet obligations
  for (const [key, required] of Object.entries(obligations)) {
    if (!required || key === 'finalReport') continue
    if (!obligationStatus[key]) {
      blockers.push({
        type: 'unmet_obligation',
        key,
        reason: `Obligation "${key}" is required but not satisfied in tool history.`,
      })
    }
  }

  // Check for missing local tests
  if (explicitTestRequested && !testAttempted) {
    blockers.push({
      type: 'missing_test',
      reason: 'User explicitly requested local tests but no test command was executed.',
      evidence: 'No tool history entry with isLocalTest=true found.',
    })
  }
  if (explicitTestRequested && testAttempted && !testPassed) {
    blockers.push({
      type: 'test_failed',
      reason: 'Local tests were attempted but did not pass.',
      evidence: 'Tool history contains local test attempts but none with ok=true.',
    })
  }

  // Check for verification after code changes
  const lastEdit = recentToolHistory.findLastIndex((h, i) => {
    const s = allSemantics[i]
    return (s.isWrite || s.isEdit) && h?.ok
  })
  const hasVerifyAfterEdit = lastEdit >= 0 && recentToolHistory.slice(lastEdit + 1).some((h, i) => h?.ok && (allSemantics[lastEdit + 1 + i] || (h?.semantic || runtimeSemantics(h))).isVerify)
  if (filesChanged > 0 && !hasVerifyAfterEdit) {
    blockers.push({
      type: 'missing_verification',
      reason: 'Code/files were changed but no verification tool was run after the last edit.',
      evidence: `Last successful edit at index ${lastEdit}, no verify/test after it.`,
    })
  }

  // Check for fabrication: failed reads that were never successfully read
  const _failedPaths = failedReadPaths instanceof Set ? failedReadPaths : new Set()
  const _okPaths = okReadPaths instanceof Set ? okReadPaths : new Set()
  const fabricatedPaths = [..._failedPaths].filter((p) => !_okPaths.has(p))
  if (fabricatedPaths.length > 0) {
    blockers.push({
      type: 'fabrication',
      reason: 'Final answer may reference files that were never successfully read.',
      evidence: `Failed read paths never succeeded: ${fabricatedPaths.slice(0, 5).join(', ')}`,
    })
  }

  // Check for deadline / max-steps
  if (reason === 'deadline') {
    blockers.push({
      type: 'deadline',
      reason: 'Agent deadline exceeded.',
      evidence: 'Loop terminated by deadline guard, not by task completion.',
    })
  } else if (step >= maxSteps && maxSteps > 0) {
    blockers.push({
      type: 'max_steps',
      reason: `Agent reached step limit (${step}/${maxSteps}).`,
      evidence: 'Loop terminated by step guard, not by task completion.',
    })
  }

  if (aborted) {
    blockers.push({
      type: 'aborted',
      reason: 'Agent run was aborted by user or system.',
    })
  }

  if (error) {
    blockers.push({
      type: 'runtime_error',
      reason: String(error.message || error).slice(0, 200),
    })
  }

  // Approach 2 parity: taskCompleted should be true ONLY when the run actually
  // completed without early termination. All non-final reasons (deadline, max-steps,
  // crash, llm-error, cap-reached, no-provider) must yield taskCompleted=false.
  const isEarlyTermination = reason !== 'final' || aborted
  const taskCompleted = !isEarlyTermination && blockers.length === 0 && (maxSteps === 0 || step < maxSteps)
  // Антигаллюцинатор: если в финальном ответе есть error-claims, verified=false.
  const claimErrors = (Array.isArray(claimIssues) ? claimIssues : []).filter((i) => i?.severity === 'error')
  const verified = (filesChanged === 0 || hasVerifyAfterEdit || (testAttempted && testPassed)) && claimErrors.length === 0

  const deployRequested = Boolean(obligations.deploy)
  const deployDone = obligationStatus.deploy || false
  const deployVerified = obligationStatus.healthCheck || obligationStatus.logsCheck || false

  return {
    taskCompleted,
    verified,
    localTests: {
      requested: explicitTestRequested,
      attempted: testAttempted,
      passed: testPassed,
    },
    deploy: {
      requested: deployRequested,
      done: deployDone,
      verified: deployVerified,
    },
    blockers,
    evidenceSummary: {
      filesRead,
      filesChanged,
      commandsRun,
      testsRun,
      testsPassed,
      errors: failed.length,
      totalSteps: step,
    },
    claimIssues: Array.isArray(claimIssues) ? claimIssues : [],
  }
}

export function isBlocked(finalStatus = {}) {
  if (!finalStatus) return false
  if (finalStatus.blockers?.some((b) => ['missing_test', 'test_failed', 'missing_verification', 'unmet_obligation', 'max_steps', 'deadline', 'aborted', 'runtime_error', 'fabrication'].includes(b.type))) {
    return true
  }
  return false
}

export function isPartial(finalStatus = {}) {
  if (!finalStatus) return false
  return !finalStatus.taskCompleted && !isBlocked(finalStatus)
}

export function finalStatusToText(finalStatus = {}) {
  const lines = []
  if (finalStatus.taskCompleted) lines.push('✅ Task completed')
  else if (isBlocked(finalStatus)) lines.push('🔴 Blocked')
  else if (isPartial(finalStatus)) lines.push('⚠️ Partial completion')

  if (finalStatus.verified) lines.push('✅ Verified')
  else lines.push('⚠️ Not verified')

  const lt = finalStatus.localTests || {}
  if (lt.requested) {
    if (lt.passed) lines.push('✅ Tests passed')
    else if (lt.attempted) lines.push('❌ Tests attempted but failed')
    else lines.push('❌ Tests requested but not attempted')
  }

  const d = finalStatus.deploy || {}
  if (d.requested) {
    if (d.done && d.verified) lines.push('✅ Deployed and verified')
    else if (d.done) lines.push('⚠️ Deployed but not verified')
    else lines.push('❌ Deploy not done')
  }

  if (finalStatus.blockers?.length) {
    lines.push(`\n**Blockers (${finalStatus.blockers.length}):**`)
    for (const b of finalStatus.blockers) {
      lines.push(`- [${b.type}] ${b.reason}${b.evidence ? ` — evidence: ${b.evidence}` : ''}`)
    }
  }

  const e = finalStatus.evidenceSummary || {}
  lines.push(`\n**Evidence:** files read=${e.filesRead}, changed=${e.filesChanged}, commands=${e.commandsRun}, tests=${e.testsRun}/${e.testsPassed}, errors=${e.errors}, steps=${e.totalSteps}`)

  return lines.join('\n')
}

export default buildFinalStatus
