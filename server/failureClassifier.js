import { startOperatorMission } from './operatorMode.js'
import { createDeploySession } from './deploySessions.js'
import { createIncident } from './incidents.js'

const CATEGORY_RULES = [
  { category: 'secret_leak', severity: 'critical', re: /secret scan|private key|ghp_|github_pat_|api[_-]?key|token leaked|\.env/i },
  { category: 'auth_failure', severity: 'high', re: /\b(401|403)\b|unauthorized|forbidden|permission denied|bad credentials|invalid token|authentication failed/i },
  { category: 'disk_failure', severity: 'high', re: /no space left|disk full|enospc|not enough space|quota exceeded/i },
  { category: 'git_lock_failure', severity: 'medium', re: /index\.lock|cannot lock ref|another git process|unable to create .*\.lock/i },
  { category: 'dependency_failure', severity: 'medium', re: /npm err|pnpm err|yarn error|bun error|could not resolve dependency|dependency conflict|package lock|lockfile|npm ci/i },
  { category: 'test_failure', severity: 'medium', re: /test failed|failed tests|\bvitest\b|\bjest\b|\bpytest\b|assertionerror|expected .* received|tests?\s+failed/i },
  { category: 'build_failure', severity: 'high', re: /build failed|failed to compile|vite.*error|webpack.*error|rollup.*error|typescript error|tsc|syntaxerror|parse error|unterminated string/i },
  { category: 'ci_failure', severity: 'high', re: /github actions|workflow_run|ci failed|operator pr ci failed|conclusion.*failure|check run|actions\/runs/i },
  { category: 'docker_failure', severity: 'high', re: /docker|compose|container.*(failed|unhealthy|exited)|port is already allocated|image.*failed|cannot connect to docker/i },
  { category: 'health_failure', severity: 'critical', re: /health.*(failed|unhealthy|not ready)|connection refused|failed to connect|curl.*\(7\)|502|503|504/i },
  { category: 'deploy_failure', severity: 'critical', re: /deploy.*failed|rollback|deploy_safe|repair_deploy|DEPLOY FAILED|депло[йя].*(ошиб|пада|failed)/i },
  { category: 'timeout_failure', severity: 'medium', re: /timeout|timed out|killed after|deadline exceeded|etimedout/i },
]

export const AUTO_FIX_POLICIES = {
  secret_leak: {
    risk: 'blocked',
    action: 'ask_user',
    description: 'Stop automation and require secret removal/rotation before continuing.',
    recommended: ['Run secret_scan', 'Remove leaked file/value', 'Rotate exposed token', 'Do not commit/deploy until clean'],
  },
  auth_failure: {
    risk: 'blocked',
    action: 'ask_user',
    description: 'Credentials/permissions are missing or invalid. Human action required.',
    recommended: ['Check token scopes', 'Rotate/re-enter credentials', 'Retry after access is confirmed'],
  },
  disk_failure: {
    risk: 'safe_ops',
    action: 'diagnostic',
    missionType: 'full_diagnostic',
    description: 'Collect diagnostics; propose prune/cleanup after review.',
    recommended: ['Check docker system df', 'Prune build cache after successful deploy', 'Inspect backups/logs'],
  },
  git_lock_failure: {
    risk: 'safe_ops',
    action: 'operator_mission',
    missionType: 'fix_deploy',
    description: 'Run deploy/git diagnostic. Deploy scripts already clear stale locks.',
    recommended: ['Remove stale .git/*.lock', 'Retry fetch/reset', 'Check concurrent git processes'],
  },
  dependency_failure: {
    risk: 'code',
    action: 'code_task',
    missionType: 'fix_tests',
    description: 'Start Code Operator to fix dependency/test/build failure.',
    recommended: ['Inspect package manager logs', 'Avoid blind dependency upgrades', 'Run tests/build after patch'],
  },
  test_failure: {
    risk: 'code',
    action: 'code_task',
    missionType: 'fix_tests',
    description: 'Start Code Operator focused on failing tests.',
    recommended: ['Read failure output', 'Patch minimal code/tests', 'Rerun focused tests then full tests'],
  },
  build_failure: {
    risk: 'code',
    action: 'code_task',
    missionType: 'fix_tests',
    description: 'Start Code Operator focused on build failure.',
    recommended: ['Read build output', 'Fix syntax/config/import issues', 'Run build again'],
  },
  ci_failure: {
    risk: 'code',
    action: 'ci_auto_fix',
    description: 'If linked to a code task, run CI auto-fix; otherwise start CI diagnostic.',
    recommended: ['Download CI logs', 'Run CI auto-fix on same branch', 'Wait CI again'],
  },
  docker_failure: {
    risk: 'ops_approval',
    action: 'operator_mission',
    missionType: 'fix_deploy',
    description: 'Run full deploy/docker diagnostic. Restart/deploy require approval.',
    recommended: ['docker compose ps/logs', 'docker compose config', 'repair deploy if approved'],
  },
  health_failure: {
    risk: 'ops_approval',
    action: 'operator_mission',
    missionType: 'fix_deploy',
    description: 'Create diagnostic mission; self-heal restart requires approval.',
    recommended: ['Collect logs', 'Check health URL from host and container', 'Run self-heal restart if approved'],
  },
  deploy_failure: {
    risk: 'ops_approval',
    action: 'deploy_session',
    description: 'Start observable deploy diagnostic/session; production writes require approval.',
    recommended: ['Open deploy session', 'Check timeline/logs', 'Use rollback-safe deploy'],
  },
  timeout_failure: {
    risk: 'retry',
    action: 'diagnostic',
    missionType: 'full_diagnostic',
    description: 'Timeout may be transient or command too broad; collect context and retry narrower.',
    recommended: ['Check if process still running', 'Retry with narrower command', 'Increase timeout only if safe'],
  },
  unknown_failure: {
    risk: 'diagnostic',
    action: 'diagnostic',
    missionType: 'full_diagnostic',
    description: 'Unknown failure: run diagnostic before taking write actions.',
    recommended: ['Collect status/logs', 'Classify again with more evidence', 'Ask user if blocked'],
  },
}

function normalizeEvidence(input = {}) {
  if (typeof input === 'string') return input
  return [
    input.error,
    input.message,
    input.stderr,
    input.stdout,
    input.logs,
    input.title,
    input.kind,
    input.status,
    input.details ? JSON.stringify(input.details) : '',
    input.result ? JSON.stringify(input.result) : '',
  ].filter(Boolean).join('\n')
}

export function classifyFailure(input = {}) {
  const evidence = normalizeEvidence(input)
  const hits = []
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(evidence)) hits.push({ category: rule.category, severity: rule.severity })
  }
  const primary = hits[0] || { category: 'unknown_failure', severity: 'medium' }
  const policy = AUTO_FIX_POLICIES[primary.category] || AUTO_FIX_POLICIES.unknown_failure
  return {
    schema: 'browserai.failure_classification.v1',
    category: primary.category,
    severity: primary.severity,
    confidence: hits.length ? Math.min(0.95, 0.55 + hits.length * 0.15) : 0.25,
    matches: hits,
    policy,
    evidencePreview: evidence.slice(0, 3000),
    createdAt: new Date().toISOString(),
  }
}

export function recommendAutoFix(input = {}) {
  const classification = input.category ? { ...input, policy: AUTO_FIX_POLICIES[input.category] || AUTO_FIX_POLICIES.unknown_failure } : classifyFailure(input)
  const policy = classification.policy || AUTO_FIX_POLICIES.unknown_failure
  const requiresApproval = ['ops_approval', 'blocked'].includes(policy.risk) || policy.action === 'ask_user'
  return {
    schema: 'browserai.auto_fix_recommendation.v1',
    classification,
    action: policy.action,
    missionType: policy.missionType || '',
    requiresApproval,
    safeToAutoStart: !requiresApproval && ['diagnostic', 'operator_mission', 'code_task'].includes(policy.action),
    recommended: policy.recommended || [],
    description: policy.description,
  }
}

export function executeAutoFixRecommendation({ userId = '', input = {}, confirm = false } = {}) {
  const rec = recommendAutoFix(input)
  if (rec.requiresApproval && confirm !== true) {
    const err = new Error(`Auto-fix requires approval: ${rec.description}`)
    err.code = 'CONFIRM_REQUIRED'
    err.recommendation = rec
    throw err
  }
  const goal = input.goal || input.title || input.message || input.error || rec.description
  if (rec.action === 'operator_mission' || rec.action === 'diagnostic' || rec.action === 'code_task') {
    return { recommendation: rec, mission: startOperatorMission({ userId, type: rec.missionType || 'full_diagnostic', goal, confirm }) }
  }
  if (rec.action === 'deploy_session') {
    return { recommendation: rec, deploySession: createDeploySession({ userId, title: 'Auto-fix deploy diagnostic', input: { goal, classification: rec.classification } }) }
  }
  const err = new Error(`No automatic executor for action ${rec.action}`)
  err.code = 'NO_AUTO_EXECUTOR'
  err.recommendation = rec
  throw err
}

export function createIncidentFromFailure({ userId = '', input = {}, classification = null } = {}) {
  const c = classification || classifyFailure(input)
  return createIncident({
    userId,
    source: input.source || 'failure_classifier',
    severity: c.severity,
    title: input.title || `Failure: ${c.category}`,
    fingerprint: input.fingerprint || `${c.category}-${(input.entityId || input.message || input.error || '').toString().slice(0, 120)}`,
    details: { input, classification: c },
  })
}

export default { classifyFailure, recommendAutoFix, executeAutoFixRecommendation, createIncidentFromFailure, AUTO_FIX_POLICIES }

