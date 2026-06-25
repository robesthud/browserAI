/**
 * agentActionPolicy.js
 *
 * Runtime policy layer for autonomous Agent Mode. This is intentionally
 * separate from the prompt: model output is treated as a proposal, and the
 * server decides whether it is allowed to become a real action or final answer.
 */

const PLAN_MEMORY_TOOLS = new Set(['ask_user', 'recall_facts', 'plan_check', 'plan_set', 'remember_fact', 'kb_search', 'kb_add'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'shell_session_run', 'shell_background_start'])
const WORKSPACE_TASKS = new Set(['coding_change', 'deploy_ops', 'repo_analysis', 'general_agent_task'])

export function isTinyWorkspaceToolCall(call = {}) {
  const tool = String(call.tool || '')
  const action = String(call.args?.action || '')
  const direct = new Set(['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'verify_code', 'verify_task', 'npm_test'])
  if (direct.has(tool)) return true
  if (tool === 'file' && ['list', 'read', 'search', 'write', 'edit'].includes(action)) return true
  if (tool === 'verify' && ['code', 'task', 'npm_test'].includes(action)) return true
  return false
}

export function shouldPreferShell({ calls = [], agentContext = {}, already = 0 } = {}) {
  if (already >= 2 || calls.length < 2) return false
  const taskType = agentContext?.task?.type || ''
  const complexity = agentContext?.task?.complexity || ''
  if (complexity === 'low' || ['research', 'simple_answer'].includes(taskType)) return false
  if (calls.some((c) => SHELL_TOOLS.has(String(c.tool || '')))) return false
  const tiny = calls.filter(isTinyWorkspaceToolCall)
  return tiny.length >= 2 && tiny.length / calls.length >= 0.66
}

export const shouldPushShellFirst = shouldPreferShell

export function hasRealActionEvidence(recentToolHistory = []) {
  return (recentToolHistory || []).some((h) => h?.ok && !PLAN_MEMORY_TOOLS.has(String(h.tool || '')))
}

export function requiresRealAction(agentContext = {}) {
  const taskType = agentContext?.task?.type || ''
  const complexity = agentContext?.task?.complexity || ''
  if (complexity === 'low' || taskType === 'simple_answer') return false
  return Boolean(taskType && taskType !== 'simple_answer')
}

export function isWorkspaceActionTask(agentContext = {}) {
  return WORKSPACE_TASKS.has(String(agentContext?.task?.type || ''))
}

export function textSuggestsFutureCommand(text = '') {
  return /(попробую|выполню|запущу|начинаю|проверю|создам|сделаю|добавлю|инициализирую|push|пуш|деплой|deploy)/i.test(String(text || ''))
}

export function shouldExecuteTextShellCommand({ command = '', draftText = '', recentToolHistory = [] } = {}) {
  if (!command) return false
  const didRealWorkBeforeDraft = hasRealActionEvidence(recentToolHistory)
  return !didRealWorkBeforeDraft || textSuggestsFutureCommand(draftText)
}

export function finalRejectionForNoAction({ decision = {}, agentContext = {}, recentToolHistory = [], pushbackCount = 0, maxPushbacks = 2 } = {}) {
  if (decision.type !== 'final') return null
  if (!requiresRealAction(agentContext)) return null
  if (hasRealActionEvidence(recentToolHistory)) return null
  if (pushbackCount >= maxPushbacks) return null

  const workspace = isWorkspaceActionTask(agentContext)
  return {
    code: 'real_action_required',
    thought: workspace
      ? 'Перехожу к выполнению через shell, чтобы задача была сделана в рабочей среде.'
      : 'Продолжаю выполнение через инструменты, чтобы подтвердить результат действиями.',
    userPrompt: workspace
      ? 'ACT now by calling the shell tool. Do not describe commands as text; emit an actual shell action:"run" tool call. Use one compact shell step for inspect/read/edit/verify when safe.'
      : 'ACT now by calling the appropriate real tool. Do not final-answer yet; complete the requested task or report a real blocker backed by tool output.',
  }
}

export function shellFirstPushbackMessage() {
  return `[shell_first_policy]
You are splitting one workspace operation into many small file/verify tool calls. Replace this batch with ONE shell action:"run" call. Use shell to inspect/read/patch/verify in a compact command. Only use file tools for fuzzy edit, snapshots, zip, media/binary, or a single exact file operation. Keep the user-facing timeline: short explanation → one shell action → next explanation.`
}

export const __test = {
  PLAN_MEMORY_TOOLS,
  SHELL_TOOLS,
  WORKSPACE_TASKS,
}
