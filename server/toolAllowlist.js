const COMMON_AGENT_TOOLS = [
  'plan_set', 'plan_check', 'ask_user', 'read_project_rules', 'project_profile', 'secret_scan', 'workspace_snapshot_list',
  'recall_facts', 'remember_fact', 'forget_fact', 'kb_search', 'kb_list', 'kb_add', 'kb_delete',
  'operator_status', 'operator_project_profile', 'operator_start_mission', 'operator_list_missions', 'operator_get_mission', 'operator_finalize_code_task',
]

export const TOOL_PROFILES = {
  general: [
    ...COMMON_AGENT_TOOLS,
    'list_files', 'read_file', 'search_files',
    'write_file', 'edit_file', 'create_folder', 'rename_item', 'delete_file', 'zip_files', 'workspace_snapshot_create', 'workspace_snapshot_restore',
    'bash', 'verify_code', 'verify_task',
    'web_search', 'web_fetch',
    'git_status', 'git_clone',
    'generate_image', 'edit_image', 'generate_video', 'analyze_image', 'text_to_speech', 'transcribe_audio',
  ],
  code: [
    ...COMMON_AGENT_TOOLS,
    'list_files', 'read_file', 'search_files',
    'write_file', 'edit_file', 'create_folder', 'rename_item', 'delete_file', 'zip_files', 'workspace_snapshot_create', 'workspace_snapshot_restore',
    'bash', 'npm_install', 'npm_test', 'verify_code', 'verify_task',
    'git_status', 'git_clone', 'git_commit',
  ],
  ops: [
    ...COMMON_AGENT_TOOLS,
    'ops_list_services', 'ops_run_action',
    'docker_ps', 'docker_logs',
    'bash', 'npm_test', 'verify_code', 'verify_task',
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
  ],
}

export function toolProfileForTask(task = {}) {
  switch (task?.type) {
    case 'deploy_ops': return 'ops'
    case 'coding_change': return 'code'
    case 'repo_analysis': return 'code'
    case 'research': return 'research'
    case 'browser_task': return 'browser'
    default: return 'general'
  }
}

export function profileToolNames(profile = 'general') {
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
