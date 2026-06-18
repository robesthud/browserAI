const SHELL_AGENT_TOOLS = ['shell_session_run', 'shell_session_reset', 'shell_background_start', 'shell_background_read', 'shell_background_stop', 'shell_background_list']

// Консолидированные имена инструментов — это то, что модель ВИДИТ в промпте.
// Позволяем и их, и базовые (для обратной совместимости со старыми чатами).
const CONSOLIDATED = ['file', 'shell', 'git', 'web', 'browser', 'computer', 'media', 'memory', 'kb', 'verify', 'plan', 'docker', 'ops', 'operator', 'ask_user', 'read_project_rules', 'project_profile', 'db_query', 'review_code_changes', 'generate_video', 'debug_run_code']

const COMMON_AGENT_TOOLS = [
  'plan_set', 'plan_check', 'ask_user', 'read_project_rules', 'project_profile', 'secret_scan', 'workspace_snapshot_list',
  'recall_facts', 'remember_fact', 'forget_fact', 'kb_search', 'kb_list', 'kb_add', 'kb_delete',
  'operator_status', 'operator_project_profile', 'operator_list_project_templates', 'operator_list_runtime_adapters', 'operator_analyze_project', 'operator_list_runbooks', 'operator_read_runbook', 'operator_update_runbook', 'operator_append_lesson', 'operator_start_mission', 'operator_classify_failure', 'operator_execute_auto_fix', 'operator_get_report', 'operator_send_report', 'operator_get_super_workflow', 'operator_list_super_workflows', 'operator_list_missions', 'operator_get_mission', 'operator_review_code_task', 'operator_finalize_code_task', 'operator_wait_code_task_ci', 'operator_auto_fix_code_task_ci', 'operator_merge_code_task_pr',
]

export const TOOL_PROFILES = {
  main_agent: [],
  general: [
    ...COMMON_AGENT_TOOLS,
    'list_files', 'read_file', 'search_files',
    'write_file', 'edit_file', 'create_folder', 'rename_item', 'delete_file', 'zip_files', 'workspace_snapshot_create', 'workspace_snapshot_restore',
    'bash', ...SHELL_AGENT_TOOLS, 'verify_code', 'verify_task',
    'web_search', 'web_fetch',
    'git_status', 'git_clone',
    'generate_image', 'edit_image', 'generate_video', 'analyze_image', 'text_to_speech', 'transcribe_audio',
  ],
  code: [
    ...COMMON_AGENT_TOOLS,
    'list_files', 'read_file', 'search_files',
    'write_file', 'edit_file', 'create_folder', 'rename_item', 'delete_file', 'zip_files', 'workspace_snapshot_create', 'workspace_snapshot_restore',
    'bash', ...SHELL_AGENT_TOOLS, 'npm_install', 'npm_test', 'verify_code', 'verify_task',
    'git_status', 'git_clone', 'git_commit',
  ],
  ops: [
    ...COMMON_AGENT_TOOLS,
    'ops_list_services', 'ops_run_action',
    'docker_ps', 'docker_logs',
    'bash', ...SHELL_AGENT_TOOLS, 'npm_test', 'verify_code', 'verify_task',
    'web_search', 'web_fetch',
    'git_status', 'git_clone', 'git_commit',
    'list_files', 'read_file', 'search_files', 'edit_file', 'write_file', 'create_folder', 'rename_item', 'zip_files', 'secret_scan', 'workspace_snapshot_create', 'workspace_snapshot_restore',
  ],
  research: [
    ...COMMON_AGENT_TOOLS,
    'web_search', 'web_fetch',
    'list_files', 'read_file', 'search_files',
  ],
  browser: [
    ...COMMON_AGENT_TOOLS,
    'browser_open', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_close',
    'web_search', 'web_fetch',
    // Browser tasks often start from a URL but still need workspace/repo tools
    // (for example GitHub URLs that should be cloned or inspected). Keep the
    // browser profile capable instead of trapping the agent without git/files.
    'list_files', 'read_file', 'search_files', 'project_profile',
    'bash', ...SHELL_AGENT_TOOLS, 'git_status', 'git_clone', 'verify_code', 'verify_task',
  ],
}

function allAutomaticAgentTools() {
  const names = []
  for (const [profile, tools] of Object.entries(TOOL_PROFILES)) {
    if (profile === 'main_agent') continue
    names.push(...tools)
  }
  return [...new Set(names)]
}

export function toolProfileForTask() {
  // Product decision: BrowserAI's main surface is an automatic Arena-like
  // agent, not a profile-limited mode picker. Specialized profiles caused real
  // failures (e.g. GitHub download routed to browser profile with no git_clone).
  // Keep profiles as internal documentation/tests, but the runtime uses a
  // broad main_agent profile so safe universal tools are always available.
  return 'main_agent'
}

export function profileToolNames(profile = 'main_agent') {
  if (profile === 'main_agent') {
    // Возвращаем консолидированные имена + все базовые (для обратной совместимости).
    // Модель видит только ~15 консолидированных (через renderConsolidatedTools),
    // но allowlist пускает и базовые имена, если модель их вызовет из старого чата.
    return [...new Set([...CONSOLIDATED, ...allAutomaticAgentTools()])]
  }
  return [...new Set(TOOL_PROFILES[profile] || TOOL_PROFILES.general)]
}

export function allowedToolsForTask(task = {}, { lite = false } = {}) {
  if (lite) return null
  return new Set(profileToolNames(toolProfileForTask(task)))
}

export function isToolAllowed(toolName, allowedSet, extraTools = null) {
  if (!allowedSet) return true
  if (allowedSet.has(toolName)) return true
  if (extraTools && extraTools[toolName]) return true
  return false
}

export default { TOOL_PROFILES, toolProfileForTask, profileToolNames, allowedToolsForTask, isToolAllowed }
