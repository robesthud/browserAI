/**
 * agentLoop.js
 *
 * Provider-agnostic multi-step LLM ↔ tool agent.
 *
 * The same tool registry (server/agentTools.js) runs against any
 * OpenAI-compatible model — DeepSeek (managed), OpenAI, BigModel,
 * Groq, Mistral, Together, OpenRouter, Gemini's OpenAI proxy, Grok
 * (managed/web), etc. The actual transport lives in llmClient.js.
 *
 * Tool calling strategy (Arena.ai style):
 *   Primary: XML format <xai:function_call> with <xai:tool_name> and
 *            <parameter name="..."> tags. Supports multiple calls
 *            in a single response for parallel execution.
 *   Fallbacks: Native OpenAI tool_calls (when supported) and
 *            legacy JSON-in-fenced-block format.
 *
 * Flow:
 *   1. Build system prompt that documents every tool.
 *   2. Loop:
 *        a. callLLM(messages [+ tools if native])
 *        b. extract tool call from either reply.toolCalls[0] (native)
 *           or from a fenced JSON block in reply.text (text)
 *        c. execute, append observation, repeat
 *      until the model returns a plain answer or limits hit.
 *
 * Events streamed to the client (named SSE):
 *   thinking      {step}
 *   tool_start    {step, name, args}
 *   tool_result   {step, name, ok, result?, error?}
 *   assistant     {text}
 *   done          {steps, reason}
 *   error         {message}
 */
import { TOOLS, renderToolsForPrompt, invokeTool } from './agentTools.js'
import { withWorkspaceScope } from './workspace.js'
import {
  callLLM, callLLMStream, supportsNativeTools, supportsStreaming, normalizeProviderError,
} from './llmClient.js'
import { registerQuestion } from './askUserRegistry.js'
import {
  clipToolOutput, manageContext, applyAnthropicCacheHints, contextUsageFraction,
  upsertAgentStateDigest,
} from './contextManager.js'
import { buildClineSystemPrompt } from './clinePrompt.js'
import { recordSpend, checkCap, chatTotalUsd } from './costTracker.js'
import { shouldUseCheapEditor, wrapProviderForEditor, routingLabel } from './architectEditor.js'
import { requiresApproval, categoryOf } from './approvalGate.js'
import { recordCheckpoint } from './checkpoints.js'
import {
  buildAgentContext, normalizeToolResult, createAgentState,
  buildPlanningDirective, updateAgentStateFromTool,
  validateToolCall, makeToolErrorResult,
} from './agentCore.js'

const DEFAULT_MAX_STEPS = 15
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000

const TOOL_FENCE_RE = /```(?:json|tool|tool_call)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/i

// ── System prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt({ extraSystem = '', native = false, extraTools = null } = {}) {
  if (String(process.env.BROWSERAI_PROMPT_STYLE || 'cline').toLowerCase() === 'legacy') {
    return buildSystemPromptLegacy({ extraSystem, native, extraTools })
  }
  return buildClineSystemPrompt({
    extraSystem,
    native,
    extraTools,
    cwd: '/workspace',
  })
}

function buildSystemPromptLegacy({ extraSystem = '', native = false, extraTools = null } = {}) {
  const head = [
    'You are BrowserAI — an autonomous coding agent that thinks, plans, uses',
    'tools, verifies its own work, and reports honestly. You operate inside',
    'a real sandbox with files in /workspace and a live shell.',
    '',
    '# How you think (very important)',
    '',
    '  • Plan before you act on anything non-trivial. For tasks with more',
    '    than ~3 steps, call `plan_set` first with a short checklist, then',
    '    `plan_check` after each completed step. The user can SEE the plan',
    '    in the UI and knows what to expect.',
    '',
    '  • Reach for parallel tools. When you need to read 3 files / search',
    '    3 patterns / check 3 things — emit them in ONE response, side by',
    '    side. The loop runs them concurrently, you save N round-trips.',
    '    Especially: `read_file` × N at the start of a code-change task.',
    '',
    '  • Read before you write. Always `read_file` before `edit_file`,',
    '    never patch from memory. If a file is huge, \`search_files\` first',
    '    to find the exact byte range.',
    '',
    '  • Use long-term memory. When the user tells you a stable preference',
    '    or shares a recurring fact about themselves / their project, call',
    '    `remember_fact` (key/value, fast) and/or `kb_add` (long doc).',
    '    These survive across chats. Do NOT spam — only persist things',
    '    you would actually want to recall a week later.',
    '',
    '  • Recall before you guess. If the user references a past topic you',
    '    do not have in the current chat ("тот проект где мы…"), call',
    '    `kb_search` / `recall_facts` before asking for clarification.',
    '',
    '# Hard rules — non-negotiable',
    '',
    '  1. **Never** paste source code, patches, or diffs in your chat reply.',
    '     If the user asks to fix/edit/improve/refactor anything — you MUST',
    '     apply the change via `edit_file` / `write_file`. A reply that shows',
    '     code in markdown without a tool call first is a BUG.',
    '',
    '  2. **Prefer `edit_file`** with `edits:[{old_text,new_text},…]` over',
    '     `write_file` for changes touching < 80% of a file. write_file',
    '     replaces the whole file — easy to lose context.',
    '',
    '  3. **Verify your work.** After a batch of edits run `verify_code`',
    '     (or `run_tests` if the project has a suite). Never declare success',
    '     without verification passing on the files you touched.',
    '',
    '  4. **Confirm dangerous ops first.** Deploy / restart / delete repo /',
    '     `ops_run_action` with `confirm:true` — ALWAYS preceded by',
    '     `ask_user` so the user explicitly OKs the change.',
    '',
    '  5. **Be honest about failures.** If a tool failed, say so. If you',
    '     could not figure something out, say so and propose what info you',
    '     would need. Never invent file paths, commit ids, or tool results.',
    '',
    '  6. **Cite your real work in summaries.** Your final user-facing reply',
    '     lists ONLY tool calls you actually made (taken from the conversation',
    '     above). No phantom steps, no aspirational sentences in past tense.',
    '',
    '  7. Never invent tool names or parameter names — only what is listed',
    '     below. If a needed tool is missing, say so and `ask_user`.',
    '',
    '# Standard workflow for code-change requests',
    '',
    '  1. `plan_set` with the steps you intend to take (>3 step tasks).',
    '  2. `list_files` / `search_files` to locate targets (parallel where',
    '     it helps).',
    '  3. `read_file` each target (parallel batch).',
    '  4. `edit_file` with `edits:[…]` per file. Multi-file rename →',
    '     `replace_across_files` instead.',
    '  5. `verify_code` / `run_tests` on the touched paths.',
    '  6. If asked or appropriate: `git_status` → `git_commit` → `git_push`',
    '     → `github_pr_create`. Get `ask_user` confirmation BEFORE push.',
    '  7. Final RUSSIAN-language summary — only real, observed work.',
    '',
  ]
  const callingHelp = native
    ? [
        '# Calling tools',
        '',
        'Use the standard function-calling interface of this provider.',
        'Only call tools that appear in the spec below; do not invent names.',
        'After all tool work is complete, reply with plain markdown (no further tool call) — that is the final user-visible answer.',
        '',
      ]
    : [
        '# Calling tools',
        '',
        'When you need to use a tool, ALWAYS use this exact XML format:',
        '<xai:function_call>',
        '<xai:tool_name>tool_name_here</xai:tool_name>',
        '<parameter name="arg_name">value</parameter>',
        '</xai:function_call>',
        '',
        'You can output MULTIPLE <xai:function_call> blocks one after another',
        'to call several tools in parallel in a single response.',
        'Do NOT escape any arguments. The arguments will be parsed as normal text.',
        '',
        'After you receive a tool result you may either:',
        '  • call another tool (same JSON envelope), or',
        '  • give the user the final answer as plain markdown (no JSON envelope).',
        '',
        'NEVER return raw source code in the markdown reply — apply it with a tool first.',
        '',
      ]
  const tail = [
    '# Available tools',
    '',
    renderToolsForPrompt(extraTools),
    extraSystem ? '\n# Extra context\n\n' + extraSystem : '',
  ].filter(Boolean)

  return [...head, ...callingHelp, ...tail].join('\n')
}

// ── OpenAI-format tools[] schema ────────────────────────────────────────────
function buildNativeToolsSpec(extraTools = null) {
  const combined = extraTools && typeof extraTools === 'object' ? { ...TOOLS, ...extraTools } : TOOLS
  return Object.entries(combined).map(([name, def]) => {
    const properties = {}
    const required = []
    for (const [pName, pMeta] of Object.entries(def.params || {})) {
      const schemaType = pMeta.type === 'number' ? 'number'
        : pMeta.type === 'boolean' ? 'boolean'
        : pMeta.type === 'array' ? 'array'
        : pMeta.type === 'object' ? 'object'
        : 'string'
      properties[pName] = {
        type: schemaType,
        description: pMeta.description || '',
      }
      if (schemaType === 'array') properties[pName].items = { type: 'object' }
      if (schemaType === 'object') properties[pName].additionalProperties = true
      if (pMeta.required) required.push(pName)
    }
    return {
      type: 'function',
      function: {
        name,
        description: def.description || '',
        parameters: {
          type: 'object',
          properties,
          required,
        },
      },
    }
  })
}

// ── Context management helpers ──────────────────────────────────────────────
import { tokenBudgetFor } from './modelKnowledge.js'
function clipForLLM(s, modelId = '') {
  const budget = tokenBudgetFor(modelId)
  const head = Number(process.env.TOOL_OUTPUT_HEAD || budget.head)
  const tail = Number(process.env.TOOL_OUTPUT_TAIL || budget.tail)
  const str = String(s || '')
  const max = head + tail + 200
  if (str.length <= max) return str
  const hidden = str.length - head - tail
  return `${str.slice(0, head)}\n\n… [${hidden} characters omitted] …\n\n${str.slice(-tail)}`
}

function maybeAutoCompact(convo, modelId) {
  const budget = tokenBudgetFor(modelId)
  const budgetChars = budget.ctxTokens * 4
  let total = 0
  for (const m of convo) total += String(m?.content || '').length
  if (total < budgetChars * 0.6) return false
  const sys = convo[0]?.role === 'system' ? convo[0] : null
  const keepTail = 8
  if (convo.length - (sys ? 1 : 0) <= keepTail + 2) return false
  const middleStart = sys ? 1 : 0
  const middleEnd = convo.length - keepTail
  const middle = convo.slice(middleStart, middleEnd)
  const lines = []
  for (const m of middle) {
    if (m.role === 'user') lines.push(`U: ${String(m.content || '').slice(0, 240)}`)
    else if (m.role === 'assistant') {
      const t = String(m.content || '').slice(0, 240)
      const tools = Array.isArray(m.tool_calls) ? m.tool_calls.map((tc) => tc?.function?.name || tc?.name).filter(Boolean) : []
      if (tools.length) lines.push(`A used: ${tools.join(', ')}`)
      if (t) lines.push(`A: ${t}`)
    } else if (m.role === 'tool') {
      lines.push(`T ${m.name || ''}: ${String(m.content || '').slice(0, 240)}`)
    }
  }
  const digest = {
    role: 'user',
    content: '[auto-compact summary of earlier turns]\n\n' + lines.join('\n').slice(0, 4000),
  }
  convo.splice(middleStart, middle.length, digest)
  return true
}

// ── SSE helper ──────────────────────────────────────────────────────────────
function normaliseSsePayload(res, event, data) {
  const seq = (res.__browseraiAgentSseSeq = Number(res.__browseraiAgentSseSeq || 0) + 1)
  const timestamp = new Date().toISOString()
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data }
  return {
    schema: 'browserai.agent_stream_event.v1',
    event,
    seq,
    timestamp,
    ...payload,
    payload,
  }
}

function sse(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(normaliseSsePayload(res, event, data))}\n\n`)
  } catch { /* closed */ }
}

function sseKeepAlive(res) {
  try { res.write(': keep-alive\n\n') } catch { /* closed */ }
}

// ── Reflection and Learning ──────────────────────────────────────────────────
async function runReflectionCheck({ provider, ask, draft, toolHistory }) {
  const toolSummary = (toolHistory || []).slice(-12).map((h) => `${h.ok ? '✓' : '✗'} ${h.tool}`).join(', ') || '(none)'
  const prompt = [
    'Ты — критик автономного агента. Оцени, выполнил ли он задачу пользователя.',
    '',
    `Запрос пользователя:\n${String(ask || '').slice(0, 1500)}`,
    '',
    `Инструменты: ${toolSummary}`,
    '',
    `Финальный ответ:\n${String(draft || '').slice(0, 2000)}`,
    '',
    'Ответь DONE или TODO: <причина>',
  ].join('\n')

  let reviewModel = provider.model
  try {
    const { lookupModel, suggestStrongSibling } = await import('./modelKnowledge.js')
    const tier = lookupModel(provider.model).tier
    if (tier === 'cheap') {
      const strong = suggestStrongSibling(provider.model)
      if (strong) reviewModel = strong
    }
  } catch { }

  const reply = await callLLM({
    baseUrl: provider.baseUrl, apiKey: provider.apiKey,
    authType: provider.authType || 'bearer',
    authHeader: provider.authHeader || '',
    extraHeaders: provider.extraHeaders || {},
    model: reviewModel,
    messages: [
      { role: 'system', content: 'You are a terse reviewer.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
  })
  const out = String(reply?.text || '').trim().split('\n')[0] || ''
  const todoMatch = out.match(/^\s*todo\s*[:\-—]?\s*(.+)$/i)
  return { needsMoreWork: !!todoMatch, reason: todoMatch ? todoMatch[1].trim() : '', usage: reply.usage }
}

async function streamFinalAnswer(res, fullText) {
  const text = String(fullText || '')
  if (!text) {
    sse(res, 'assistant', { text: '' })
    return
  }
  const parts = text.match(/.{1,32}/g) || [text]
  for (const chunk of parts) {
    sse(res, 'assistant_delta', { chunk })
    await new Promise((r) => setTimeout(r, 10))
  }
  sse(res, 'assistant', { text })
}

// ── XML Parsing and Streaming LLM Call ───────────────────────────────────────
async function streamingLLMCall(res, step, opts, hooks = {}) {
  const OPEN_RE  = /<(?:xai:function_call|tool_use|function_call|thinking|thought)([^>]*)>/i
  const CLOSE_RE = /<\/(?:xai:function_call|tool_use|function_call|thinking|thought)>/i

  let scanBuf = ''
  let visibleTextBuf = ''
  let insideXml = false
  let xmlTagName = ''
  let xmlOpenAttrs = ''
  const preParsedCalls = []

  function parseXmlBody(body, tagName, openAttrs) {
    if (tagName === 'thinking' || tagName === 'thought') return { kind: 'thinking', text: body.trim() }
    const nameMatch = body.match(/<(?:xai:)?tool_name>([^<]+)<\/(?:xai:)?tool_name>/i) || body.match(/<name>([^<]+)<\/name>/i)
    let tool = nameMatch ? nameMatch[1].trim() : ''
    if (!tool) {
      const m = openAttrs.match(/name="([^"]+)"/i)
      if (m) tool = m[1].trim()
    }
    if (!tool) {
      const line1 = body.trim().split('\n')[0]
      if (line1 && /^[a-z_]+$/.test(line1)) tool = line1
    }
    if (!tool) return null
    const params = {}
    const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi
    let pm
    while ((pm = paramRe.exec(body)) != null) params[pm[1]] = pm[2]
    return { kind: 'tool', tool, args: params }
  }

  function flushVisibleText() {
    if (!visibleTextBuf) return
    if (preParsedCalls.length > 0 || insideXml) {
       sse(res, 'thought', { step, text: visibleTextBuf })
    } else {
       sse(res, 'assistant_delta', { step, chunk: visibleTextBuf })
    }
    visibleTextBuf = ''
  }

  function consumeChunk(chunk) {
    scanBuf += chunk
    while (true) {
      if (!insideXml) {
        const m = scanBuf.match(OPEN_RE)
        if (!m) {
          const lastLt = scanBuf.lastIndexOf('<')
          if (lastLt !== -1 && scanBuf.length - lastLt < 40) {
            const safe = scanBuf.slice(0, lastLt)
            if (safe) { visibleTextBuf += safe; flushVisibleText() }
            scanBuf = scanBuf.slice(lastLt)
            return
          } else {
            visibleTextBuf += scanBuf; flushVisibleText(); scanBuf = ''; return
          }
        }
        const before = scanBuf.slice(0, m.index)
        if (before) { visibleTextBuf += before; flushVisibleText() }
        xmlTagName = m[0].replace(/[<>]/g, '').split(' ')[0]
        xmlOpenAttrs = m[1] || ''
        insideXml = true
        scanBuf = scanBuf.slice(m.index + m[0].length)
      } else {
        const m = scanBuf.match(CLOSE_RE)
        if (!m) return
        const body = scanBuf.slice(0, m.index)
        scanBuf = scanBuf.slice(m.index + m[0].length)
        insideXml = false
        const parsed = parseXmlBody(body, xmlTagName, xmlOpenAttrs)
        xmlTagName = ''; xmlOpenAttrs = ''
        if (parsed) {
          if (parsed.kind === 'thinking') sse(res, 'thinking_delta', { step, chunk: parsed.text })
          else {
            preParsedCalls.push(parsed)
            sse(res, 'tool_preview', { step, name: parsed.tool, args: parsed.args })
            hooks.onParsedCall?.(parsed)
          }
        }
      }
    }
  }

  const result = await callLLMStream({
    ...opts,
    onTextDelta: (chunk, meta) => {
      if (meta?.kind === 'thinking') { sse(res, 'thinking_delta', { step, chunk: String(chunk || '') }); return }
      consumeChunk(String(chunk || ''))
    },
    onUsage: (u) => hooks.onUsage?.(u),
  })
  if (scanBuf) { visibleTextBuf += scanBuf; scanBuf = '' }
  if (visibleTextBuf) flushVisibleText()
  return { ...result, preParsedCalls }
}

function sseDone(res, payload, tokens) { sse(res, 'done', { ...payload, tokens }) }

// ── Main Loop ────────────────────────────────────────────────────────────────
export async function runAgent(opts) {
  return withWorkspaceScope(opts?.workspaceScope || '', () => runAgentInner({ ...(opts || {}), workspaceScope: opts?.workspaceScope || '' }))
}

async function runAgentInner({ provider, history = [], maxSteps = DEFAULT_MAX_STEPS, extraSystem = '', userId = '', workspaceScope = '', res }) {
  const chatId = String(workspaceScope || '')
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  sse(res, 'stream_protocol', { version: 1, events: ['stream_protocol', 'agent_context', 'agent_state', 'thinking', 'thinking_delta', 'assistant_delta', 'assistant', 'thought', 'tool_preview', 'tool_router', 'tool_start', 'tool_progress', 'tool_result', 'tool_diagnostic', 'ask_user', 'tool_approval', 'usage', 'done', 'error'] })

  const tokens = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 }
  function accumulateUsage(u) {
    if (!u) return
    tokens.prompt += Number(u.prompt || 0); tokens.completion += Number(u.completion || 0); tokens.total += Number(u.total || (u.prompt + u.completion) || 0)
    tokens.reasoningTokens += Number(u.reasoningTokens || 0); tokens.llmCalls += 1
  }

  if (!provider?.baseUrl || !provider?.apiKey) {
    sse(res, 'error', { message: 'Provider is not configured' }); sseDone(res, { steps: 0, reason: 'no-provider' }, tokens); res.end(); return
  }

  let extraTools = null
  try {
    const { loadCustomToolsFor } = await import('./customTools.js')
    const map = loadCustomToolsFor(userId); if (Object.keys(map).length) extraTools = map
  } catch { }

  let useNativeTools = supportsNativeTools(provider.baseUrl)
  let systemPrompt = buildSystemPrompt({ extraSystem, native: useNativeTools, extraTools })
  let toolsSpec = useNativeTools ? buildNativeToolsSpec(extraTools) : undefined

  const convo = [{ role: 'system', content: systemPrompt }, ...history]
  const deadline = Date.now() + DEFAULT_DEADLINE_MS
  let step = 0, aborted = false
  const abortCtl = new AbortController()
  res.on('close', () => { aborted = true; abortCtl.abort('client closed') })

  const agentContext = buildAgentContext({ provider, history, extraSystem, userId, workspaceScope, maxSteps })
  if (agentContext.runtime.effectiveMaxSteps > maxSteps) maxSteps = agentContext.runtime.effectiveMaxSteps
  const agentState = createAgentState({ agentContext, history })
  const planningDirective = buildPlanningDirective(agentContext)
  if (planningDirective) convo.push({ role: 'user', content: planningDirective })
  
  sse(res, 'agent_context', agentContext); sse(res, 'agent_state', agentState)
  if (res.flushHeaders) res.flushHeaders()

  const keepAliveInterval = setInterval(() => sseKeepAlive(res), 15_000)
  res.on('close', () => clearInterval(keepAliveInterval))

  const recentCallFingerprints = [], recentToolHistory = [], planState = { done: new Set() }
  let pushedBackThisTurn = false, discoveryDone = false

  try {
    while (step < maxSteps) {
      if (aborted) break
      if (!discoveryDone && userId) {
        discoveryDone = true
        try {
          const lessonFile = '.browserai/lessons.md'
          const lessons = await withWorkspaceScope(chatId, () => readWorkspaceFile(lessonFile).catch(() => null))
          if (lessons?.text) convo.push({ role: 'user', content: `<arena-system-message>\nLessons Learned:\n${lessons.text}\n</arena-system-message>` })
        } catch {}
        try {
          const r = await invokeTool('build_repo_map', { path: '', _userId: userId }, { signal: abortCtl.signal, userId, chatId, extraTools })
          if (r.ok) convo.push({ role: 'user', content: `<arena-system-message>\nInitial Repo Map:\n${r.result}\n</arena-system-message>` })
        } catch {}
      }

      if (Date.now() > deadline) {
        sse(res, 'error', { message: 'Deadline exceeded' }); sseDone(res, { steps: step, reason: 'deadline' }, tokens); break
      }
      step += 1
      if (step > 1 && step % 6 === 0) {
        const { renderAgentStateDigest } = await import('./contextManager.js')
        convo.push({ role: 'user', content: `[focus_chain_reminder]\n${renderAgentStateDigest(agentState, recentToolHistory)}` })
      }
      pushedBackThisTurn = false
      upsertAgentStateDigest(convo, agentState, recentToolHistory)
      manageContext(convo, provider?.model)
      sse(res, 'thinking', { step })

      const capCheck = checkCap(userId)
      if (!capCheck.ok) { sse(res, 'error', { message: capCheck.reason }); sseDone(res, { steps: step, reason: 'cap-reached' }, tokens); res.end(); return }

      const routing = shouldUseCheapEditor({ provider, step, recentToolHistory, userId })
      const activeProvider = routing.useCheap ? wrapProviderForEditor(provider, routing.cheapModel) : provider
      if (routing.useCheap) sse(res, 'thought', { step, text: routingLabel(routing) })

      let reply, streamedFinalAnswer = false
      try {
        const useStream = supportsStreaming(activeProvider.baseUrl)
        const messagesWithCache = applyAnthropicCacheHints(convo, activeProvider.baseUrl)
        const llmArgs = { baseUrl: activeProvider.baseUrl, apiKey: activeProvider.apiKey, authType: activeProvider.authType || 'bearer', authHeader: activeProvider.authHeader || '', extraHeaders: activeProvider.extraHeaders || {}, model: activeProvider.model, messages: messagesWithCache, temperature: Number(activeProvider.temperature ?? 0.3), signal: abortCtl.signal, ...(useNativeTools ? { tools: toolsSpec, toolChoice: 'auto' } : {}) }
        if (useStream) {
          reply = await streamingLLMCall(res, step, llmArgs, { onUsage: (u) => accumulateUsage(u) })
          streamedFinalAnswer = !reply.toolCalls?.length && !reply.preParsedCalls?.length
        } else {
          reply = await callLLM(llmArgs); accumulateUsage(reply?.usage)
        }
      } catch (e) {
        const providerError = normalizeProviderError(e, { baseUrl: provider.baseUrl, model: provider.model, phase: 'agent-llm-call' })
        sse(res, 'error', { message: 'LLM failed: ' + providerError.message, providerError }); sseDone(res, { steps: step, reason: 'llm-error' }, tokens); res.end(); return
      }

      let spendNote = null
      try { spendNote = recordSpend({ userId, chatId, model: activeProvider.model, usage: reply?.usage || {} }) } catch { }
      if (reply?.usage) sse(res, 'usage', { step, ...reply.usage, totals: { ...tokens }, cost: spendNote?.cost || 0 })

      let calls = []
      if (useNativeTools && Array.isArray(reply.toolCalls)) {
        for (const tc of reply.toolCalls) if (TOOLS[tc.name] || (extraTools && extraTools[tc.name])) calls.push({ tool: tc.name, args: tc.args || {}, nativeId: tc.id, nativeRaw: tc.raw })
      }
      if (calls.length === 0) {
        const xmlCalls = parseXmlFunctionCalls(reply.text || '')
        for (const c of xmlCalls) if (TOOLS[c.tool] || (extraTools && extraTools[c.tool])) calls.push(c)
      }

      if (calls.length === 0) {
        const lastUserAsk = [...history].reverse().find((m) => m.role === 'user')?.content || ''
        const didRealWork = recentToolHistory.some((h) => h.ok && !['ask_user', 'recall_facts', 'plan_check', 'plan_set'].includes(h.tool))
        if (didRealWork && !convo.some(m => m.role === 'user' && String(m.content).startsWith('[reflection]')) && !aborted) {
          const verdict = await runReflectionCheck({ provider, ask: lastUserAsk, draft: reply.text || '', toolHistory: recentToolHistory }).catch(() => null)
          if (verdict?.needsMoreWork) {
            sse(res, 'thought', { step, text: `Самопроверка: ${verdict.reason}` })
            convo.push({ role: 'user', content: `[reflection] Gaps identified:\n${verdict.reason}` }); continue
          }
        }
        if (streamedFinalAnswer) sse(res, 'assistant', { text: reply.text || '' })
        else await streamFinalAnswer(res, reply.text || '')

        if (didRealWork && !aborted && userId) {
          try {
            const learnPrompt = `What technical lesson was learned? One short sentence in Russian.`
            const learnReply = await callLLM({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, authType: provider.authType, authHeader: provider.authHeader, extraHeaders: provider.extraHeaders, model: provider.model, messages: [...convo.slice(-4), { role: 'user', content: learnPrompt }], temperature: 0.1 })
            const lesson = String(learnReply?.text || '').trim(); if (lesson && lesson.length < 200) { await invokeTool('save_lesson', { lesson, _chatId: chatId }); sse(res, 'thought', { step, text: `Усвоен урок: ${lesson}` }) }
          } catch { }
        }
        sseDone(res, { steps: step, reason: 'final' }, tokens); res.end(); return
      }

      if (calls.some(c => c.nativeId)) convo.push({ role: 'assistant', content: reply.text || '', tool_calls: calls.filter(c => c.nativeId).map(c => c.nativeRaw) })
      else convo.push({ role: 'assistant', content: reply.text || '' })

      const thinkingText = (reply.text || '').replace(TOOL_FENCE_RE, '').trim()
      if (thinkingText) sse(res, 'thought', { step, text: thinkingText })

      for (let i = 0; i < calls.length; i++) if (calls[i].tool === 'plan_check') calls[i] = dedupePlanCheck(calls[i], planState)
      const readBacks = makeReadBackForEdits(calls)
      for (const rb of readBacks) calls.push(rb)

      const results = await Promise.all(calls.map(async (call, idx) => {
        recentCallFingerprints.push(callFingerprint(call)); if (recentCallFingerprints.length > 20) recentCallFingerprints.shift()
        if (violatesPreDeployVerify(call, recentToolHistory)) return { call, r: makeToolErrorResult('Blocked: verify_code required.'), pushedBack: true }
        if (isStuckLoop(recentCallFingerprints, callFingerprint(call))) return { call, r: makeToolErrorResult('Blocked: Stuck in loop.'), pushedBack: true }

        const combinedTools = { ...TOOLS, ...extraTools }
        const validation = validateToolCall(call.tool, call.args || {}, combinedTools[call.tool])
        if (!validation.ok) {
          if (!pushedBackThisTurn && !aborted) { pushedBackThisTurn = true; sse(res, 'thought', { step, text: `Ошибка схемы: ${validation.error}` }); return { call, r: makeToolErrorResult(`[schema_error] ${validation.error}`), pushedBack: true } }
          return { call, r: makeToolErrorResult(validation.error) }
        }
        call.args = validation.args
        if (call.tool !== 'ask_user' && requiresApproval(call.tool, userId)) {
          const { id: aqId, promise: aqPromise, expiresAt } = registerQuestion({ kind: 'tool_approval', userId, chatId, step, sub: idx, tool: call.tool, category: categoryOf(call.tool), argsPreview: JSON.stringify(call.args).slice(0, 2000), question: `Approve ${call.tool}?`, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], multi: false, allowCustom: true })
          sse(res, 'tool_approval', { step, sub: idx, question_id: aqId, expiresAt, tool: call.tool, args: call.args })
          let approved = false; try { const ans = await aqPromise; const pick = Array.isArray(ans?.selected) ? String(ans.selected[0]) : String(ans?.text || ans); approved = ['approve', 'yes', 'ok', 'allow', 'true'].includes(pick.toLowerCase().trim()) } catch { }
          if (!approved) return { call, r: { ok: false, error: 'User denied.' } }
        }

        sse(res, 'tool_start', { step, sub: idx, name: call.tool, args: call.args })
        let r
        if (call.tool === 'ask_user') {
          const aArgs = call.args || {}, rawList = Array.isArray(aArgs.questions) ? aArgs.questions : [{ id: 'q1', question: aArgs.question || '?', options: aArgs.options || [], allowCustomResponse: aArgs.allow_custom !== false, multi: aArgs.multi !== false }]
          const answers = await Promise.all(rawList.slice(0, 6).map(q => { const { id, promise, expiresAt } = registerQuestion({ kind: 'ask_user', userId, chatId, step, sub: idx, question: q.question, options: q.options, multi: q.multi, allowCustom: q.allowCustomResponse }); sse(res, 'ask_user', { step, sub: idx, question_id: id, expiresAt, question: q.question, options: q.options }); return promise.then(a => ({ ok: true, answer: a }), e => ({ ok: false, error: e.message })) }))
          r = { ok: true, result: answers.length === 1 ? answers[0].answer : { answers } }
        } else {
          r = await invokeTool(call.tool, { ...call.args, _provider: provider }, { signal: abortCtl.signal, onStdout: (c) => sse(res, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stdout', chunk: String(c).slice(0, 2000) }), onStderr: (c) => sse(res, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stderr', chunk: String(c).slice(0, 2000) }), userId, chatId, extraTools })
        }
        if (!r.ok && !pushedBackThisTurn && !aborted && categoryOf(call.tool) !== 'ask') { pushedBackThisTurn = true; return { call, r: makeToolErrorResult(`[exec_error] ${r.error}`), pushedBack: true } }
        updateAgentStateFromTool(agentState, call.tool, r, call.args); sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: !!r.ok, result: r.result, error: r.error, structured: normalizeToolResult(call.tool, r, { step, sub: idx }) }); sse(res, 'agent_state', agentState)
        return { call, r }
      }))

      let sawPushBack = false
      for (const res of results) { if (res?.pushedBack) sawPushBack = true; if (res?.call && res?.r) { recentToolHistory.push({ tool: res.call.tool, ok: !!res.r.ok, at: Date.now() }); if (res.call.tool === 'plan_set' && res.r.ok) planState.done = new Set(); else if (res.call.tool === 'plan_check' && res.r.ok) (res.r.result?.checked || []).forEach(idx => planState.done.add(Number(idx))) } }
      if (sawPushBack) continue

      for (const { call, r } of results) {
        let obsRaw = r.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) : 'ERROR: ' + r.error
        if (r.ok && r.result?.diagnostics?.ok === false) obsRaw = `⚠ SYNTAX-CHECK FAILED: ${r.result.diagnostics.error}\n\n${obsRaw}`
        let obsContent = clipToolOutput(call.tool, obsRaw, provider?.model)
        if (r.ok && r.result?.dataUrl && useNativeTools) obsContent = [{ type: 'text', text: clipToolOutput(call.tool, { ...obsRaw, dataUrl: undefined }, provider?.model) }, { type: 'image_url', image_url: { url: r.result.dataUrl } }]
        if (call.nativeId) convo.push({ role: 'tool', tool_call_id: call.nativeId, name: call.tool, content: obsContent })
        else convo.push({ role: 'user', content: `<arena-system-message>\nTool result for ${call.tool}:\nok: ${r.ok}\n</arena-system-message>\n${obsContent}` })
      }
    }
    if (step >= maxSteps) { sse(res, 'error', { message: `Stopped after ${maxSteps} steps` }); sseDone(res, { steps: step, reason: 'max-steps' }, tokens) }
  } catch (e) { sse(res, 'error', { message: e.message }); sseDone(res, { steps: step, reason: 'crash' }, tokens) } finally { try { res.end() } catch { } }
}
