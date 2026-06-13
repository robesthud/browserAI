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
 */
import { TOOLS, LITE_TOOL_NAMES, invokeTool } from './agentTools.js'
import {
  withWorkspaceScope, readWorkspaceFile, readProjectRules, listRecentWorkspaceActivity,
} from './workspace.js'
import {
  callLLM, callLLMStream, supportsNativeTools, supportsStreaming, normalizeProviderError,
} from './llmClient.js'
import { registerQuestion } from './askUserRegistry.js'
import { searchWeb, fetchWebPage } from './web.js'
import { routeHistory } from './smartRouter.js'
import { routeDeterministicAction } from './deterministicActionRouter.js'
import {
  clipToolOutput, manageContext, applyAnthropicCacheHints,
  upsertAgentStateDigest,
} from './contextManager.js'
import { buildAgentSystemPrompt } from './agentPrompt.js'
import { recordSpend, checkCap } from './costTracker.js'
import { shouldUseCheapEditor, wrapProviderForEditor, routingLabel } from './architectEditor.js'
import { requiresApproval, categoryOf } from './approvalGate.js'
import {
  buildAgentContext, normalizeToolResult, createAgentState,
  buildPlanningDirective, buildDoneCriteriaDirective, updateAgentStateFromTool,
  validateToolCall, makeToolErrorResult,
} from './agentCore.js'

const DEFAULT_MAX_STEPS = 15
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000
const IDLE_NOTICE_MS = 75 * 1000
const LLM_HARD_IDLE_MS = 2 * 60 * 1000
const activeRunsByChat = new Map()

const COMMON_AGENT_TOOLS = [
  'plan_set', 'plan_check', 'ask_user', 'read_project_rules',
  'recall_facts', 'remember_fact', 'forget_fact', 'kb_search', 'kb_list', 'kb_add', 'kb_delete',
]

// Keep these profiles in sync with the real registry in agentTools.js.
// Listing non-existent tools in the prompt was a major cause of the
// "thinking forever / no actions" failure: models tried to call tools that
// the runner then ignored or rejected.
const TOOL_PROFILES = {
  general: [
    ...COMMON_AGENT_TOOLS,
    'list_files', 'read_file', 'search_files',
    'write_file', 'edit_file', 'delete_file', 'zip_files',
    'bash', 'verify_code',
    'web_search', 'web_fetch',
    'git_status', 'git_clone',
    'generate_image', 'edit_image', 'generate_video', 'analyze_image', 'text_to_speech', 'transcribe_audio',
  ],
  code: [
    ...COMMON_AGENT_TOOLS,
    'list_files', 'read_file', 'search_files',
    'write_file', 'edit_file', 'delete_file', 'zip_files',
    'bash', 'npm_install', 'npm_test', 'verify_code',
    'git_status', 'git_clone', 'git_commit',
  ],
  ops: [
    ...COMMON_AGENT_TOOLS,
    'ops_list_services', 'ops_run_action',
    'docker_ps', 'docker_logs',
    'bash', 'npm_test', 'verify_code',
    'web_search', 'web_fetch',
    'git_status', 'git_clone', 'git_commit',
    'list_files', 'read_file', 'search_files', 'edit_file', 'write_file', 'zip_files',
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

function toolProfileForTask(task = {}) {
  switch (task?.type) {
    case 'deploy_ops': return 'ops'
    case 'coding_change': return 'code'
    case 'repo_analysis': return 'code'
    case 'research': return 'research'
    case 'browser_task': return 'browser'
    default: return 'general'
  }
}

function profileToolNames(profile = 'general') {
  return [...new Set(TOOL_PROFILES[profile] || TOOL_PROFILES.general)]
}

// ── System prompt builder ───────────────────────────────────────────────────
async function buildSystemPrompt({ extraSystem = '', native = false, extraTools = null, chatId = '', lite = false, toolNames = null } = {}) {
  // Lite profile: skip workspace scans and MCP discovery entirely —
  // a greeting doesn't need project rules or the repo activity feed.
  if (lite) {
    return buildAgentSystemPrompt({ extraSystem, native, extraTools, cwd: '/workspace', lite: true, toolNames })
  }

  const [projectRules, recentActivity] = await Promise.all([
    withWorkspaceScope(chatId, () => readProjectRules().catch(() => '')),
    withWorkspaceScope(chatId, () => listRecentWorkspaceActivity({ sinceMs: 24 * 60 * 60 * 1000 }).catch(() => [])),
  ])

  let activityText = ''
  if (Array.isArray(recentActivity) && recentActivity.length > 0) {
    activityText = recentActivity.map(a => `- ${new Date(a.ts).toLocaleTimeString()}: ${a.reason} ${a.path}`).join('\n')
  }

  // 1:1 Arena Parity: Connect MCP Server Discovery.
  // We fetch currently active MCP tools and pass them to the system prompt
  // so the agent knows about connected external services (Slack, Jira, etc).
  let mcpServersBlock = ''
  try {
    const { getMcpServerStatus } = await import('./mcpClient.js')
    const servers = getMcpServerStatus() || []
    if (servers.length > 0) {
      mcpServersBlock = `# Connected MCP Services\n\nYou have access to external tools via Model Context Protocol:\n`
      for (const s of servers) {
        if (!s.tools?.length) continue
        mcpServersBlock += `\n## Service: ${s.name} (${s.status})\n`
        for (const t of s.tools) {
          mcpServersBlock += `- \`mcp__${s.name}__${t.name}\`: ${t.description || ''}\n`
        }
      }
    }
  } catch { /* optional */ }

  return buildAgentSystemPrompt({
    extraSystem,
    native,
    extraTools,
    cwd: '/workspace',
    projectRules,
    recentActivity: activityText,
    mcpServersBlock,
    toolNames,
  })
}


// ── Native tools spec ───────────────────────────────────────────────────────
function buildNativeToolsSpec(extraTools = null, { lite = false, toolNames = null } = {}) {
  let combined = extraTools && typeof extraTools === 'object' ? { ...TOOLS, ...extraTools } : TOOLS
  if (Array.isArray(toolNames) && toolNames.length > 0) {
    const allowed = new Set(toolNames)
    combined = Object.fromEntries(Object.entries(combined).filter(([n]) => allowed.has(n)))
  } else if (lite) {
    // Lite runs advertise only the essential tool subset (same list the lite
    // prompt documents) — the full 58-tool JSON spec alone is ~7.7k tokens.
    combined = Object.fromEntries(Object.entries(combined).filter(([n]) => LITE_TOOL_NAMES.includes(n)))
  }
  return Object.entries(combined).map(([name, def]) => {
    const properties = {}
    const required = []
    for (const [pName, pMeta] of Object.entries(def.params || {})) {
      const schemaType = pMeta.type === 'number' ? 'number'
        : pMeta.type === 'boolean' ? 'boolean'
        : pMeta.type === 'array' ? 'array'
        : pMeta.type === 'object' ? 'object'
        : 'string'
      properties[pName] = { type: schemaType, description: pMeta.description || '' }
      if (schemaType === 'array') properties[pName].items = { type: 'object' }
      if (schemaType === 'object') properties[pName].additionalProperties = true
      if (pMeta.required) required.push(pName)
    }
    return {
      type: 'function',
      function: {
        name,
        description: def.description || '',
        parameters: { type: 'object', properties, required },
      },
    }
  })
}

// ── Utility functions ───────────────────────────────────────────────────────

function callFingerprint(call) {
  if (!call) return ''
  const args = call.args || {}
  let normalised
  try { normalised = JSON.stringify(args, Object.keys(args).sort()) } catch { normalised = '{}' }
  return `${call.tool}::${normalised}`
}

const STUCK_THRESHOLD = 3
function isStuckLoop(recentCalls, currentFingerprint) {
  if (!currentFingerprint) return false
  let consecutive = 0
  for (let i = recentCalls.length - 1; i >= 0; i -= 1) {
    if (recentCalls[i] === currentFingerprint) consecutive += 1
    else break
  }
  if (consecutive + 1 >= STUCK_THRESHOLD) return true

  const recentWindow = recentCalls.slice(-10)
  const totalInWindow = recentWindow.filter((x) => x === currentFingerprint).length
  return totalInWindow + 1 >= STUCK_THRESHOLD
}

function summarizeCallArgsForDigest(args = {}) {
  if (!args || typeof args !== 'object') return ''
  const pick = {}
  for (const k of ['path', 'file_path', 'source_path', 'output_path', 'url', 'query', 'command', 'message']) {
    if (args[k] != null) pick[k] = String(args[k]).slice(0, 160)
  }
  try { return JSON.stringify(pick) } catch { return '' }
}

function incompletePlanSteps(agentState = {}) {
  const steps = Array.isArray(agentState.plan?.steps) ? agentState.plan.steps : []
  if (!steps.length) return []
  const done = new Set([...(agentState.plan?.done || [])].map(Number))
  return steps.filter((s) => !(s.done || done.has(Number(s.idx))))
}

function parseDigestArgs(s = '') {
  try { return JSON.parse(String(s || '{}')) } catch { return {} }
}

function isCodeLikePath(path = '') {
  return /\.(js|mjs|cjs|jsx|ts|tsx|json|css|html|yml|yaml)$/i.test(String(path || ''))
}

function needsVerificationSinceLastEdit(recentToolHistory = []) {
  let lastEdit = -1
  for (let i = 0; i < recentToolHistory.length; i += 1) {
    const h = recentToolHistory[i]
    if (!h?.ok || !['write_file', 'edit_file'].includes(h.tool)) continue
    const args = parseDigestArgs(h.args)
    const p = args.path || args.file_path || ''
    if (isCodeLikePath(p)) lastEdit = i
  }
  if (lastEdit < 0) return false
  return !recentToolHistory.slice(lastEdit + 1).some((h) => h?.ok && ['verify_code', 'npm_test'].includes(h.tool))
}

function commandLooksLikeHealthCheck(argsText = '') {
  return /(curl|wget|http|health|docker logs|docker ps|compose ps|journalctl|logs)/i.test(String(argsText || ''))
}

function unmetDoneCriteria(taskType = '', recentToolHistory = []) {
  const okTools = recentToolHistory.filter((h) => h?.ok).map((h) => h.tool)
  const has = (...tools) => tools.some((t) => okTools.includes(t))
  if (taskType === 'repo_analysis') {
    if (!has('list_files')) return 'Нужно сначала посмотреть дерево проекта через list_files.'
    if (!has('read_file', 'search_files')) return 'Нужно прочитать/поискать реальные файлы проекта перед анализом.'
  }
  if (taskType === 'research') {
    if (!has('web_search', 'web_fetch')) return 'Нужно использовать web_search/web_fetch для research-задачи.'
  }
  if (taskType === 'browser_task') {
    if (has('browser_open') && !has('browser_screenshot')) return 'После открытия страницы нужен browser_screenshot/визуальная проверка.'
  }
  if (taskType === 'deploy_ops') {
    const changedDeploy = recentToolHistory.some((h) => h?.ok && ['ops_run_action', 'git_commit'].includes(h.tool))
      || recentToolHistory.some((h) => h?.ok && h.tool === 'bash' && /(deploy|docker compose up|restart|systemctl|git pull|git reset)/i.test(String(h.args || '')))
    if (changedDeploy) {
      const checked = recentToolHistory.some((h) => h?.ok && ['docker_logs', 'docker_ps', 'ops_list_services'].includes(h.tool))
        || recentToolHistory.some((h) => h?.ok && h.tool === 'bash' && commandLooksLikeHealthCheck(h.args))
      if (!checked) return 'После deploy/restart/git изменения нужен health/log check (curl/docker logs/docker ps).'
    }
  }
  return ''
}

function summarizeToolOutcome(tool, r) {
  if (!r?.ok) return String(r?.error || 'failed').slice(0, 180)
  const result = r.result
  if (tool === 'read_file') return `${result?.content?.length || 0} chars`
  if (tool === 'write_file') return `${result?.bytes || 0} bytes written`
  if (tool === 'edit_file') return `replaced=${result?.replaced ?? 1}`
  if (tool === 'verify_code') return result?.valid === false ? 'invalid' : 'valid/skipped'
  if (tool === 'npm_test') return result?.passed ? 'passed' : `exit=${result?.exitCode ?? '?'}`
  if (tool === 'git_clone') return `path=${result?.path || ''}`
  if (tool === 'zip_files') return `path=${result?.file_path || ''} entries=${result?.entries || 0}`
  if (tool === 'bash') return `exit=${result?.exitCode ?? '?'}`
  return String(result?.message || result?.path || result?.file_path || 'ok').slice(0, 180)
}

function makeReadBackForEdits(calls) {
  const out = []
  const seen = new Set()
  for (const call of calls || []) {
    if (call.tool !== 'edit_file' && call.tool !== 'write_file') continue
    const p = call.args?.path
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push({ tool: 'read_file', args: { path: p }, _readBack: true })
  }
  return out
}

function violatesPreDeployVerify(call, recentToolHistory) {
  if (call.tool !== 'git_commit') return false
  let sawOk = false
  for (let i = recentToolHistory.length - 1; i >= Math.max(0, recentToolHistory.length - 10); i -= 1) {
    const h = recentToolHistory[i]
    if (h?.tool === 'verify_code') {
      if (h.ok) sawOk = true
      else return true
      break
    }
  }
  return !sawOk
}

function dedupePlanCheck(call, planState) {
  if (call.tool !== 'plan_check') return call
  let indices
  try {
    indices = Array.isArray(call.args?.indices) ? call.args.indices : JSON.parse(String(call.args?.indices || '[]'))
  } catch { return call }
  const unique = [...new Set(indices.map(Number).filter((n) => Number.isInteger(n)))]
  const fresh = unique.filter((n) => !planState.done.has(n))
  return { ...call, args: { ...call.args, indices: fresh } }
}

const XML_TOOL_CALL_RE = /<(?:x?ai:function_call|tool_use|function_call)([^>]*)>([\s\S]*?)<\/(?:x?ai:function_call|tool_use|function_call)>/gi
const XML_PARAM_RE = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi

function parseXmlFunctionCalls(text) {
  const calls = []
  XML_TOOL_CALL_RE.lastIndex = 0
  let match
  while ((match = XML_TOOL_CALL_RE.exec(text)) !== null) {
    const openAttrs = match[1] || ''
    const content = match[2] || ''
    const nameMatch =
      content.match(/<(?:x?ai:)?tool_name>([^<]+)<\/(?:x?ai:)?tool_name>/i) ||
      content.match(/<tool_name>([^<]+)<\/tool_name>/i) ||
      content.match(/<name>([^<]+)<\/name>/i) ||
      openAttrs.match(/name\s*=\s*["']([^"']+)["']/i)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    const args = {}
    XML_PARAM_RE.lastIndex = 0
    let paramMatch
    while ((paramMatch = XML_PARAM_RE.exec(content)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim()
    }
    const invokeJsonMatch = content.match(/<invoke[^>]*>([\s\S]*?)<\/invoke>/i)
    if (invokeJsonMatch) {
      try { Object.assign(args, JSON.parse(invokeJsonMatch[1].trim())) } catch { /* best-effort: ignore */ }
    }
    calls.push({ tool: name, args })
  }
  return calls
}

function looksLikeUnapplliedCodeReply(text = '', history = []) {
  const reply = String(text || '')
  if (!/```[a-z0-9_+-]*\n[\s\S]{120,}?\n```/i.test(reply)) return false
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  const askText = String(lastUser?.content || '')
  return /(созда|напиши|сделай|реализуй|исправ|поправ|почини|refactor|fix|create|new)/i.test(askText)
}

// ── SSE helpers ─────────────────────────────────────────────────────────────
function normaliseSsePayload(res, event, data) {
  const seq = (res.__browseraiAgentSseSeq = Number(res.__browseraiAgentSseSeq || 0) + 1)
  const timestamp = new Date().toISOString()
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data }
  return { schema: 'browserai.agent_stream_event.v1', event, seq, timestamp, ...payload, payload }
}

function sse(res, event, data) {
  try {
    const now = Date.now()
    res.__browseraiLastEventAt = now
    if (!data?.watchdog) res.__browseraiLastRealEventAt = now
    res.write(`event: ${event}\ndata: ${JSON.stringify(normaliseSsePayload(res, event, data))}\n\n`)
  } catch { /* best-effort: ignore */ }
}

function sseKeepAlive(res) {
  try { res.write(': keep-alive\n\n') } catch { /* best-effort: ignore */ }
}

// ── Reflection ──────────────────────────────────────────────────────────────
async function runReflectionCheck({ provider, ask, draft, toolHistory }) {
  const toolSummary = (toolHistory || []).slice(-12).map((h) => `${h.ok ? '✓' : '✗'} ${h.tool}`).join(', ')
  const prompt = `Review if the task is done.\nGoal: ${ask}\nTools: ${toolSummary}\nDraft: ${draft}\nReply DONE or TODO: reason.`
  
  // Use a slightly lower temperature for consistent critique
  const reply = await callLLM({
    baseUrl: provider.baseUrl, apiKey: provider.apiKey,
    authType: provider.authType || 'bearer',
    authHeader: provider.authHeader || '',
    extraHeaders: provider.extraHeaders || {},
    model: provider.model,
    messages: [
      { role: 'system', content: 'You are a critical reviewer. Reply DONE if the goal is fully met and verified. Otherwise reply TODO: <reason>.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1,
  })
  
  const text = String(reply?.text || '').trim()
  const todo = text.match(/^\s*todo\s*[:\-—]?\s*(.+)$/i)
  return { needsMoreWork: !!todo, reason: todo ? todo[1].trim() : '', usage: reply.usage }
}

async function streamFinalAnswer(res, fullText) {
  const text = String(fullText || '')
  if (!text) { sse(res, 'assistant', { text: '' }); return }
  
  // #37 FIX: Clean up thinking leakage in final answer.
  // Generic fix for any first word: we remove common English meta-preambles
  // but stop exactly before the first character of real content (Russian letters,
  // digits, quotes, markdown markers, or emojis) using a non-consuming lookahead.
  const cleaned = text
    .replace(/^(?:to respond with|according to|the user just said|thus output|i should state|i will now|in summary)[\s\S]*?(?=[\n\p{Script=Cyrillic}"'«#\-\d*]|✅|❌|⚠️|$)/ui, '')
    .trim()

  const parts = cleaned.match(/.{1,32}/g) || [cleaned]
  for (const chunk of parts) {
    sse(res, 'assistant_delta', { chunk })
    await new Promise((r) => setTimeout(r, 10))
  }
  sse(res, 'assistant', { text: cleaned })
}

// ── LLM Streaming call ──────────────────────────────────────────────────────
async function streamingLLMCall(res, step, opts, hooks = {}) {
  const OPEN_RE  = /<(?:x?ai:function_call|tool_use|function_call|thinking|thought)([^>]*)>/i
  const CLOSE_RE = /<\/(?:x?ai:function_call|tool_use|function_call|thinking|thought)>/i
  let scanBuf = '', visibleTextBuf = '', insideXml = false, xmlTagName = '', xmlOpenAttrs = ''
  const preParsedCalls = []
  const nativePreviewed = new Set()

  function safeJson(text) { try { return JSON.parse(text) } catch { return {} } }

  function parseXmlBody(body, tagName, openAttrs) {
    if (tagName === 'thinking' || tagName === 'thought') return { kind: 'thinking', text: body.trim() }
    const nameMatch = body.match(/<(?:x?ai:)?tool_name>([^<]+)<\/(?:x?ai:)?tool_name>/i) || body.match(/<name>([^<]+)<\/name>/i)
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
    if (preParsedCalls.length > 0 || insideXml) sse(res, 'thought', { step, text: visibleTextBuf })
    else sse(res, 'assistant_delta', { step, chunk: visibleTextBuf })
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
            scanBuf = scanBuf.slice(lastLt); return
          } else {
            visibleTextBuf += scanBuf; flushVisibleText(); scanBuf = ''; return
          }
        }
        const before = scanBuf.slice(0, m.index)
        if (before) { visibleTextBuf += before; flushVisibleText() }
        xmlTagName = m[0].replace(/[<>]/g, '').split(' ')[0]
        xmlOpenAttrs = m[1] || ''
        insideXml = true; scanBuf = scanBuf.slice(m.index + m[0].length)
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
      if (meta?.kind === 'thinking') sse(res, 'thinking_delta', { step, chunk: String(chunk || '') })
      else consumeChunk(String(chunk || ''))
    },
    onToolCallDelta: (tc = {}) => {
      const idx = Number.isInteger(tc.idx) ? tc.idx : 0
      const name = String(tc.name || '').trim()
      if (!name) return
      const key = `${idx}:${name}`
      if (nativePreviewed.has(key)) return
      nativePreviewed.add(key)
      sse(res, 'tool_preview', { step, sub: idx, name, args: safeJson(tc.argsBuf || '{}') })
    },
    onUsage: (u) => hooks.onUsage?.(u),
  })
  if (scanBuf) { visibleTextBuf += scanBuf; scanBuf = '' }
  if (visibleTextBuf) flushVisibleText()
  return { ...result, preParsedCalls }
}

// ── Lightweight server-side router paths ────────────────────────────────────
async function runLightweightChat({ res, provider, history, userId, chatId, mode = 'chat' }) {
  const tokens = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 }
  const lastUser = String([...history].reverse().find((m) => m.role === 'user')?.content || '')
  let webContext = ''

  if (mode === 'web' && lastUser) {
    sse(res, 'tool_start', { step: 0, sub: 0, name: 'web_search', args: { query: lastUser, depth: '1' } })
    const results = await searchWeb(lastUser, 5).catch(() => [])
    sse(res, 'tool_result', { step: 0, sub: 0, name: 'web_search', ok: true, result: { results: results.slice(0, 5) } })

    const pages = []
    for (const r of results.slice(0, 2)) {
      if (!r?.url) continue
      try {
        const page = await Promise.race([
          fetchWebPage(r.url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('fetch timeout')), 6000)),
        ])
        pages.push({ title: r.title, url: r.url, snippet: r.snippet || '', content: String(page?.content || '').slice(0, 1800) })
      } catch {
        pages.push({ title: r.title, url: r.url, snippet: r.snippet || '', content: '' })
      }
    }

    webContext = pages.map((p, i) => [
      `[${i + 1}] ${p.title || p.url}`,
      p.url,
      p.snippet ? `Snippet: ${p.snippet}` : '',
      p.content ? `Content: ${p.content}` : '',
    ].filter(Boolean).join('\n')).join('\n\n---\n\n')
  }

  const messages = [
    {
      role: 'system',
      content: [
        'Ты BrowserAI. Отвечай по-русски, кратко и полезно.',
        mode === 'web' ? 'Используй приложенный web-контекст для актуальных фактов. Если используешь web-факт, укажи источник ссылкой.' : '',
        webContext ? `WEB_CONTEXT:\n${webContext}` : '',
      ].filter(Boolean).join('\n\n'),
    },
    ...history.slice(-8),
  ]

  const reply = await callLLM({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authType: provider.authType || 'bearer',
    authHeader: provider.authHeader || '',
    extraHeaders: provider.extraHeaders || {},
    model: provider.model,
    messages,
    temperature: Number(provider.temperature ?? 0.5),
  })

  if (reply?.usage) {
    tokens.prompt += Number(reply.usage.prompt || 0)
    tokens.completion += Number(reply.usage.completion || 0)
    tokens.total += Number(reply.usage.total || (tokens.prompt + tokens.completion) || 0)
    tokens.reasoningTokens += Number(reply.usage.reasoningTokens || 0)
    tokens.llmCalls += 1
    try { recordSpend({ userId, chatId, model: provider.model, usage: reply.usage }) } catch { /* ignore */ }
    sse(res, 'usage', { step: 0, ...reply.usage, totals: { ...tokens } })
  }

  await streamFinalAnswer(res, reply?.text || '')
  sseDone(res, { steps: 0, reason: mode === 'web' ? 'server-web-route' : 'server-chat-route' }, tokens)
  res.end()
}


async function runDeterministicAction({ action, res, userId, chatId }) {
  const tokens = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 }
  sse(res, 'agent_context', { deterministicAction: { id: action.id, tool: action.tool, reason: action.reason }, task: { type: action.id, complexity: 'low' } })
  // Deterministic actions are intentionally compact: no visible tool_start card,
  // no LLM thinking. We still emit tool_result so the workspace panel refreshes.
  const r = await invokeTool(action.tool, action.args || {}, { userId, chatId })
  sse(res, 'tool_result', { step: 0, sub: 0, name: action.tool, ok: !!r.ok, result: r.result, error: r.error, structured: normalizeToolResult(action.tool, r, { step: 0, sub: 0 }), compact: true })
  const text = r.ok ? action.successText?.(r) : action.errorText?.(r)
  await streamFinalAnswer(res, text || (r.ok ? '✅ Готово.' : `❌ Ошибка: ${r.error || 'unknown error'}`))
  sseDone(res, { steps: 0, reason: r.ok ? (action.successReason || `${action.id}-done`) : (action.errorReason || `${action.id}-error`) }, tokens)
  res.end()
}

// ── Error recovery helpers ──────────────────────────────────────────────────
function getRecoveryHint(tool, error, args = {}) {
  const err = String(error || '').toLowerCase()
  const path = args.path || args.file || args.file_path
  
  if (err.includes('not found') || err.includes('enoent') || err.includes('no such file')) {
    if (path) {
      const parts = path.split('/').filter(Boolean)
      const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : '/'
      return `File "${path}" not found. 
ACTION: Call list_files(path="${parent}") to verify the exact filename and casing. Remember: Linux is CASE-SENSITIVE.`
    }
    return 'Resource not found. Verify the path using list_files.'
  }
  
  if (err.includes('path traversal') || err.includes('policy')) {
    return 'Security policy blocked this path. Stay inside /workspace and do not use ../ or absolute paths.'
  }
  
  if (tool === 'edit_file' && (err.includes('old_text not found') || err.includes('not found in'))) {
    return `The block of code you tried to replace was not found EXACTLY as written. 
ACTION: 
1. Call read_file(path="${path}") to get the LATEST version of the code. 
2. Ensure your old_text matches the indentation and whitespace 100%.`
  }
  
  return null
}

// ── Agent Loop ──────────────────────────────────────────────────────────────
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

  if (chatId) {
    const existing = activeRunsByChat.get(chatId)
    if (existing && Date.now() - existing.startedAt < DEFAULT_DEADLINE_MS + 60_000) {
      sse(res, 'error', { message: 'В этом чате уже выполняется запрос. Дождитесь завершения или нажмите Stop.' })
      sseDone(res, { steps: 0, reason: 'duplicate-run-blocked' }, { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 })
      res.end()
      return
    }
    activeRunsByChat.set(chatId, { startedAt: Date.now() })
  }

  const tokens = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 }
  function accumulateUsage(u) {
    if (!u) return
    tokens.prompt += Number(u.prompt || 0); tokens.completion += Number(u.completion || 0); tokens.total += Number(u.total || (u.prompt + u.completion) || 0)
    tokens.reasoningTokens += Number(u.reasoningTokens || 0); tokens.llmCalls += 1
  }

  if (!provider?.baseUrl || !provider?.apiKey) {
    sse(res, 'error', { message: 'Provider not configured' }); sseDone(res, { steps: 0, reason: 'no-provider' }, tokens); res.end(); if (chatId) activeRunsByChat.delete(chatId); return
  }

  const deterministicAction = routeDeterministicAction(history)
  if (deterministicAction) {
    try {
      await runDeterministicAction({ action: deterministicAction, res, userId, chatId })
    } finally {
      if (chatId) activeRunsByChat.delete(chatId)
    }
    return
  }

  let extraTools = null
  try {
    const { loadCustomToolsFor } = await import('./customTools.js')
    const map = loadCustomToolsFor(userId); if (Object.keys(map).length) extraTools = map
  } catch { /* best-effort: ignore */ }

  // Classify FIRST so the system prompt can match the task weight:
  // low-complexity (greeting / single question) gets the lite prompt
  // (~2.5k tokens) instead of the full 16k-token engineering prompt.
  const agentContext = buildAgentContext({ provider, history, extraSystem, userId, workspaceScope, maxSteps })
  const serverRoute = routeHistory(history, { forceAgent: Boolean(provider.forceAgent) })
  if (provider.baseUrl !== 'mock' && !provider.forceAgent && (serverRoute.mode === 'chat' || serverRoute.mode === 'web')) {
    sse(res, 'agent_context', { ...agentContext, serverRoute })
    try {
      await runLightweightChat({ res, provider, history, userId, chatId, mode: serverRoute.mode })
    } finally {
      if (chatId) activeRunsByChat.delete(chatId)
    }
    return
  }

  const liteRun = agentContext?.task?.complexity === 'low'
  const toolProfile = toolProfileForTask(agentContext?.task)
  const activeToolNames = liteRun ? null : profileToolNames(toolProfile)
  const allowedToolSet = activeToolNames ? new Set(activeToolNames) : null

  let useNativeTools = supportsNativeTools(provider.baseUrl)
  let systemPrompt = await buildSystemPrompt({ extraSystem, native: useNativeTools, extraTools, chatId, lite: liteRun, toolNames: activeToolNames })
  let toolsSpec = useNativeTools ? buildNativeToolsSpec(extraTools, { lite: liteRun, toolNames: activeToolNames }) : undefined

  const convo = [{ role: 'system', content: systemPrompt }, ...history]
  const deadline = Date.now() + DEFAULT_DEADLINE_MS
  let step = 0, aborted = false
  const abortCtl = new AbortController()
  res.on('close', () => { aborted = true; abortCtl.abort('client closed') })

  if (agentContext.runtime.effectiveMaxSteps > maxSteps) maxSteps = agentContext.runtime.effectiveMaxSteps
  const agentState = createAgentState({ agentContext, history })
  res.__browseraiLastRealEventAt = Date.now()
  res.__browseraiLastEventAt = Date.now()
  res.__agentPhase = 'starting'
  res.__agentActiveTool = ''
  let watchdogAborted = false
  let lastWatchdogNoticeAt = 0
  const idleWatchdog = setInterval(() => {
    const lastReal = Number(res.__browseraiLastRealEventAt || Date.now())
    const idleMs = Date.now() - lastReal
    if (idleMs < IDLE_NOTICE_MS) return

    const activeTool = String(res.__agentActiveTool || '')
    const phase = String(res.__agentPhase || 'working')
    const hardLlmTimeout = phase === 'llm' && idleMs > LLM_HARD_IDLE_MS
    if (!hardLlmTimeout && Date.now() - lastWatchdogNoticeAt < IDLE_NOTICE_MS) return
    lastWatchdogNoticeAt = Date.now()

    const currentStep = activeTool
      ? `Всё ещё выполняю инструмент ${activeTool} (${Math.round(idleMs / 1000)}с без вывода)…`
      : `Всё ещё жду ${phase === 'llm' ? 'ответ модели' : 'следующий шаг'} (${Math.round(idleMs / 1000)}с без событий)…`

    sse(res, 'agent_state', {
      ...agentState,
      status: phase === 'tool' ? 'running' : 'thinking',
      currentStep,
      watchdog: true,
    })

    // Hard-stop only a silent LLM call. Do NOT abort tool/bash/deploy work here:
    // long builds can be quiet but still healthy; tool-level timeouts handle them.
    if (phase === 'llm' && idleMs > LLM_HARD_IDLE_MS && !watchdogAborted) {
      watchdogAborted = true
      try { abortCtl.abort(new Error('LLM idle watchdog timeout')) } catch { /* ignore */ }
    }
  }, 15_000)
  idleWatchdog.unref?.()
  res.on('close', () => clearInterval(idleWatchdog))

  const planningDirective = buildPlanningDirective(agentContext)
  const doneCriteriaDirective = buildDoneCriteriaDirective(agentContext)
  
  // v2.26: High-Intelligence Directive for High Complexity tasks.
  // Encourages deeper reasoning and more robust verification.
  if (agentContext?.task?.complexity === 'high') {
    convo.push({ role: 'user', content: `[high_complexity_directive]\nThis is a COMPLEX task. Do not rush. \n1. Explore the codebase thoroughly using read_project_rules, search_files and list_files.\n2. Read all relevant files before making a plan.\n3. Create a detailed plan with plan_set.\n4. Apply changes using edit_file (preferred) or write_file.\n5. MANDATORY: Verify every change with verify_code or npm_test.\n6. If you hit an error, read the file again to check for drift before retrying.\n[/high_complexity_directive]` })
  }

  if (planningDirective) convo.push({ role: 'user', content: planningDirective })
  if (doneCriteriaDirective) convo.push({ role: 'user', content: doneCriteriaDirective })
  
  sse(res, 'agent_context', { ...agentContext, toolProfile, toolNames: activeToolNames }); sse(res, 'agent_state', agentState)
  if (res.flushHeaders) res.flushHeaders()

  // Automatic memory preload disabled: it added noisy, low-value tool cards
  // (recall_facts / kb_search) before every real task and confused simple
  // requests like 'скачай файлы'. Memory tools remain available if the model
  // explicitly needs them.


  // 1:1 Arena Parity: Proactive Discovery.
  // Pre-read lessons learned and repo map BEFORE the first step.
  // Skipped for lite runs: a greeting doesn't need the repo map (~30k
  // tokens of context on big workspaces — the main cost of the old
  // "47k tokens for «привет»" problem).
  if (userId && !aborted && !liteRun) {
    try {
      const lessons = await withWorkspaceScope(chatId, () => readWorkspaceFile('.browserai/lessons.md').catch(() => null))
      if (lessons?.text) convo.push({ role: 'user', content: `<arena-system-message>\nLessons Learned (from .browserai/lessons.md):\n${lessons.text}\n</arena-system-message>` })
    } catch { /* ignore */ }
  }

  const keepAliveInterval = setInterval(() => sseKeepAlive(res), 15_000)
  res.on('close', () => clearInterval(keepAliveInterval))

  const recentCallFingerprints = [], recentToolHistory = [], planState = { done: new Set() }
  // Anti-fabrication bookkeeping: which paths were actually read vs failed.
  // Used before the final answer to catch reports citing files that were
  // never successfully opened (observed: invented *.py files in a JS repo).
  const okReadPaths = new Set(), failedReadPaths = new Set()
  let fabricationPushback = false
  let verificationPushback = false
  let pushedBackThisTurn = false

  try {
    while (step < maxSteps) {

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
      
      // v2.21: Live agent_state streaming — update status to 'thinking'
      // before the LLM call so the UI shows the agent is "processing"
      // instead of just "running" (which implies tool execution).
      agentState.status = 'thinking'
      res.__agentPhase = 'llm'
      res.__agentActiveTool = ''
      agentState.currentStep = `Step ${step}: Thinking...`
      agentState.updatedAt = new Date().toISOString()
      sse(res, 'thinking', { step })
      sse(res, 'agent_state', agentState)

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

      res.__agentPhase = 'agent'
      res.__agentActiveTool = ''

      let spendNote = null
      try { spendNote = recordSpend({ userId, chatId, model: activeProvider.model, usage: reply?.usage || {} }) } catch { /* best-effort: ignore */ }
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
        if (looksLikeUnapplliedCodeReply(reply.text, history) && !aborted && !pushedBackThisTurn) {
          pushedBackThisTurn = true
          sse(res, 'thought', { step, text: 'Code not applied. Requesting fix.' })
          convo.push({ role: 'user', content: 'You provided code without tool calls. Apply changes with write_file/edit_file now.' }); continue
        }
        if (step === 1 && !pushedBackThisTurn && !aborted) {
          pushedBackThisTurn = true
          sse(res, 'thought', { step, text: 'No tools called. Forcing action.' })
          convo.push({ role: 'user', content: 'ACT now by calling a tool.' }); continue
        }

        // Fabrication gate: the draft cites concrete file paths — verify each
        // was actually read OK in this run. A path that only ever FAILED in
        // read_file (ENOENT) appearing in the final answer = invented report.
        if (!fabricationPushback && !aborted && failedReadPaths.size > 0 && (reply.text || '').length > 100) {
          const cited = [...failedReadPaths].filter((p) => {
            const base = p.split('/').pop()
            return base && base.length > 3 && (reply.text || '').includes(base) && !okReadPaths.has(p)
          })
          if (cited.length > 0) {
            fabricationPushback = true
            sse(res, 'thought', { step, text: `Самопроверка: ответ ссылается на файлы, которые НЕ удалось прочитать (${cited.slice(0, 5).join(', ')}). Требую переработку по реальным файлам.` })
            convo.push({ role: 'user', content: `[fabrication_check] Your draft cites files that DO NOT EXIST — every read_file on them failed: ${cited.join(', ')}. You invented their content. Start over: call list_files to see the REAL tree, read_file the REAL files, and rewrite the answer using only verbatim quotes from successful read_file results. Do not mention non-existent files.` })
            continue
          }
        }

        const lastUserAsk = [...history].reverse().find((m) => m.role === 'user')?.content || ''
        const didRealWork = recentToolHistory.some((h) => h.ok && !['ask_user', 'recall_facts', 'plan_check', 'plan_set'].includes(h.tool))
        if (didRealWork && !convo.some(m => m.role === 'user' && String(m.content).startsWith('[reflection]')) && !aborted) {
          // Hard 20s cap: reflection is advisory — a hanging provider call
          // here must never block stream completion (same spinner-hang class).
          const verdict = await Promise.race([
            runReflectionCheck({ provider, ask: lastUserAsk, draft: reply.text || '', toolHistory: recentToolHistory }),
            new Promise((r) => setTimeout(() => r(null), 20_000)),
          ]).catch(() => null)
          if (verdict?.needsMoreWork) {
            sse(res, 'thought', { step, text: `Самопроверка: ${verdict.reason}` })
            convo.push({ role: 'user', content: `[reflection] Gaps identified:\n${verdict.reason}` }); continue
          }
        }
        if (!verificationPushback && needsVerificationSinceLastEdit(recentToolHistory) && !aborted) {
          verificationPushback = true
          sse(res, 'thought', { step, text: 'Самопроверка: после изменения кода не было verify_code/npm_test. Запускаю проверку перед финальным ответом.' })
          convo.push({ role: 'user', content: `[verification_required]\nYou changed code/config files but have not verified them after the last edit. Call verify_code on touched files or npm_test now. Do not final-answer until verification is done or explicitly explain a skipped verifier via tool result.` })
          continue
        }

        const doneCriteriaGap = unmetDoneCriteria(agentContext?.task?.type, recentToolHistory)
        if (doneCriteriaGap && !aborted) {
          sse(res, 'thought', { step, text: `Критерии завершения ещё не выполнены: ${doneCriteriaGap}` })
          convo.push({ role: 'user', content: `[done_criteria_enforcement]\n${doneCriteriaGap}\nContinue with the required tool call(s). Do not final-answer yet.` })
          continue
        }

        const unfinishedPlan = incompletePlanSteps(agentState)
        if (unfinishedPlan.length > 0 && !aborted) {
          sse(res, 'thought', { step, text: `План ещё не закрыт: осталось ${unfinishedPlan.length} шаг(ов). Продолжаю выполнение.` })
          convo.push({ role: 'user', content: `[plan_enforcement]
You created a plan but have not completed it. Remaining steps:
${unfinishedPlan.map((s) => `- ${s.idx}. ${s.text}`).join('\n')}

Continue with tool calls. If a step is actually done, call plan_check for it first. Do not final-answer until all applicable plan steps are checked or explicitly revised with plan_set.` })
          continue
        }

        if (streamedFinalAnswer) sse(res, 'assistant', { text: reply.text || '' })
        else await streamFinalAnswer(res, reply.text || '')

        // CRITICAL ORDER: send 'done' and close the stream FIRST. The
        // lesson-extraction below makes an extra LLM call — if it hangs
        // (slow provider, dead DeepSeek session) while 'done' hasn't been
        // sent, the UI spinner never stops and the Composer silently
        // swallows every next message. Lessons are best-effort background
        // work and must never delay stream completion.
        sseDone(res, { steps: step, reason: 'final' }, tokens); res.end()
        if (didRealWork && !aborted && userId) {
          void (async () => {
            try {
              const learnPrompt = `What technical lesson was learned? Russian, max 1 sentence.`
              const learnReply = await Promise.race([
                callLLM({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, messages: [...convo.slice(-4), { role: 'user', content: learnPrompt }], temperature: 0.1 }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('lesson-extract timeout')), 30_000)),
              ])
              const lesson = String(learnReply?.text || '').trim()
              if (lesson && lesson.length < 200) await invokeTool('remember_fact', { key: `lesson_${Date.now()}`, value: lesson }, { userId, chatId })
            } catch { /* best-effort: ignore */ }
          })()
        }
        return
      }

      // v2.19: the text accompanying a native tool call is the model's
      // reasoning ("I need to read a file.") — emit it as a `thought` so the
      // UI shows why the agent is calling the tool. Native tool-calls don't
      // pass through the XML parser (which already emits `thought` for
      // XML-style calls), so without this the text was silently lost.
      const cameFromNativeToolCalls = useNativeTools && Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0
      if (reply.text && String(reply.text).trim() && cameFromNativeToolCalls) {
        sse(res, 'thought', { step, text: String(reply.text).trim() })
      }

      if (calls.some(c => c.nativeId)) convo.push({ role: 'assistant', content: reply.text || '', tool_calls: calls.filter(c => c.nativeId).map(c => c.nativeRaw) })
      else convo.push({ role: 'assistant', content: reply.text || '' })

      for (let i = 0; i < calls.length; i++) if (calls[i].tool === 'plan_check') calls[i] = dedupePlanCheck(calls[i], planState)
      const readBacks = makeReadBackForEdits(calls)
      for (const rb of readBacks) calls.push(rb)

      // Execute tool calls sequentially, not in parallel. Some models emit
      // write_file + read_file in the same assistant turn; running them with
      // Promise.all lets read_file race ahead of write_file and produces a
      // false "File not found" even though the file is created milliseconds
      // later. Sequential execution also preserves the observation order that
      // OpenAI-compatible providers expect after assistant.tool_calls.
      const results = []
      for (let idx = 0; idx < calls.length; idx++) {
        const call = calls[idx]
        results.push(await (async () => {
        recentCallFingerprints.push(callFingerprint(call)); if (recentCallFingerprints.length > 20) recentCallFingerprints.shift()
        if (violatesPreDeployVerify(call, recentToolHistory)) return { call, r: makeToolErrorResult('Blocked: verify_code required.'), pushedBack: true }
        if (isStuckLoop(recentCallFingerprints, callFingerprint(call))) return { call, r: makeToolErrorResult('Stuck in loop.'), pushedBack: true }

        if (allowedToolSet && !allowedToolSet.has(call.tool) && !(extraTools && extraTools[call.tool])) {
          const rErr = makeToolErrorResult(`Tool ${call.tool} is not available in the current ${toolProfile} tool profile. Use one of: ${[...allowedToolSet].join(', ')}`)
          sse(res, 'tool_router', { step, sub: idx, name: call.tool, warnings: [rErr.error] })
          sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        const validation = validateToolCall(call.tool, call.args || {}, { ...TOOLS, ...extraTools }[call.tool])
        if (!validation.ok) {
          if (!pushedBackThisTurn && !aborted) {
            pushedBackThisTurn = true
            // v2.24: surface schema errors as a visible thought + tool_result so
            // the UI (and tests) see the self-healing push-back explicitly.
            sse(res, 'thought', { step, sub: idx, text: `ОШИБКА СХЕМЫ: ${call.tool} — ${validation.error}. Исправляю вызов инструмента.` })
            const rErr = makeToolErrorResult(`[schema_error] ${validation.error}`)
            sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
            return { call, r: rErr, pushedBack: true }
          }
          return { call, r: makeToolErrorResult(validation.error) }
        }
        call.args = validation.args
        if (call.tool !== 'ask_user' && requiresApproval(call.tool, userId)) {
          const { id: aqId, promise: aqPromise, expiresAt } = registerQuestion({ kind: 'tool_approval', userId, chatId, step, sub: idx, tool: call.tool, category: categoryOf(call.tool), question: `Approve ${call.tool}?`, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }] })
          sse(res, 'tool_approval', { step, sub: idx, question_id: aqId, expiresAt, tool: call.tool, args: call.args })
          let approved = false; try { const ans = await aqPromise; const pick = Array.isArray(ans?.selected) ? String(ans.selected[0]) : String(ans?.text || ans); approved = ['approve', 'yes', 'ok', 'allow', 'true'].includes(pick.toLowerCase().trim()) } catch { /* best-effort: ignore */ }
          if (!approved) return { call, r: { ok: false, error: 'User denied.' } }
        }

        res.__agentPhase = 'tool'
        res.__agentActiveTool = call.tool
        sse(res, 'tool_start', { step, sub: idx, name: call.tool, args: call.args })
        let r
        if (call.tool === 'ask_user') {
          const aArgs = call.args || {}, rawList = Array.isArray(aArgs.questions) ? aArgs.questions : [{ id: 'q1', question: aArgs.question || '?', options: aArgs.options || [], allowCustomResponse: aArgs.allow_custom !== false, multi: aArgs.multi !== false }]
          const answers = await Promise.all(rawList.slice(0, 6).map(q => { const { id, promise, expiresAt } = registerQuestion({ kind: 'ask_user', userId, chatId, step, sub: idx, question: q.question, options: q.options, multi: q.multi, allowCustom: q.allowCustomResponse }); sse(res, 'ask_user', { step, sub: idx, question_id: id, expiresAt, question: q.question, options: q.options }); return promise.then(a => ({ ok: true, answer: a }), e => ({ ok: false, error: e.message })) }))
          r = { ok: true, result: answers.length === 1 ? answers[0].answer : { answers } }
        } else {
          r = await invokeTool(call.tool, { 
            ...call.args, 
            _provider: provider,
            _projectRules: (await withWorkspaceScope(chatId, () => readProjectRules().catch(() => ''))),
            _recentActivity: (await withWorkspaceScope(chatId, () => listRecentWorkspaceActivity({ sinceMs: 24 * 60 * 60 * 1000 }).catch(() => []))).map(a => `${a.reason} ${a.path}`).join(', ')
          }, { 
            signal: abortCtl.signal, 
            onStdout: (c) => sse(res, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stdout', chunk: String(c).slice(0, 2000) }), 
            onStderr: (c) => sse(res, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stderr', chunk: String(c).slice(0, 2000) }), 
            userId, chatId, extraTools 
          })
        }
        if (!r.ok && !pushedBackThisTurn && !aborted && categoryOf(call.tool) !== 'ask') {
          const hint = getRecoveryHint(call.tool, r.error, call.args)
          if (hint) {
            pushedBackThisTurn = true
            sse(res, 'thought', { step, sub: idx, text: `ОШИБКА: ${call.tool} — ${r.error}. Исправляю…` })
            
            // #45 FIX: Absolute Grounding. We inject a loud system message that 
            // the model CANNOT ignore, effectively forcing a "reasoning correction" step.
            const rErr = makeToolErrorResult(`[exec_error] ${r.error}.\n\nREQUIRED ACTION TO RECOVER:\n${hint}\n\nExecute this action now.`)
            sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
            return { call, r: rErr, pushedBack: true }
          }
          
          pushedBackThisTurn = true
          // v2.24: surface execution errors as a visible thought + tool_result
          // (self-healing): the agent acknowledges the failure and retries.
          sse(res, 'thought', { step, sub: idx, text: `Ошибка выполнения: ${call.tool} — ${r.error}. Пробую восстановиться.` })
          const rErr = makeToolErrorResult(`[exec_error] ${r.error}`)
          sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }
        updateAgentStateFromTool(agentState, call.tool, r, call.args); sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: !!r.ok, result: r.result, error: r.error, structured: normalizeToolResult(call.tool, r, { step, sub: idx }) }); sse(res, 'agent_state', agentState)
        res.__agentPhase = 'agent'
        res.__agentActiveTool = ''
        return { call, r }
        })())
      }

      let sawPushBack = false
      for (const res of results) { if (res?.pushedBack) sawPushBack = true; if (res?.call && res?.r) { recentToolHistory.push({ tool: res.call.tool, ok: !!res.r.ok, at: Date.now(), args: summarizeCallArgsForDigest(res.call.args || {}), outcome: summarizeToolOutcome(res.call.tool, res.r) }); if (res.call.tool === 'read_file' && res.call.args?.path) { (res.r.ok ? okReadPaths : failedReadPaths).add(String(res.call.args.path)) } if (res.call.tool === 'plan_set' && res.r.ok) planState.done = new Set(); else if (res.call.tool === 'plan_check' && res.r.ok) (res.r.result?.checked || []).forEach(idx => planState.done.add(Number(idx))) } }
      if (sawPushBack) continue

      for (const { call, r } of results) {
        let obsRaw = r.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) : 'ERROR: ' + r.error
        let obsContent = clipToolOutput(call.tool, obsRaw, provider?.model)
        if (r.ok && r.result?.dataUrl && useNativeTools) obsContent = [{ type: 'text', text: clipToolOutput(call.tool, { ...obsRaw, dataUrl: undefined }, provider?.model) }, { type: 'image_url', image_url: { url: r.result.dataUrl } }]
        if (call.nativeId) convo.push({ role: 'tool', tool_call_id: call.nativeId, name: call.tool, content: obsContent })
        else convo.push({ role: 'user', content: `<arena-system-message>\nTool result for ${call.tool}:\nok: ${r.ok}\n</arena-system-message>\n${obsContent}` })
      }
    }
    if (step >= maxSteps) { sse(res, 'error', { message: `Stopped after ${maxSteps} steps` }); sseDone(res, { steps: step, reason: 'max-steps' }, tokens) }
  } catch (e) { sse(res, 'error', { message: e.message }); sseDone(res, { steps: step, reason: 'crash' }, tokens) } finally { clearInterval(idleWatchdog); if (chatId) activeRunsByChat.delete(chatId); try { res.end() } catch { /* best-effort: ignore */ } }
}

function sseDone(res, payload, tokens) { sse(res, 'done', { ...payload, tokens }) }
