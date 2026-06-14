/**
 * approvalGate.js
 *
 * Per-user safety policy manager for AI tool use. The UI uses the same
 * category names as this module: read/write/net/bash/git/mcp/deploy.
 */
import { getMeta, setMeta } from './db.js'

const CATEGORIES = ['read', 'write', 'net', 'bash', 'git', 'mcp', 'deploy']

const DEFAULT_POLICY = {
  schema: 'browserai.approval_policy.v2',
  // Cline-like safe default: read/write/net auto, destructive/external ops ask.
  read: 'auto',
  write: 'auto',
  net: 'auto',
  bash: 'ask',
  git: 'ask',
  mcp: 'ask',
  deploy: 'ask',
}

const TOOL_CATEGORY = {
  // read / inspect
  list_files: 'read',
  find_projects: 'read',
  read_file: 'read',
  project_profile: 'read',
  search_files: 'read',
  file_history: 'read',
  build_repo_map: 'read',
  kb_search: 'read',
  kb_list: 'read',
  recall_facts: 'read',
  checkpoint_list: 'read',
  workspace_snapshot_list: 'read',
  secret_scan: 'read',
  ops_list_services: 'read',
  github_actions_status: 'read',
  github_actions_wait: 'read',
  deploy_timeweb_wait: 'read',
  app_health_check: 'read',
  docker_logs_recent: 'read',

  // writes / workspace mutation / memory mutation
  write_file: 'write',
  edit_file: 'write',
  create_folder: 'write',
  rename_item: 'write',
  delete_file: 'write',
  restore_file: 'write',
  replace_across_files: 'write',
  kb_add: 'write',
  kb_delete: 'write',
  remember_fact: 'write',
  forget_fact: 'write',
  checkpoint_restore: 'write',
  workspace_snapshot_create: 'write',
  workspace_snapshot_restore: 'write',
  generate_image: 'write',
  save_lesson: 'write',
  cron_add: 'write',
  cron_delete: 'write',

  // network / browser / download
  web_search: 'net',
  web_fetch: 'net',
  fetch_page: 'net',
  scrape_url: 'net',
  download_url: 'net',
  zip_files: 'write',
  browser_open: 'net',
  browser_screenshot: 'net',
  browser_click: 'net',
  browser_type: 'net',
  browser_close: 'net',
  computer_screenshot: 'net',
  computer_click: 'net',
  computer_double_click: 'net',
  computer_move: 'net',
  computer_scroll: 'net',
  computer_type: 'net',
  computer_key: 'net',
  computer_open_app: 'net',
  computer_status: 'net',

  // shell
  bash: 'bash',
  shell_session_run: 'bash',
  shell_session_reset: 'bash',
  shell_background_start: 'bash',
  shell_background_read: 'bash',
  shell_background_stop: 'bash',
  shell_background_list: 'bash',
  bash_reset: 'bash',
  bash_bg: 'bash',
  bash_logs: 'bash',
  bash_stop: 'bash',
  bash_list: 'bash',
  verify_code: 'bash',
  verify_task: 'bash',
  run_tests: 'bash',
  run_python_with_plot: 'bash',

  // git
  git_status: 'git',
  git_diff: 'git',
  git_commit: 'git',
  git_push: 'git',
  git_pull: 'git',
  git_clone: 'git',
  github_pr_create: 'git',

  // deploy / external ops
  ops_run_action: 'deploy',
}

function keyForUser(userId = '') {
  return `approval_policy:${String(userId || 'global')}`
}

function normaliseValue(value, fallback = 'auto') {
  return value === 'ask' ? 'ask' : value === 'auto' ? 'auto' : fallback
}

export function normalizePolicy(raw = null) {
  const p = { ...DEFAULT_POLICY }

  if (raw && typeof raw === 'object') {
    // v1 migration: { requireApprovalFor: ['shell','ops','git'] }
    if (Array.isArray(raw.requireApprovalFor)) {
      const mapped = raw.requireApprovalFor.map((x) => String(x || '').toLowerCase())
      p.bash = mapped.includes('shell') || mapped.includes('bash') ? 'ask' : 'auto'
      p.deploy = mapped.includes('ops') || mapped.includes('deploy') ? 'ask' : 'auto'
      p.git = mapped.includes('git') ? 'ask' : 'auto'
    }

    for (const cat of CATEGORIES) {
      if (raw[cat] != null) p[cat] = normaliseValue(raw[cat], p[cat])
    }
  }

  p.schema = 'browserai.approval_policy.v2'
  return p
}

export function loadPolicy(userId = '') {
  try {
    const raw = getMeta(keyForUser(userId))
    if (raw) return normalizePolicy(JSON.parse(raw))
  } catch { /* ignore corrupted policy */ }
  return normalizePolicy(DEFAULT_POLICY)
}

export function savePolicy(userId = '', policy = {}) {
  const next = normalizePolicy(policy)
  setMeta(keyForUser(userId), JSON.stringify(next))
  return next
}

/**
 * Returns the logical category of a tool for the UI.
 */
export function categoryOf(toolName = '') {
  const name = String(toolName || '')
  if (name.startsWith('mcp__')) return 'mcp'
  return TOOL_CATEGORY[name] || 'net'
}

function commandLooksDangerous(command = '') {
  const c = String(command || '').toLowerCase()
  return /\brm\s+-rf\b|\bdd\s+if=|mkfs\.|chmod\s+-r\s+777|chown\s+-r\b|docker\s+compose\s+up|docker-compose\s+up|docker\s+rm\b|docker\s+restart\b|systemctl\s+(restart|stop|start)|service\s+\w+\s+(restart|stop|start)|kubectl\s+(apply|delete|rollout)|deploy\.sh|\bdeploy\b|git\s+push\b|git\s+reset\s+--hard|git\s+clean\s+-fd|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash)/i.test(c)
}

/**
 * Checks if a tool call requires explicit user confirmation according to the
 * current user's policy. Unknown tools default to net policy (safe-ish but
 * visible in strict mode). Dangerous shell commands always require approval.
 */
export function requiresApproval(toolName, userId = '', args = {}) {
  // ask_user is itself the approval/question mechanism; never require approval
  // to ask for approval.
  if (toolName === 'ask_user') return false
  if (['bash', 'shell_session_run', 'shell_background_start'].includes(String(toolName || '')) && commandLooksDangerous(args?.command || '')) return true
  const policy = loadPolicy(userId)
  const cat = categoryOf(toolName)
  return policy[cat] === 'ask'
}

export { commandLooksDangerous }

export default { requiresApproval, categoryOf, loadPolicy, savePolicy, normalizePolicy }
