import { publicWorkspacePolicy } from './sandboxPolicy.js'
/**
 * agentCore.js
 *
 * Strict, provider-agnostic runtime primitives for BrowserAI Agent Mode.
 * This is the explicit layer boundary that keeps the agent architecture
 * close to Arena-style agents:
 *
 *   Context Builder  →  Model Loop  →  Tool Router  →  Structured Result
 *
 * The current agentLoop remains the orchestrator, but all metadata that is
 * safe to share with the UI and all tool-result normalisation lives here.
 * No secrets are ever returned from this module.
 */

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part?.type === 'text') return part.text || ''
      if (part?.type === 'image_url' && part.image_url?.url) return '[image]'
      if (part?.type === 'image') return '[image]'
      return ''
    }).filter(Boolean).join('\n')
  }
  return ''
}

function lastUserText(history = []) {
  const last = [...history].reverse().find((m) => m?.role === 'user')
  return textFromContent(last?.content || '')
}

export function inferProviderKind(baseUrl = '') {
  let host
  let pathname
  try {
    const u = new URL(baseUrl)
    host = u.hostname.toLowerCase()
    pathname = u.pathname.toLowerCase()
  } catch {
    return 'unknown'
  }

  if (host === 'chat.deepseek.com') return 'deepseek-managed-web'
  if (host === 'api.anthropic.com' || host.endsWith('.api.anthropic.com')) return 'anthropic-official'
  if (host === 'generativelanguage.googleapis.com' && !pathname.includes('/openai')) return 'google-gemini-official'
  if (pathname.includes('/openai') || pathname.includes('/v1') || pathname.includes('/api/v1')) return 'openai-compatible'
  if (/chatgpt\.com|grok\.com|claude\.ai|perplexity\.ai|mistral\.ai|tongyi\.aliyun\.com/.test(host)) return 'browser-session'
  return 'openai-compatible'
}

export function classifyAgentTask(text = '') {
  const t = String(text || '').toLowerCase()
  const has = (...words) => words.some((w) => t.includes(w))

  // Action verbs anywhere in the text = the user wants real work done.
  // Checked before the small-talk shortcut so that e.g. «создай файл
  // hello.txt с текстом привет мир» is NOT misread as a greeting.
  const hasActionVerb = has(
    'скачай', 'клонируй', 'склонируй', 'clone', 'установи', 'запусти', 'выполни',
    'создай', 'сделай', 'напиши', 'сгенерируй', 'нарисуй', 'переименуй', 'удали',
    'исправ', 'почини', 'реализуй', 'добавь', 'перепиши', 'измени', 'обнови',
    'задеплой', 'разверни', 'собери', 'протестируй', 'проверь', 'изучи',
    'проанализируй', 'найди', 'построй', 'настрой', 'открой',
  )

  // Small talk / meta questions about the assistant: NEVER need repo map,
  // memory preload or the full tool catalog. The old behaviour burned ~47k
  // tokens of context on a literal "привет".
  if (!hasActionVerb && t.length <= 160 && /привет|здравствуй|добр(ое|ый)|hello|^hi[ !,.?]|спасибо|благодар|как дела|кто ты|что ты умеешь|какая модель|какая ты модель|как тебя зовут|are you|который час|сколько времени|сколько будет|посчитай/.test(t)) {
    return { type: 'simple_answer', complexity: 'low', suggestedMaxSteps: 6 }
  }

  // 1:1 Arena Parity: Aggressive Task Classification.
  // We want to trigger Agent Mode for ANYTHING that looks like work,
  // not just high-complexity requests.
  
  if (has('деплой', 'разверни', 'сервер', 'timeweb', 'docker', 'nginx', 'ssl', 'github', 'ci/cd', 'логи', 'logs')) {
    return { type: 'deploy_ops', complexity: 'high', suggestedMaxSteps: 60 }
  }
  if (has('исправ', 'почини', 'реализуй', 'добавь', 'перепиши', 'refactor', 'fix ', 'implement', 'bug', 'ошибк', 'код', 'скрипт', 'script', 'function', 'тест', 'test')) {
    return { type: 'coding_change', complexity: 'high', suggestedMaxSteps: 50 }
  }
  // NB: plain «файл»/«папка» removed — «создай файл hello.txt» is a simple
  // file op (general_agent_task below), not a 40-step repo audit.
  if (has('изучи', 'проанализируй', 'сравни', 'аудит', 'архитектур', 'структур', 'ревью', 'review')) {
    return { type: 'repo_analysis', complexity: 'high', suggestedMaxSteps: 40 }
  }
  if (has('найди в интернете', 'актуальн', 'новост', 'документац', 'research', 'web search', 'поиск')) {
    return { type: 'research', complexity: 'medium', suggestedMaxSteps: 25 }
  }
  if (has('браузер', 'открой сайт', 'скриншот', 'кликни', 'browser', 'url')) {
    return { type: 'browser_task', complexity: 'medium', suggestedMaxSteps: 35 }
  }
  // Action verbs that did not match a more specific bucket above
  // (including гитхаб/repo fetches without deploy context).
  if (hasActionVerb || has('гитхаб', 'репозиторий', 'репо ')) {
    return { type: 'general_agent_task', complexity: 'medium', suggestedMaxSteps: 20 }
  }

  // Long free-form text probably describes real work; short text without a
  // single action verb is a plain question — answer it cheaply.
  if (t.length > 100) {
    return { type: 'general_agent_task', complexity: 'medium', suggestedMaxSteps: 20 }
  }

  return { type: 'simple_answer', complexity: 'low', suggestedMaxSteps: 6 }
}

export function buildAgentContext({ provider = {}, history = [], extraSystem = '', userId = '', workspaceScope = '', maxSteps = 15 } = {}) {
  const userText = lastUserText(history)
  const task = classifyAgentTask(userText)
  const providerKind = inferProviderKind(provider.baseUrl || '')

  return {
    schema: 'browserai.agent_context.v1',
    createdAt: new Date().toISOString(),
    locale: 'ru-RU',
    timezone: process.env.TZ || 'Europe/Volgograd',
    user: {
      authenticated: Boolean(userId),
      idHash: userId ? String(userId).slice(0, 8) : '',
    },
    workspace: {
      scoped: Boolean(workspaceScope),
      scope: workspaceScope ? String(workspaceScope).slice(0, 80) : '',
      cwd: '/workspace',
      policy: publicWorkspacePolicy({ root: '/workspace', scoped: Boolean(workspaceScope) }),
    },
    model: {
      id: provider.model || '',
      providerKind,
      supportsNativeTools: ['openai-compatible', 'anthropic-official', 'google-gemini-official'].includes(providerKind),
      usesUniversalToolProtocol: !['openai-compatible', 'anthropic-official', 'google-gemini-official'].includes(providerKind),
    },
    task: {
      lastUserChars: userText.length,
      type: task.type,
      complexity: task.complexity,
      suggestedMaxSteps: task.suggestedMaxSteps,
    },
    runtime: {
      requestedMaxSteps: maxSteps,
      effectiveMaxSteps: Math.max(Number(maxSteps) || 0, Number(task.suggestedMaxSteps) || 0),
      hasExtraSystem: Boolean(String(extraSystem || '').trim()),
    },
  }
}

function resultTypeForTool(name = '') {
  if (['read_file', 'list_files', 'search_files', 'read_project_rules', 'project_profile', 'secret_scan', 'workspace_snapshot_list'].includes(name)) return 'workspace_read'
  if (['write_file', 'edit_file', 'delete_file', 'create_folder', 'rename_item', 'workspace_snapshot_create', 'workspace_snapshot_restore'].includes(name)) return 'workspace_write'
  if (['bash', 'npm_test', 'npm_install', 'docker_logs', 'docker_ps', 'verify_code', 'verify_task'].includes(name)) return 'command_result'
  if (['web_search', 'web_fetch'].includes(name)) return 'web_result'
  if (['ask_user'].includes(name)) return 'user_interaction'
  if (name.startsWith('browser_') || name.startsWith('computer_')) return 'browser_computer_result'
  if (name.startsWith('git_') || name === 'github_pr_create') return 'git_result'
  if (name.startsWith('kb_') || ['remember_fact', 'forget_fact', 'recall_facts'].includes(name)) return 'memory_result'
  if (name.startsWith('ops_')) return 'ops_result'
  if (name.startsWith('mcp__')) return 'mcp_result'
  return 'tool_result'
}

function safePreview(value, max = 1200) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)
  if (raw.length <= max) return raw
  return raw.slice(0, max) + `\n… [${raw.length - max} chars omitted]`
}

export function normalizeToolResult(toolName, rawResult, meta = {}) {
  const ok = Boolean(rawResult?.ok)
  const data = ok ? rawResult.result : null
  const error = ok ? null : String(rawResult?.error || 'unknown tool error')
  const previewSource = ok ? data : error

  return {
    schema: 'browserai.tool_result.v1',
    ok,
    type: resultTypeForTool(toolName),
    tool: toolName,
    data,
    error,
    display: {
      title: `${ok ? '✓' : '✗'} ${toolName}`,
      preview: safePreview(previewSource),
    },
    meta: {
      step: meta.step ?? null,
      sub: meta.sub ?? null,
      readBack: Boolean(meta.readBack),
      timestamp: new Date().toISOString(),
    },
  }
}

export function createAgentState({ agentContext = {}, history = [] } = {}) {
  const goal = lastUserText(history).slice(0, 2000)
  const needsPlan = ['medium', 'high'].includes(agentContext?.task?.complexity)
  return {
    schema: 'browserai.agent_state.v1',
    status: needsPlan ? 'planning' : 'running',
    phase: needsPlan ? 'discover' : 'execute',
    phaseReason: needsPlan ? 'initial-grounding' : 'simple-task',
    goal,
    plan: {
      title: '',
      steps: [],
      done: [],
    },
    completedSteps: [],
    currentStep: needsPlan ? 'Build an explicit plan before acting' : 'Answer or act on the user request',
    openQuestions: [],
    touchedFiles: [],
    lastErrors: [],
    nextActions: needsPlan ? ['call plan_set with a concise checklist'] : [],
    toolStats: {
      total: 0,
      ok: 0,
      failed: 0,
      byName: {},
    },
    updatedAt: new Date().toISOString(),
  }
}

export function buildPlanningDirective(agentContext = {}) {
  const complexity = agentContext?.task?.complexity || 'medium'
  if (complexity === 'low') return ''
  const taskType = agentContext?.task?.type || 'general_agent_task'
  return [
    '[agent_runtime_directive]',
    `Task classification: ${taskType} / ${complexity}.`,
    'Your workspace root is /workspace. DO NOT include /workspace/chats/ID/ prefixes in your paths.',
    'Always use exact casing from list_files (e.g. browserAI not browserai).',
    'Before doing substantial work, call plan_set with a short checklist unless the task is truly one-step.',
    'After completing a meaningful step, call plan_check for the completed index.',
    'Always explore the workspace (list_files, read_file, bash) FIRST to gather context before writing code or asking questions.',
    'Always check long-term memory first using recall_facts or kb_search when the task involves user preferences, previous decisions, or recurring context.',
    'Use remember_fact for stable user preferences and kb_add for important documents.',
    'Keep the user-visible final answer honest: mention only actions that actually happened in tool results.',
    'If you need a decision or missing credential, call ask_user, but ONLY if you cannot find the answer by exploring the workspace.',
    'For code changes: read before edit, edit via tools, then verify_task or verify_code/npm_test before claiming success.',
    '[/agent_runtime_directive]',
  ].join('\n')
}

export function buildDoneCriteriaDirective(agentContext = {}) {
  const type = agentContext?.task?.type || 'general_agent_task'
  const criteria = {
    coding_change: [
      'read the relevant files before editing',
      'apply changes with write_file/edit_file',
      'run verify_task (preferred) or verify_code/npm_test after the last code/config edit',
      'final answer lists changed files and verification result',
    ],
    repo_analysis: [
      'inspect the real local tree with list_files',
      'read README/package/entry files relevant to the project',
      'base findings only on files successfully read/searched',
      'final answer includes concrete paths and no invented files',
    ],
    deploy_ops: [
      'inspect current repo/service state before changing deployment',
      'after deploy/restart/commit/pull, run a health/log check (bash curl/docker logs or ops action)',
      'final answer reports deploy status and any failing logs/errors',
    ],
    browser_task: [
      'open/navigate the target page',
      'use screenshot/observable result to verify the UI state',
      'final answer states what was verified visually',
    ],
    research: [
      'use web_search/web_fetch for current external facts',
      'final answer cites/mentions real sources or says if none were fetched',
    ],
  }[type]
  if (!criteria) return ''
  return [
    '[done_criteria]',
    `Task type: ${type}. Do not final-answer until these are satisfied or explicitly impossible:`,
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '[/done_criteria]',
  ].join('\n')
}

function pushUnique(arr, value, limit = 30) {
  const v = String(value || '').trim()
  if (!v) return
  if (!arr.includes(v)) arr.push(v)
  if (arr.length > limit) arr.splice(0, arr.length - limit)
}

export function updateAgentStateFromTool(state, toolName, rawResult, args = {}) {
  if (!state) return state
  const ok = Boolean(rawResult?.ok)
  state.updatedAt = new Date().toISOString()
  state.toolStats.total += 1
  if (ok) state.toolStats.ok += 1
  else state.toolStats.failed += 1
  state.toolStats.byName[toolName] = (state.toolStats.byName[toolName] || 0) + 1

  if (!ok) {
    pushUnique(state.lastErrors, `${toolName}: ${rawResult?.error || 'unknown error'}`, 10)
    state.status = 'running'
    state.currentStep = `Recover from ${toolName} error`
    state.nextActions = ['inspect the error', 'try a different tool or parameters', 'ask_user if blocked']
    return state
  }

  const result = rawResult?.result

  if (toolName === 'plan_set') {
    const plan = Array.isArray(result?.steps) ? result.steps : (Array.isArray(result?.plan) ? result.plan : [])
    state.status = 'running'
    state.plan = {
      title: result?.title || state.goal.slice(0, 120),
      steps: plan.map((p) => ({ idx: Number(p.idx), text: String(p.text || ''), done: Boolean(p.done) })),
      done: [],
    }
    state.currentStep = state.plan.steps[0]?.text || 'Execute the plan'
    state.nextActions = state.plan.steps.length ? [state.currentStep] : []
    return state
  }

  if (toolName === 'plan_check') {
    const checked = Array.isArray(result?.checked) ? result.checked.map(Number) : []
    for (const idx of checked) {
      if (!state.plan.done.includes(idx)) state.plan.done.push(idx)
      const step = state.plan.steps.find((s) => s.idx === idx)
      if (step) {
        step.done = true
        pushUnique(state.completedSteps, `${idx}. ${step.text}`, 50)
      }
    }
    const next = state.plan.steps.find((s) => !s.done)
    state.currentStep = next?.text || 'Prepare final answer / verification summary'
    state.nextActions = next ? [next.text] : ['finalize honestly']
    return state
  }

  if (toolName === 'ask_user') {
    if (result?.pending) {
      state.status = 'waiting_for_user'
      const q = args?.question || (Array.isArray(args?.questions) ? args.questions.map((x) => x.question).join(' | ') : '')
      pushUnique(state.openQuestions, q || 'waiting for user input', 10)
      state.currentStep = 'Waiting for user answer'
      state.nextActions = ['resume after user answer']
    } else {
      state.status = 'running'
      state.openQuestions = []
      state.currentStep = 'User answered; continue task'
      state.nextActions = ['use the user answer and continue']
    }
    return state
  }

  const path = args?.path || args?.file || args?.file_path
  if (path && ['write_file', 'edit_file', 'delete_file', 'create_folder', 'rename_item', 'workspace_snapshot_create', 'workspace_snapshot_restore'].includes(toolName)) {
    pushUnique(state.touchedFiles, path, 50)
  }
  if (Array.isArray(result?.touched)) {
    for (const p of result.touched) pushUnique(state.touchedFiles, p, 50)
  }
  if (Array.isArray(result?.files)) {
    for (const f of result.files) if (f?.path) pushUnique(state.touchedFiles, f.path, 50)
  }

  if (toolName === 'verify_code' || toolName === 'npm_test') {
    const passed = Boolean(result?.allPassed ?? result?.passed)
    pushUnique(state.completedSteps, `${toolName}: ${passed ? 'passed' : 'completed with failures'}`, 50)
    state.currentStep = passed ? 'Verification passed; prepare final answer' : 'Fix verification failures'
    state.nextActions = passed ? ['finalize honestly'] : ['read failing output', 'edit files', 'run verification again']
    return state
  }

  state.status = 'running'
  state.currentStep = `Processed ${toolName}`
  if (state.nextActions.length === 0) state.nextActions = ['continue with the next required step']
  return state
}

const PATH_PARAM_RE = /^(path|file|file_path|cwd|parentPath|sourcePath|targetDirPath)$/i

function typeLabel(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function coerceToolValue(value, schema = {}, pName = '') {
  const expected = schema.type || 'string'
  let cleanValue = value

  if (expected === 'string' && typeof cleanValue === 'string') {
    if (PATH_PARAM_RE.test(pName)) {
      if (cleanValue === '/workspace' || cleanValue === '/home/user' || cleanValue === '/') {
        cleanValue = ''
      } else {
        // #18 FIX: Aggressive prefix cleanup for AI models. 
        // Covers /workspace/..., /home/user/..., and Arena-style scoped paths.
        const prefixRe = /^(?:\/workspace\/chats\/[a-zA-Z0-9_-]+|\/home\/user\/chats\/[a-zA-Z0-9_-]+|\/workspace|\/home\/user)\//
        if (prefixRe.test(cleanValue)) {
          cleanValue = cleanValue.replace(prefixRe, '')
        }
      }
    }
  }

  if (cleanValue === undefined || cleanValue === null) return { ok: true, value: cleanValue }

  if (expected === 'string') {
    if (typeof cleanValue === 'string') return { ok: true, value: cleanValue }
    return { ok: true, value: String(cleanValue), warning: `coerced ${typeLabel(cleanValue)} to string` }
  }
  if (expected === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
    const n = Number(value)
    if (Number.isFinite(n)) return { ok: true, value: n, warning: `coerced ${typeLabel(value)} to number` }
    return { ok: false, error: `expected number, got ${typeLabel(value)}` }
  }
  if (expected === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value }
    const s = String(value).toLowerCase().trim()
    if (['true', '1', 'yes', 'y', 'да'].includes(s)) return { ok: true, value: true, warning: `coerced ${typeLabel(value)} to boolean` }
    if (['false', '0', 'no', 'n', 'нет'].includes(s)) return { ok: true, value: false, warning: `coerced ${typeLabel(value)} to boolean` }
    return { ok: false, error: `expected boolean, got ${typeLabel(value)}` }
  }
  if (expected === 'array') {
    if (Array.isArray(value)) return { ok: true, value }
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) return { ok: true, value: parsed, warning: 'parsed JSON string to array' }
      } catch { /* fall through */ }
    }
    return { ok: false, error: `expected array, got ${typeLabel(value)}` }
  }
  if (expected === 'object') {
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value }
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed, warning: 'parsed JSON string to object' }
      } catch { /* fall through */ }
    }
    return { ok: false, error: `expected object, got ${typeLabel(value)}` }
  }

  return { ok: true, value }
}

function validatePathLike(name, value) {
  if (value === undefined || value === null || value === '') return { ok: true, value }
  const s = String(value)
  if (s.includes('\0')) return { ok: false, error: `${name}: NUL byte is not allowed` }
  
  let check = s
  
  // #17 FIX: Robust cleanup of absolute paths and Arena/Cline-style scoped prefixes
  if (check === '/workspace' || check === '/home/user' || check === '/') return { ok: true, value: '' }
  
  // Strip any absolute prefixes like /workspace/, /home/user/, /workspace/chats/ID/, etc.
  const prefixRe = /^(?:\/workspace\/chats\/[a-zA-Z0-9_-]+|\/home\/user\/chats\/[a-zA-Z0-9_-]+|\/workspace|\/home\/user)\//
  if (prefixRe.test(check)) {
    check = check.replace(prefixRe, '')
  } else if (check.startsWith('/')) {
    // Other absolute path — strip the leading slash but only if it's not a cwd-like param.
    if (name !== 'cwd') check = check.slice(1)
  }

  const normalised = check.replace(/\\/g, '/')
  if (normalised === '..' || normalised.startsWith('../') || normalised.includes('/../')) {
    return { ok: false, error: `${name}: path traversal is not allowed` }
  }
  if (normalised.includes('%2e') || normalised.includes('%2E')) return { ok: false, error: `${name}: encoded traversal is not allowed` }
  
  return { ok: true, value: check }
}

export function validateToolCall(toolName, args = {}, toolDef = null) {
  if (!toolName || typeof toolName !== 'string') {
    return { ok: false, args: {}, error: 'tool name must be a string', warnings: [] }
  }
  // MCP/custom tools may not have a local schema; still apply generic safety.
  const params = toolDef?.params || {}
  const clean = { ...(args || {}) }
  const warnings = []

  for (const [pName, meta] of Object.entries(params)) {
    const aliases = pName === 'path' ? ['path', 'file'] : [pName]
    const hasValue = aliases.some((a) => clean[a] !== undefined && clean[a] !== null && clean[a] !== '')
    if (meta.required && !hasValue) {
      return { ok: false, args: clean, error: `missing required parameter: ${pName}`, warnings }
    }
    if (!hasValue) continue
    const actualName = aliases.find((a) => clean[a] !== undefined && clean[a] !== null && clean[a] !== '') || pName
    const coerced = coerceToolValue(clean[actualName], meta, actualName)
    if (!coerced.ok) return { ok: false, args: clean, error: `${actualName}: ${coerced.error}`, warnings }
    clean[actualName] = coerced.value
    if (coerced.warning) warnings.push(`${actualName}: ${coerced.warning}`)
  }

  for (const [k, v] of Object.entries(clean)) {
    if (PATH_PARAM_RE.test(k)) {
      const res = validatePathLike(k, v)
      if (!res.ok) return { ok: false, args: clean, error: res.error, warnings }
      clean[k] = res.value // Apply the cleaned path
    }
    if (typeof v === 'string' && v.length > 1_000_000) {
      return { ok: false, args: clean, error: `${k}: string argument is too large`, warnings }
    }
  }

  return { ok: true, args: clean, error: null, warnings }
}

export function makeToolErrorResult(message, details = {}) {
  return {
    ok: false,
    error: String(message || 'tool routing error'),
    details,
  }
}
