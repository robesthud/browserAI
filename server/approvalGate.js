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
  read: 'auto',
  write: 'auto',
  net: 'auto',
  bash: 'auto',
  git: 'auto',
  mcp: 'auto',
  deploy: 'auto',
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
  spawn_agent: 'bash',
  get_agent_result: 'read',
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
// Approach 2 — Runtime Unification parity: categoryOf dispatches by semantic
// family+action so that consolidated tool names (`file`, `shell`, `verify`,
// `git`, `docker`, `ops`, `web`, `browser`) AND any family-equivalent legacy
// names (`npm_test`, `docker_ps`, `read_file`, `write_file`, ...) are
// categorized identically.
import { runtimeSemantics as _runtimeSemantics } from './agentRuntimeSemantics.js'

const FAMILY_TO_CATEGORY = {
  file: 'write',     // default to 'write'; read-only actions are overridden below
  verify: 'bash',
  shell: 'bash',
  git: 'git',
  docker: 'deploy',
  ops: 'deploy',
  web: 'net',
  browser: 'net',
}

const FILE_READ_ACTIONS = new Set(['list', 'read', 'search', 'snapshot_list'])
const OPS_READ_ACTIONS = new Set(['list'])

function categoryByFamily(toolName = '', args = {}) {
  // Normalise args: if caller passed a JSON string, parse it; if object, use directly.
  // Wrap JSON.stringify in try/catch to guard against circular objects.
  let argsStr
  if (typeof args === 'string') {
    argsStr = args
  } else {
    try { argsStr = JSON.stringify(args || {}) } catch { argsStr = '{}' }
  }
  const semantic = _runtimeSemantics({ tool: toolName, args: argsStr, outcome: '' })
  const family = semantic.family
  const action = semantic.action
  if (!Object.prototype.hasOwnProperty.call(FAMILY_TO_CATEGORY, family)) return null
  // File family: read-only actions should map to 'read', not 'write'.
  if (family === 'file' && FILE_READ_ACTIONS.has(action)) return 'read'
  // Ops family: list action is a read, others (run) are deploy.
  if (family === 'ops' && OPS_READ_ACTIONS.has(action)) return 'read'
  return FAMILY_TO_CATEGORY[family]
}

export function categoryOf(toolName = '', args = {}) {
  const name = String(toolName || '')
  if (name.startsWith('mcp__')) return 'mcp'

  // 1) Explicit legacy lookup wins for tools that have a unique category.
  const direct = TOOL_CATEGORY[name]
  if (direct) return direct

  // 2) Family-based dispatch — works for both consolidated and legacy forms.
  const byFamily = categoryByFamily(name, args)
  if (byFamily) return byFamily

  return 'net'
}

function commandLooksDangerous(command = '') {
  // Catastrophic host/workspace destruction guard only. Deployment/productive
  // operations (docker compose up, git push, systemctl restart, kubectl apply,
  // deploy.sh, etc.) now follow the user's approval policy and default to auto.
  // Set BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=1 only in fully disposable envs.
  if (String(process.env.BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL || '').toLowerCase() === '1') return false
  const c = String(command || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return /\bdd\s+if=|\bmkfs\.|\brm\s+-rf\s+(\/|~|\$home|\*)(\s|$)|\bchmod\s+-r\s+777\s+(\/|~|\$home)(\s|$)|\bchown\s+-r\b\s+\S+\s+(\/|~|\$home)(\s|$)|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash)/i.test(c)
}

/**
 * Checks if a tool call requires explicit user confirmation according to the
 * current user's policy. Unknown tools default to net policy (safe-ish but
 * visible in strict mode). Catastrophic shell commands still require approval
 * unless explicitly disabled by env; deploy/git/docker operations default auto.
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
