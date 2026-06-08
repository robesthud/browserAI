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

  if (has('деплой', 'разверни', 'сервер', 'timeweb', 'docker', 'nginx', 'ssl', 'github actions', 'ci/cd')) {
    return { type: 'deploy_ops', complexity: 'high', suggestedMaxSteps: 60 }
  }
  if (has('исправ', 'почини', 'реализуй', 'добавь', 'перепиши', 'refactor', 'fix ', 'implement', 'bug', 'ошибк')) {
    return { type: 'coding_change', complexity: 'high', suggestedMaxSteps: 50 }
  }
  if (has('изучи', 'проанализируй', 'сравни', 'аудит', 'проверь репозиторий', 'архитектур')) {
    return { type: 'repo_analysis', complexity: 'high', suggestedMaxSteps: 40 }
  }
  if (has('найди в интернете', 'актуальн', 'новост', 'документац', 'research', 'web search')) {
    return { type: 'research', complexity: 'medium', suggestedMaxSteps: 25 }
  }
  if (has('браузер', 'открой сайт', 'скриншот', 'кликни', 'browser')) {
    return { type: 'browser_task', complexity: 'medium', suggestedMaxSteps: 35 }
  }
  if (has('картинк', 'изображен', 'сгенерируй изображ', 'лого', 'иконк')) {
    return { type: 'image_task', complexity: 'medium', suggestedMaxSteps: 20 }
  }

  if (t.length < 140 && !/[?؟]?$/.test(t.trim())) {
    return { type: 'simple_answer', complexity: 'low', suggestedMaxSteps: 6 }
  }
  return { type: 'general_agent_task', complexity: 'medium', suggestedMaxSteps: 15 }
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
    },
    model: {
      id: provider.model || '',
      providerKind,
      supportsNativeTools: providerKind === 'openai-compatible',
      usesUniversalToolProtocol: providerKind !== 'openai-compatible',
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
  if (['read_file', 'list_files', 'search_files', 'find_projects', 'file_history'].includes(name)) return 'workspace_read'
  if (['write_file', 'edit_file', 'delete_file', 'restore_file', 'replace_across_files'].includes(name)) return 'workspace_write'
  if (['bash', 'bash_reset', 'bash_bg', 'bash_logs', 'bash_stop', 'bash_list', 'verify_code', 'run_tests'].includes(name)) return 'command_result'
  if (['web_search', 'web_fetch', 'fetch_page'].includes(name)) return 'web_result'
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
    'Before doing substantial work, call plan_set with a short checklist unless the task is truly one-step.',
    'After completing a meaningful step, call plan_check for the completed index.',
    'Keep the user-visible final answer honest: mention only actions that actually happened in tool results.',
    'If you need a decision or missing credential, call ask_user and wait for the answer instead of guessing.',
    'For code changes: read before edit, edit via tools, then verify_code or run_tests before claiming success.',
    '[/agent_runtime_directive]',
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
    const plan = Array.isArray(result?.plan) ? result.plan : []
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
  if (path && ['write_file', 'edit_file', 'delete_file', 'restore_file', 'replace_across_files'].includes(toolName)) {
    pushUnique(state.touchedFiles, path, 50)
  }
  if (Array.isArray(result?.touched)) {
    for (const p of result.touched) pushUnique(state.touchedFiles, p, 50)
  }
  if (Array.isArray(result?.files)) {
    for (const f of result.files) if (f?.path) pushUnique(state.touchedFiles, f.path, 50)
  }

  if (toolName === 'verify_code' || toolName === 'run_tests') {
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
