/**
 * approvalGate.js
 *
 * Safety policy manager for AI tool use. Defines which tool categories
 * are safe and which require explicit user confirmation via an "Approve" button.
 */

const SAFE_TOOLS = new Set([
  'list_files', 'find_projects', 'read_file', 'search_files', 'file_history',
  'web_search', 'web_fetch', 'kb_search', 'recall_facts', 'kb_list',
  'git_status', 'git_diff', 'browser_open', 'browser_screenshot',
  'ops_list_services', 'bash_list', 'bash_logs',
])

const DANGEROUS_CATEGORIES = {
  shell: ['bash', 'bash_reset', 'bash_bg', 'bash_stop'],
  write: ['write_file', 'edit_file', 'delete_file', 'restore_file', 'replace_across_files'],
  ops:   ['ops_run_action'],
  git:   ['git_commit', 'git_push', 'git_pull', 'git_clone', 'github_pr_create'],
}

/**
 * Returns the logical category of a tool for the UI.
 */
export function categoryOf(toolName) {
  for (const [cat, tools] of Object.entries(DANGEROUS_CATEGORIES)) {
    if (tools.includes(toolName)) return cat
  }
  return 'general'
}

/**
 * Checks if a tool call requires explicit user confirmation.
 * Global defaults can be overridden per-user via a fact 'tool_policy=low|high'.
 */
// (userId reserved for future per-user policies)
export function requiresApproval(toolName) {
  if (SAFE_TOOLS.has(toolName)) return false
  
  // Default: moderate safety — confirm shell/ops/git, allow selective writes.
  if (DANGEROUS_CATEGORIES.shell.includes(toolName)) return true
  if (DANGEROUS_CATEGORIES.ops.includes(toolName)) return true
  if (DANGEROUS_CATEGORIES.git.includes(toolName)) return true
  
  return false
}

export function loadPolicy() {
  return {
    schema: 'browserai.approval_policy.v1',
    requireApprovalFor: ['shell', 'ops', 'git'],
    safeTools: Array.from(SAFE_TOOLS),
  }
}

export default { requiresApproval, categoryOf, loadPolicy }
