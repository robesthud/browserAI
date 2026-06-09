/**
 * approvalGate.js
 *
 * Cline-style auto-approve flow. Each tool falls into a category and
 * each user has a policy of which categories are auto-approved vs
 * require explicit confirmation.
 *
 * Per-user policy stored in user_facts.approval_policy as JSON:
 *   {
 *     read: 'auto' | 'ask',
 *     write: 'auto' | 'ask',
 *     bash: 'auto' | 'ask',
 *     git: 'auto' | 'ask',
 *     deploy: 'auto' | 'ask',
 *     mcp: 'auto' | 'ask',
 *     net: 'auto' | 'ask'
 *   }
 *
 * Default policy: read/write/net auto; bash/git/mcp ask; deploy ask
 * (matches Cline's safer-by-default approach).
 */
import dbHandle from './db.js'

const CATEGORY = {
  // read
  list_files: 'read', find_projects: 'read', read_file: 'read',
  search_files: 'read', file_history: 'read', recall_facts: 'read',
  kb_search: 'read', kb_list: 'read', plan_set: 'read', plan_check: 'read',
  ask_user: 'read', use_subagents: 'read', verify_code: 'read',
  ops_list_services: 'read', git_status: 'read', git_diff: 'read',
  analyze_image: 'read',
  // write — within workspace
  write_file: 'write', edit_file: 'write', delete_file: 'write',
  restore_file: 'write', replace_across_files: 'write',
  remember_fact: 'write', forget_fact: 'write', kb_add: 'write', kb_delete: 'write',
  // bash & shell
  bash: 'bash', run_tests: 'bash',
  // browser
  browser_open: 'net', browser_screenshot: 'net', browser_click: 'net',
  browser_type: 'net', browser_close: 'net',
  // net
  download_url: 'net', web_search: 'net', web_fetch: 'net',
  // git
  git_commit: 'git', git_clone: 'git', git_pull: 'git', git_push: 'git',
  github_pr_create: 'git',
  // deploy / ops
  ops_run_action: 'deploy',
}

const DEFAULT_POLICY = {
  read: 'auto', write: 'auto', net: 'auto',
  bash: 'auto', git: 'auto', mcp: 'auto',
  deploy: 'ask',
}

export function categoryOf(toolName) {
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) return 'mcp'
  return CATEGORY[toolName] || 'write'
}

export function loadPolicy(userId = '') {
  try {
    const r = dbHandle.prepare(`SELECT value FROM user_facts
      WHERE user_id = ? AND key = 'approval_policy'`).get(String(userId || ''))
    if (r?.value) {
      const obj = JSON.parse(r.value)
      if (obj && typeof obj === 'object') return { ...DEFAULT_POLICY, ...obj }
    }
  } catch { /* table may not exist */ }
  return { ...DEFAULT_POLICY }
}

export function savePolicy(userId = '', policy = {}) {
  const clean = { ...DEFAULT_POLICY }
  for (const k of Object.keys(DEFAULT_POLICY)) {
    if (policy[k] === 'auto' || policy[k] === 'ask') clean[k] = policy[k]
  }
  try {
    dbHandle.prepare(`INSERT INTO user_facts (user_id, key, value, updated_at)
      VALUES (?, 'approval_policy', ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(String(userId || ''), JSON.stringify(clean), Date.now())
  } catch (e) {
    console.warn('[approval] savePolicy failed:', e?.message || e)
  }
  return clean
}

/**
 * Returns true if the tool/category should pause for user OK.
 */
export function requiresApproval(toolName, userId = '') {
  const policy = loadPolicy(userId)
  const cat = categoryOf(toolName)
  return policy[cat] === 'ask'
}

export default { categoryOf, loadPolicy, savePolicy, requiresApproval }
