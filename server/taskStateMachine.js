function parseArgs(args = '') {
  try { return typeof args === 'string' ? JSON.parse(args || '{}') : (args || {}) } catch { return {} }
}

function isCodeLikePath(path = '') {
  return /\.(js|mjs|cjs|jsx|ts|tsx|json|css|html|yml|yaml)$/i.test(String(path || ''))
}

function okTools(history = []) {
  return new Set((history || []).filter((h) => h?.ok).map((h) => h.tool))
}

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

export function deriveTaskPhase({ agentContext = {}, agentState = {}, recentToolHistory = [] } = {}) {
  const taskType = agentContext?.task?.type || 'general_agent_task'
  const complexity = agentContext?.task?.complexity || 'medium'
  const tools = okTools(recentToolHistory)
  const hasPlan = Array.isArray(agentState?.plan?.steps) && agentState.plan.steps.length > 0
  const hasDiscovery = tools.has('read_project_rules') || tools.has('list_files') || tools.has('read_file') || tools.has('search_files')

  if ((agentState?.lastErrors || []).length && recentToolHistory.slice(-1)[0]?.ok === false) {
    return { phase: 'recover', reason: 'last-tool-failed' }
  }
  if (hasUnverifiedCodeEdit(recentToolHistory)) {
    return { phase: 'verify', reason: 'code-edited-without-verification' }
  }
  if (['medium', 'high'].includes(complexity) && !hasDiscovery) {
    return { phase: 'discover', reason: 'needs-initial-grounding' }
  }
  if (['medium', 'high'].includes(complexity) && !hasPlan && ['coding_change', 'repo_analysis', 'deploy_ops', 'browser_task'].includes(taskType)) {
    return { phase: 'plan', reason: 'needs-plan' }
  }
  return { phase: 'execute', reason: 'ready-to-work' }
}

const COMMON = [
  'ask_user', 'read_project_rules', 'list_files', 'read_file', 'search_files',
  'plan_set', 'plan_check', 'secret_scan', 'workspace_snapshot_list',
  'operator_status', 'operator_project_profile', 'operator_analyze_project', 'operator_list_runbooks', 'operator_read_runbook', 'operator_update_runbook', 'operator_append_lesson', 'operator_start_mission', 'operator_get_report', 'operator_send_report', 'operator_list_missions', 'operator_get_mission', 'operator_review_code_task', 'operator_finalize_code_task', 'operator_wait_code_task_ci', 'operator_auto_fix_code_task_ci', 'operator_merge_code_task_pr',
]

const BY_PHASE = {
  discover: [
    ...COMMON,
    'web_search', 'web_fetch',
    'git_status', 'docker_ps', 'docker_logs', 'ops_list_services',
    'browser_open', 'browser_screenshot',
  ],
  plan: [
    ...COMMON,
    'web_search', 'web_fetch', 'git_status', 'docker_ps', 'docker_logs', 'ops_list_services',
  ],
  verify: [
    ...COMMON,
    'verify_code', 'npm_test', 'verify_task', 'project_profile', 'secret_scan', 'bash', 'docker_ps', 'docker_logs', 'ops_list_services',
    'web_fetch', 'browser_screenshot', 'git_status',
  ],
  recover: null,
  execute: null,
}

export function allowedToolsForPhase(phase = 'execute') {
  const list = BY_PHASE[phase]
  return Array.isArray(list) ? new Set(list) : null
}

export function isAllowedInPhase(toolName, phase = 'execute') {
  const allowed = allowedToolsForPhase(phase)
  if (!allowed) return true
  return allowed.has(toolName)
}

export default { deriveTaskPhase, allowedToolsForPhase, isAllowedInPhase, hasUnverifiedCodeEdit }
