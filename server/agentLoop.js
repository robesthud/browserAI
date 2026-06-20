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
import { isDeepSeekWebUrl } from './deepseekWeb.js'
import {
  withWorkspaceScope, readWorkspaceFile, readProjectRules, listRecentWorkspaceActivity, getContainerWorkspaceRoot, ensureWorkspaceRoot,
} from './workspace.js'
import {
  callLLM, callLLMStream, supportsNativeTools, supportsStreaming, normalizeProviderError,
} from './llmClient.js'
import { registerQuestion } from './askUserRegistry.js'
import { searchWeb, fetchWebPage } from './web.js'
import { routeHistory, classifyIntentAI } from './smartRouter.js'
import { routeDeterministicAction } from './deterministicActionRouter.js'
import { toolProfileForTask, profileToolNames, isToolAllowed } from './toolAllowlist.js'
import { expandConsolidatedCall, isConsolidatedTool } from './toolConsolidation.js'
import { getRecoveryAction, getRecoveryHint as recoveryHint } from './recoveryEngine.js'
import { buildToolStrategyDirective } from './failurePlaybooks.js'
import { createWorkspaceSnapshot } from './workspaceSnapshots.js'
import { deriveTaskPhase, allowedToolsForPhase, createRetryBudget, recordToolCall, guardToolCall, detectStuck, shouldEscalate, buildEscalationPrompt, nextPhase, PHASES } from './taskStateMachine.js'
import { createAgentTask, updateAgentTask, finishAgentTask } from './agentTasks.js'
import {
  clipToolOutput, manageContext, applyAnthropicCacheHints,
  upsertAgentStateDigest,
} from './contextManager.js'
import { safeErrorMessage, safeProviderError } from './errorSanitizer.js'
import log from './logger.js'
import {
  historyArgs,
  historyAction,
  historyPath,
  isFileToolAction,
  isVerificationHistoryEntry,
  needsVerificationSinceLastEdit,
  commandLooksLikeHealthCheck,
  toolCommand,
  commandMatches,
  askedForExplicitLocalTest,
  hasLocalTestAttempt,
  hasSuccessfulLocalTest,
  hasStrongLocalTestSuccessClaim,
  hasUnsupportedEnvironmentClaim,
  unmetDoneCriteria,
  obligationCompletionStatus,
  runtimeSemantics,
  normalizeRuntimeHistoryEntry,
} from './agentRuntimeSemantics.js'
import { buildFinalStatus, isBlocked } from './agentFinalStatus.js'
import { createRunLog as _createRunLog, newRunId as _newRunId } from './runLogs.js'
import { buildReplayArtifact as _buildReplayArtifact, saveReplay as _saveReplay } from './replayArtifact.js'
import { classifyError as _classifyError } from './errorTaxonomy.js'
import {
  normalizeRuntimeCall,
  narrateRuntimeCall,
  shouldReadBackCall,
  violatesPreDeployVerifyCall,
} from './runtimeCallSemantics.js'
import { toolSucceeded, summarizeToolOutcome } from './runtimeToolResultSemantics.js'
import { buildAgentSystemPrompt } from './agentPrompt.js'
import { recordSpend, checkCap } from './costTracker.js'
import { shouldUseCheapEditor, wrapProviderForEditor, routingLabel } from './architectEditor.js'
import { requiresApproval, categoryOf } from './approvalGate.js'
import {
  buildAgentContext, normalizeToolResult, createAgentState,
  buildPlanningDirective, buildAutonomousRuntimeDirective, buildGuidedRailsDirective, buildDoneCriteriaDirective, updateAgentStateFromTool,
  validateToolCall, makeToolErrorResult,
} from './agentCore.js'

// Все таймауты читаются из env, чтобы можно было настроить без пересборки.
// BROWSERAI_MAX_STEPS       — лимит шагов агента (default: 15)
// BROWSERAI_DEADLINE_MS     — общий дедлайн run в мс (default: 20 мин)
// BROWSERAI_IDLE_NOTICE_MS  — через сколько мс без события показывать watchdog-статус (default: 75с)
// BROWSERAI_LLM_IDLE_MS     — через сколько мс молчания LLM считается зависшим (default: 120с)
const DEFAULT_MAX_STEPS   = Number(process.env.BROWSERAI_MAX_STEPS)    || 15
const DEFAULT_DEADLINE_MS = Number(process.env.BROWSERAI_DEADLINE_MS)  || 20 * 60 * 1000
const IDLE_NOTICE_MS      = Number(process.env.BROWSERAI_IDLE_NOTICE_MS) || 75 * 1000
const LLM_HARD_IDLE_MS    = Number(process.env.BROWSERAI_LLM_IDLE_MS)  || 2 * 60 * 1000
const activeRunsByChat = new Map()

export function listActiveAgentRuns() {
  return [...activeRunsByChat.entries()].map(([chatId, v]) => ({ chatId, startedAt: v.startedAt, ageMs: Date.now() - Number(v.startedAt || Date.now()) }))
}

export function clearActiveAgentRun(chatId = '') {
  return activeRunsByChat.delete(String(chatId || ''))
}

// Статические алиасы — модель иногда использует нестандартные имена.
// При добавлении нового инструмента в TOOLS его каноническое имя
// подхватывается автоматически через normalizeToRegisteredName ниже.
const TOOL_NAME_ALIASES = {
  'search_web':    'web_search',
  'google_search': 'web_search',
  'google':        'web_search',
  'web_grep':      'web_search',
  'fetch_page':    'web_fetch',
  'web_fetch_page':'web_fetch',
  'download_url':  'web_fetch',
  'read_url':      'web_fetch',
  'grep':          'search_files',
  'find_in_files': 'search_files',
  'grep_files':    'search_files',
  'search_file':   'search_files',
  'replace_text':  'edit_file',
  'modify_file':   'edit_file',
  'change_file':   'edit_file',
  'patch_file':    'edit_file',
  'show_files':    'list_files',
  'list_folder':   'list_files',
  'dir':           'list_files',
  'run_command':   'bash',
  'execute':       'bash',
  'terminal':      'bash',
}

// normalizeToRegisteredName: если lower-case нормализованное имя точно совпадает
// с зарегистрированным в TOOLS — возвращаем каноническое (case-safe) имя.
// Это исключает дрейф при добавлении новых инструментов в реестр.
let _toolNamesLower = null
function getToolNamesLower() {
  if (!_toolNamesLower) {
    _toolNamesLower = new Map(Object.keys(TOOLS).map(n => [n.toLowerCase(), n]))
  }
  return _toolNamesLower
}

function correctToolName(name) {
  const lower = String(name || '').toLowerCase().trim().replace(/[-_]+/g, '_')
  // 1. Статический алиас
  if (TOOL_NAME_ALIASES[lower]) return TOOL_NAME_ALIASES[lower]
  // 2. Точное совпадение с зарегистрированным именем (case-insensitive)
  const registered = getToolNamesLower().get(lower)
  if (registered) return registered
  // 3. Возвращаем как есть — unknown-проверка позже поймает его
  return name
}

// ── System prompt builder ───────────────────────────────────────────────────
// Кэш repoMap: строится один раз для chat-сессии, переиспользуется на каждом шаге
// вместо повторного сканирования (экономия ~30к токенов × N шагов на больших проектах).
// LRU-ограничение: максимум REPO_MAP_CACHE_MAX записей.
// При превышении удаляется самая старая запись (порядок вставки в Map).
const REPO_MAP_CACHE_MAX = 50
const repoMapCache = new Map()

function repoMapCacheSet(chatId, value) {
  if (repoMapCache.has(chatId)) repoMapCache.delete(chatId) // обновляем порядок
  repoMapCache.set(chatId, value)
  if (repoMapCache.size > REPO_MAP_CACHE_MAX) {
    // удаляем первый (самый старый) ключ
    repoMapCache.delete(repoMapCache.keys().next().value)
  }
}

async function buildSystemPrompt({ extraSystem = '', native = false, extraTools = null, chatId = '', lite = false, toolNames = null } = {}) {
  const containerRoot = getContainerWorkspaceRoot()
  const envContext = `# Environment Context
- Current Working Directory (CWD): ${containerRoot}
- All tool paths are relative to this root.
- If you clone a repo, it will be in ${containerRoot}/<repo-name>.
- Use 'ls -R' via bash if you are unsure where files are.
- DO NOT invent paths. Use 'list_files' to see what exists.
`

  // Lite profile: skip workspace scans and MCP discovery entirely
  if (lite) {
    return buildAgentSystemPrompt({ extraSystem: envContext + '\n' + extraSystem, native, extraTools, cwd: containerRoot, lite: true, toolNames })
  }

  const [projectRules, recentActivity] = await Promise.all([
    withWorkspaceScope(chatId, () => readProjectRules().catch(() => '')),
    withWorkspaceScope(chatId, () => listRecentWorkspaceActivity({ sinceMs: 24 * 60 * 60 * 1000 }).catch(() => [])),
  ])

  // repoMap: берём из кэша для этого chatId, строим только один раз.
  let repoMap = ''
  if (repoMapCache.has(chatId)) {
    repoMap = repoMapCache.get(chatId)
  } else {
    repoMap = await withWorkspaceScope(chatId, () => import('./repoMap.js').then(m => m.buildRepoMap()).catch(() => ''))
    repoMapCacheSet(chatId, repoMap)
  }

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

  const finalPrompt = buildAgentSystemPrompt({
    extraSystem: envContext + '\n' + extraSystem,
    native,
    extraTools,
    cwd: containerRoot,
    projectRules,
    recentActivity: activityText,
    mcpServersBlock,
    toolNames,
    repoMap,
  })
  return finalPrompt
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

// STUCK_THRESHOLD = 4: два одинаковых read_file подряд — нормальная ситуация
// (агент перечитывает файл после правки). Три подряд — уже признак петли.
// Четыре — надёжный сигнал для прерывания без ложных срабатываний.
const STUCK_THRESHOLD = 4
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
  for (const k of ['action', 'path', 'file_path', 'source_path', 'output_path', 'url', 'query', 'command', 'message', 'service', 'task_id']) {
    if (args[k] != null) pick[k] = String(args[k]).slice(0, 160)
  }
  if (Array.isArray(args.indices)) pick.indices = args.indices.slice(0, 10)
  try { return JSON.stringify(pick) } catch { return '' }
}

function incompletePlanSteps(agentState = {}) {
  const steps = Array.isArray(agentState.plan?.steps) ? agentState.plan.steps : []
  if (!steps.length) return []
  const done = new Set([...(agentState.plan?.done || [])].map(Number))
  return steps.filter((s) => !(s.done || done.has(Number(s.idx))))
}

function unmetGoalObligation(agentContext = {}, recentToolHistory = []) {
  const obligations = agentContext?.task?.obligations || {}
  const status = obligationCompletionStatus(obligations, recentToolHistory)
  const order = ['inspect', 'codeChange', 'verify', 'commit', 'push', 'pr', 'deploy', 'healthCheck', 'logsCheck']
  const labels = {
    inspect: 'нужно осмотреть проект/контекст реальными tools или bash перед финальным ответом',
    codeChange: 'пользователь просил изменение кода/фичу/фикс, но не видно успешной правки файла',
    verify: 'нужна проверка результата через verify/npm test/build/bash',
    commit: 'пользователь просил commit, но commit ещё не выполнен',
    push: 'пользователь просил push/GitHub, но push ещё не подтверждён',
    pr: 'пользователь просил PR, но PR ещё не создан или не подтверждён',
    deploy: 'пользователь просил deploy/production, но deploy ещё не выполнен или не подтверждён',
    healthCheck: 'после deploy/ops нужен health check',
    logsCheck: 'после deploy/ops нужна проверка логов/Docker status',
  }
  for (const key of order) {
    if (obligations[key] && !status[key]) return { key, message: labels[key], status, obligations }
  }
  return null
}

function buildRuntimeEvidenceReport(agentContext = {}, recentToolHistory = [], agentState = {}) {
  const real = (recentToolHistory || []).filter((h) => !['plan_set', 'plan_check', 'recall_facts', 'remember_fact', 'kb_search'].includes(h.tool))
  if (!real.length) return ''
  const obligations = agentContext?.task?.obligations || {}
  const status = obligationCompletionStatus(obligations, recentToolHistory)
  const changedFiles = []
  const readFiles = []
  const commands = []
  const checks = []
  const git = []
  const deploy = []
  const errors = []
  for (const h of real) {
    const semantic = runtimeSemantics(h)
    const args = semantic.args || historyArgs(h)
    const p = semantic.path || historyPath(h)
    if (h.ok && (semantic.isWrite || semantic.isEdit) && p && !changedFiles.includes(p)) changedFiles.push(p)
    if (h.ok && semantic.isRead && p && !readFiles.includes(p)) readFiles.push(p)
    if (semantic.family === 'shell') commands.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${semantic.command || args.command || ''} → ${h.outcome || ''}`.slice(0, 500))
    if (semantic.isVerify || /test|build|verify|exit=0|passed/i.test(String(h.outcome || ''))) checks.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || ''}`)
    if (semantic.family === 'git' || /git\s+(status|diff|commit|push)/i.test(semantic.command || args.command || '')) git.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || semantic.command || args.command || ''}`)
    if (semantic.family === 'ops' || semantic.family === 'docker' || semantic.isDeploy || semantic.isHealthCheck || semantic.isLogsCheck) deploy.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || semantic.command || args.command || ''}`)
    if (!h.ok) errors.push(`✗ ${h.tool}: ${h.outcome || 'failed'}`)
  }
  const missing = Object.entries(obligations).filter(([k, v]) => v && k !== 'finalReport' && !status[k]).map(([k]) => k)
  const lines = ['\n\n---', '### Runtime evidence']
  if (changedFiles.length) lines.push('**Изменённые файлы:**', ...changedFiles.slice(0, 20).map((f) => `- ${f}`))
  if (!changedFiles.length && readFiles.length) lines.push('**Прочитанные файлы:**', ...readFiles.slice(0, 10).map((f) => `- ${f}`))
  if (commands.length) lines.push('**Команды:**', ...commands.slice(-12).map((c) => `- ${c}`))
  if (checks.length) lines.push('**Проверки:**', ...checks.slice(-8).map((c) => `- ${c}`))
  if (git.length) lines.push('**Git:**', ...git.slice(-8).map((c) => `- ${c}`))
  if (deploy.length) lines.push('**Deploy/ops/health/logs:**', ...deploy.slice(-10).map((c) => `- ${c}`))
  if (errors.length) lines.push('**Ошибки/восстановление:**', ...errors.slice(-8).map((e) => `- ${e}`))
  if (Object.keys(obligations).some((k) => obligations[k])) {
    lines.push('**Статус обязательств:**')
    for (const [k, v] of Object.entries(obligations)) if (v && k !== 'finalReport') lines.push(`- ${status[k] ? '✓' : '⚠'} ${k}`)
  }
  if (missing.length) lines.push(`**Незакрытые обязательства:** ${missing.join(', ')} — см. blockers/ограничения выше.`)
  agentState.obligationStatus = status
  return lines.join('\n')
}

function appendRuntimeEvidence(text = '', agentContext = {}, recentToolHistory = [], agentState = {}) {
  const report = buildRuntimeEvidenceReport(agentContext, recentToolHistory, agentState)
  if (!report) return String(text || '')
  const base = String(text || '').trim()
  if (/### Runtime evidence|Runtime evidence/i.test(base)) return base
  return `${base}${report}`.trim()
}

function makeReadBackForEdits(calls) {
  const out = []
  const seen = new Set()
  for (const raw of calls || []) {
    const call = raw?.semantic ? raw : normalizeRuntimeCall(raw)
    if (!shouldReadBackCall(call)) continue
    const p = call.semantic?.path || call.args?.path
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push({ tool: 'read_file', args: { path: p }, _readBack: true })
  }
  return out
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
  let cleaned = String(text || '')
  // Strip DeepSeek R1 <think>...</think> blocks to prevent false parses from thinking phase
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '')

  const calls = []
  XML_TOOL_CALL_RE.lastIndex = 0
  let match
  while ((match = XML_TOOL_CALL_RE.exec(cleaned)) !== null) {
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

function sse(target, event, data) {
  try {
    const now = Date.now()
    target.__browseraiLastEventAt = now
    if (!data?.watchdog) target.__browseraiLastRealEventAt = now
    target.write(`event: ${event}\ndata: ${JSON.stringify(normaliseSsePayload(target, event, data))}\n\n`)
    target.flush?.()
  } catch { /* best-effort: ignore */ }
}

function sseKeepAlive(target) {
  try {
    target.write(': keep-alive\n\n')
    target.flush?.()
  } catch { /* best-effort: ignore */ }
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

async function streamFinalAnswer(wrappedRes, fullText) {
  const text = String(fullText || '')
  if (!text) { sse(wrappedRes, 'assistant', { text: '' }); return }
  
  // #37 FIX: Clean up thinking leakage in final answer.
  // Generic fix for any first word: we remove common English meta-preambles
  // but stop exactly before the first character of real content (Russian letters,
  // digits, quotes, markdown markers, or emojis) using a non-consuming lookahead.
  const cleaned = text
    .replace(/^(?:to respond with|according to|the user just said|thus output|i should state|i will now|in summary)[\s\S]*?(?=[\n\p{Script=Cyrillic}"'«#\-\d*]|✅|❌|⚠️|$)/ui, '')
    .trim()

  const parts = cleaned.match(/.{1,32}/g) || [cleaned]
  for (const chunk of parts) {
    sse(wrappedRes, 'assistant_delta', { chunk })
    await new Promise((r) => setTimeout(r, 10))
  }
  sse(wrappedRes, 'assistant', { text: cleaned })
}

// ── LLM Streaming call ──────────────────────────────────────────────────────
async function streamingLLMCall(wrappedRes, step, opts, hooks = {}) {
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
    if (preParsedCalls.length > 0 || insideXml) sse(wrappedRes, 'thought', { step, text: visibleTextBuf })
    else sse(wrappedRes, 'assistant_delta', { step, chunk: visibleTextBuf })
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
          if (parsed.kind === 'thinking') sse(wrappedRes, 'thinking_delta', { step, chunk: parsed.text })
          else {
            preParsedCalls.push(parsed)
            sse(wrappedRes, 'tool_preview', { step, name: parsed.tool, args: parsed.args })
            hooks.onParsedCall?.(parsed)
          }
        }
      }
    }
  }

  const result = await callLLMStream({
    ...opts,
    onTextDelta: (chunk, meta) => {
      if (meta?.kind === 'thinking') sse(wrappedRes, 'thinking_delta', { step, chunk: String(chunk || '') })
      else consumeChunk(String(chunk || ''))
    },
    onToolCallDelta: (tc = {}) => {
      const idx = Number.isInteger(tc.idx) ? tc.idx : 0
      const name = String(tc.name || '').trim()
      if (!name) return
      const key = `${idx}:${name}`
      if (nativePreviewed.has(key)) return
      nativePreviewed.add(key)
      sse(wrappedRes, 'tool_preview', { step, sub: idx, name, args: safeJson(tc.argsBuf || '{}') })
    },
    onUsage: (u) => hooks.onUsage?.(u),
  })
  if (scanBuf) { visibleTextBuf += scanBuf; scanBuf = '' }
  if (visibleTextBuf) flushVisibleText()
  return { ...result, preParsedCalls }
}

// ── Lightweight server-side router paths ────────────────────────────────────
async function runLightweightChat({ res, wrappedRes, provider, history, userId, chatId, mode = 'chat' }) {
  const tokens = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 }
  const lastUser = String([...history].reverse().find((m) => m.role === 'user')?.content || '')
  let webContext = ''

  if (mode === 'web' && lastUser) {
    sse(wrappedRes, 'tool_start', { step: 0, sub: 0, name: 'web_search', args: { query: lastUser, depth: '1' } })
    const results = await searchWeb(lastUser, 5).catch(() => [])
    sse(wrappedRes, 'tool_result', { step: 0, sub: 0, name: 'web_search', ok: true, result: { results: results.slice(0, 5) } })

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

  // Dynamic Temperature: 0.7 for chat, 0.3 for web search
  const currentTemperature = mode === 'chat' ? 0.7 : 0.3

  const reply = await callLLM({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authType: provider.authType || 'bearer',
    authHeader: provider.authHeader || '',
    extraHeaders: provider.extraHeaders || {},
    model: provider.model,
    messages,
    temperature: currentTemperature,
  })

  // Point 3: Automatic escalation/rollback
  const replyText = reply?.text || ''
  if (mode === 'chat' && (replyText.includes('<xai:function_call>') || replyText.includes('<tool_use>') || replyText.includes('<function_call>'))) {
    throw new Error('escalate-to-agent')
  }

  if (reply?.usage) {
    tokens.prompt += Number(reply.usage.prompt || 0)
    tokens.completion += Number(reply.usage.completion || 0)
    tokens.total += Number(reply.usage.total || (tokens.prompt + tokens.completion) || 0)
    tokens.reasoningTokens += Number(reply.usage.reasoningTokens || 0)
    tokens.llmCalls += 1
    try { recordSpend({ userId, chatId, model: provider.model, usage: reply.usage }) } catch { /* ignore */ }
    sse(wrappedRes, 'usage', { step: 0, ...reply.usage, totals: { ...tokens } })
  }

  await streamFinalAnswer(wrappedRes, reply?.text || '')
  sseDone(wrappedRes, { steps: 0, reason: mode === 'web' ? 'server-web-route' : 'server-chat-route' }, tokens)
  res.end()
}


async function runDeterministicAction({ action, res, wrappedRes, userId, chatId }) {
  const tokens = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 }
  sse(wrappedRes, 'agent_context', { deterministicAction: { id: action.id, tool: action.tool, reason: action.reason, risk: action.risk, requiresApproval: action.requiresApproval }, task: { type: action.id, complexity: 'low' } })
  if (action.requiresApproval) {
    const { id: aqId, promise: aqPromise, expiresAt } = registerQuestion({
      kind: 'tool_approval', userId, chatId, step: 0, sub: 0,
      tool: action.tool, category: categoryOf(action.tool),
      question: action.approvalQuestion || `Разрешить ${action.tool}?`,
      options: [{ id: 'approve', label: 'Разрешить' }, { id: 'deny', label: 'Запретить' }],
    })
    sse(wrappedRes, 'tool_approval', { step: 0, sub: 0, question_id: aqId, expiresAt, tool: action.tool, category: categoryOf(action.tool), args: action.args || {} })
    let approved = false
    try {
      const ans = await aqPromise
      const pick = Array.isArray(ans?.selected) ? String(ans.selected[0]) : String(ans?.text || ans)
      approved = ['approve', 'yes', 'ok', 'allow', 'true', 'разрешить'].includes(pick.toLowerCase().trim())
    } catch { /* denied/expired */ }
    if (!approved) {
      await streamFinalAnswer(wrappedRes, '❌ Действие отменено: нет подтверждения.')
      sseDone(wrappedRes, { steps: 0, reason: `${action.id}-denied` }, tokens)
      res.end()
      return
    }
  }
  // Deterministic actions are intentionally compact: no visible tool_start card,
  // no LLM thinking. We still emit tool_result so the workspace panel refreshes.
  const r = await invokeTool(action.tool, action.args || {}, { userId, chatId })
  sse(wrappedRes, 'tool_result', { step: 0, sub: 0, name: action.tool, ok: !!r.ok, result: r.result, error: r.error, structured: normalizeToolResult(action.tool, r, { step: 0, sub: 0 }), compact: true })
  const text = r.ok ? action.successText?.(r) : action.errorText?.(r)
  await streamFinalAnswer(wrappedRes, text || (r.ok ? '✅ Готово.' : `❌ Ошибка: ${r.error || 'unknown error'}`))
  sseDone(wrappedRes, { steps: 0, reason: r.ok ? (action.successReason || `${action.id}-done`) : (action.errorReason || `${action.id}-error`) }, tokens)
  res.end()
}

// ── Error recovery helpers ──────────────────────────────────────────────────
function getRecoveryHint(tool, error, args = {}, recentToolHistory = []) {
  return recoveryHint({ tool, error, args, recentToolHistory })
}


// Approach 6 — sseTrace wrapper: proxies res for write()/end() so sse() can
// capture every emitted event into the replay artifact, while still
// delivering them to the real client response.
function wrapResForSseTrace(realRes, trace) {
  const proxy = Object.create(realRes)
  proxy.write = (chunk) => {
    try {
      const text = String(chunk || '')
      const lines = text.split(/\n\n/)
      for (const block of lines) {
        if (!block.trim() || block.startsWith(':')) continue
        const evtMatch = block.match(/^event: ([^\n]+)/m)
        const dataMatch = block.match(/^data: ([^\n]+)/m)
        if (evtMatch) {
          let payload = null
          if (dataMatch) {
            try { payload = JSON.parse(dataMatch[1]) } catch { payload = dataMatch[1] }
          }
          trace.push({ event: evtMatch[1].trim(), at: Date.now(), payload })
        }
      }
    } catch { /* ignore capture failures */ }
    return realRes.write(chunk)
  }
  proxy.end = (chunk) => { try { return realRes.end(chunk) } catch { return realRes.end() } }
  proxy.flush = () => { try { return realRes.flush?.() } catch { /* ignore */ } }
  proxy.flushHeaders = () => { try { return realRes.flushHeaders?.() } catch { /* ignore */ } }
  proxy.setHeader = (...args) => { try { return realRes.setHeader(...args) } catch { return undefined } }
  proxy.on = (...args) => { try { return realRes.on?.(...args) } catch { return undefined } }
  proxy.emit = (...args) => { try { return realRes.emit?.(...args) } catch { return undefined } }
  return proxy
}

// Approach 6 — finalize a run: emit finalization + run_end on the runLog,
// persist to disk, build + save the replay artifact.
function finalizeRun({ runLog, sseTrace, history, finalStatus, reason, step, maxSteps, recentToolHistory, agentContext, res, startTime, route = '/api/agent/chat' }) {
  try {
    if (!runLog) return
    runLog.finalization({
      reason,
      taskCompleted: Boolean(finalStatus?.taskCompleted),
      verified: Boolean(finalStatus?.verified),
      blockers: finalStatus?.blockers || [],
    })
    const lastError = sseTrace.find((e) => e?.event === 'error')
    if (lastError) {
      runLog.error({
        err: new Error(lastError.payload?.message || 'sse-error'),
        tool: lastError.payload?.tool || null,
        exitReason: reason,
        route,
        context: { reason },
      })
    }
    if (['deadline', 'max-steps', 'crash', 'llm-error', 'no-provider', 'cap-reached'].includes(reason)) {
      runLog.error({ reason: 'termination: ' + reason, exitReason: reason, route, context: { reason } })
    }
    runLog.run_end({ durationMs: Date.now() - startTime, endedStep: step })
    runLog.persist()
    const lastUserAsk = ([...(history || [])].reverse().find((m) => m?.role === 'user')?.content || '').slice(0, 240)
    const artifact = _buildReplayArtifact({
      runId: runLog.runId,
      runLog,
      finalStatus,
      reason,
      history: recentToolHistory || [],
      sseTrace,
      provider: { baseUrl: runLog.getState().provider?.baseUrl, model: runLog.getState().provider?.model },
      input: { lastUserAsk, chatId: runLog.getState().task?.chatId, taskType: runLog.getState().task?.type, historySize: (history || []).length },
    })
    _saveReplay(artifact)
  } catch { /* best-effort: don't break agent loop on log failure */ }
}

// ── Agent Loop ──────────────────────────────────────────────────────────────
export async function runAgent(opts) {
  return withWorkspaceScope(opts?.workspaceScope || '', async () => {
    await ensureWorkspaceRoot()
    return runAgentInner({ ...(opts || {}), workspaceScope: opts?.workspaceScope || '' })
  })
}

async function runAgentInner({ provider, history = [], maxSteps = DEFAULT_MAX_STEPS, extraSystem = '', userId = '', workspaceScope = '', res, runId: runIdOpt = '', taskType: taskTypeOpt = '' }) {
  const chatId = String(workspaceScope || '')
  const startTime = Date.now()
  log.info('agent_start', { chatId, model: provider?.model, taskType: (typeof taskTypeOpt === 'string' && taskTypeOpt) ? taskTypeOpt : 'task', maxSteps })

  // Approach 6 — Observability. Per-run structured log + replay artifact.
  const runLog = _createRunLog({
    runId: runIdOpt || _newRunId(),
    provider,
    routeMode: 'agent',
    taskType: (typeof taskTypeOpt === 'string' && taskTypeOpt) ? taskTypeOpt : 'task',
    userId,
    chatId,
    maxSteps,
    route: '/api/agent/chat',
    scope: chatId,
  })
  runLog.run_start({ firstUserAsk: ([...history].reverse().find((m) => m?.role === 'user')?.content || '').slice(0, 240) })
  const sseTrace = []
  const wrappedRes = wrapResForSseTrace(res, sseTrace)
  
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const currentAbortCtl = new AbortController()

  // Moved after headers sent
  sse(wrappedRes, 'stream_protocol', { version: 1, events: ['stream_protocol', 'agent_context', 'agent_task', 'agent_state', 'thinking', 'thinking_delta', 'assistant_delta', 'assistant', 'thought', 'tool_preview', 'tool_router', 'tool_start', 'tool_progress', 'tool_result', 'tool_diagnostic', 'ask_user', 'tool_approval', 'usage', 'done', 'error'] })

  if (chatId) {
    const existing = activeRunsByChat.get(chatId)
    if (existing) {
      // #42 FIX: Instead of blocking, automatically abort the previous run
      // and start the new one. This prevents the "Request already running" error.
      try {
        existing.abortCtl.abort('superseded by new request')
      } catch (e) { /* ignore */ }
      activeRunsByChat.delete(chatId)
    }
    activeRunsByChat.set(chatId, { startedAt: Date.now(), abortCtl: currentAbortCtl })
  }

  const tokens = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 }
  function accumulateUsage(u) {
    if (!u) return
    tokens.prompt += Number(u.prompt || 0); tokens.completion += Number(u.completion || 0); tokens.total += Number(u.total || (u.prompt + u.completion) || 0)
    tokens.reasoningTokens += Number(u.reasoningTokens || 0); tokens.llmCalls += 1
  }

  if (!provider?.baseUrl || !provider?.apiKey) {
    const finalStatus = buildFinalStatus({ agentContext: {}, recentToolHistory: [], agentState: {}, aborted: false, step: 0, maxSteps: 0, reason: 'no-provider', userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths: new Set(), okReadPaths: new Set() })
    sse(wrappedRes, 'error', { message: 'Provider not configured', finalStatus }); sseDone(wrappedRes, { steps: 0, reason: 'no-provider', finalStatus }, tokens); finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'no-provider', step: 0, maxSteps: 0, recentToolHistory: [], agentContext: {}, res, startTime, route: '/api/agent/chat' }); res.end(); if (chatId) activeRunsByChat.delete(chatId); return
  }

  const deterministicAction = routeDeterministicAction(history)
  if (deterministicAction) {
    try {
      await runDeterministicAction({ action: deterministicAction, res, wrappedRes, userId, chatId })
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
  let serverRoute = routeHistory(history, { forceAgent: Boolean(provider.forceAgent) })

  // ── AI Supervisor Intent Classification ──
  // If we are not forcing the agent manually, we let the AI Supervisor determine the optimal mode
  if (provider.baseUrl !== 'mock' && !provider.forceAgent) {
    const aiDecision = await classifyIntentAI({ provider, history })
    if (aiDecision) {
      serverRoute = {
        mode: aiDecision.toLowerCase(),
        reason: 'AI-supervisor classification',
        icon: aiDecision === 'CHAT' ? '💬' : (aiDecision === 'WEB' ? '🌐' : '🤖')
      }
    }
  }

  if (provider.baseUrl !== 'mock' && !provider.forceAgent && (serverRoute.mode === 'chat' || serverRoute.mode === 'web')) {
    sse(wrappedRes, 'agent_context', { ...agentContext, serverRoute })
    let escalated = false
    try {
      await runLightweightChat({ res, wrappedRes, provider, history, userId, chatId, mode: serverRoute.mode })
    } catch (err) {
      if (err.message === 'escalate-to-agent') {
        escalated = true
        sse(wrappedRes, 'thought', { step: 0, text: '🔄 Автоматическая эскалация: Обнаружен вызов инструментов в режиме чата. Повышаю режим до полноценного Режима Агента для безопасного выполнения!' })
        serverRoute = { mode: 'agent', reason: 'escalated-from-chat', icon: '🤖' }
      } else {
        if (chatId) activeRunsByChat.delete(chatId)
        throw err
      }
    }
    if (!escalated) {
      if (chatId) activeRunsByChat.delete(chatId)
      return
    }
  }

  const liteRun = agentContext?.task?.complexity === 'low' || isDeepSeekWebUrl(provider?.baseUrl || '')
  const toolProfile = toolProfileForTask(agentContext?.task)
  const activeToolNames = liteRun ? null : profileToolNames(toolProfile)
  const allowedToolSet = activeToolNames ? new Set(activeToolNames) : null

  let useNativeTools = supportsNativeTools(provider.baseUrl)
  let systemPrompt = await buildSystemPrompt({ extraSystem, native: useNativeTools, extraTools, chatId, lite: liteRun, toolNames: activeToolNames })
  let toolsSpec = useNativeTools ? (liteRun ? buildNativeToolsSpec(extraTools, { lite: true, toolNames: activeToolNames }) : (await import('./toolConsolidation.js')).buildConsolidatedNativeSpec()) : undefined

  const convo = [{ role: 'system', content: systemPrompt }, ...history]
  const deadline = Date.now() + DEFAULT_DEADLINE_MS
  let step = 0, aborted = false
  res.on('close', () => { aborted = true; currentAbortCtl.abort('client closed') })

  if (agentContext.runtime.effectiveMaxSteps > maxSteps) maxSteps = agentContext.runtime.effectiveMaxSteps
  const agentState = createAgentState({ agentContext, history })
  let persistedTask = null
  try {
    persistedTask = createAgentTask({ userId, chatId, goal: agentState.goal, taskType: agentContext?.task?.type || '', phase: agentState.phase || '', state: agentState, history })
  } catch { /* persistence is best-effort */ }
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

    sse(wrappedRes, 'agent_state', {
      ...agentState,
      status: phase === 'tool' ? 'running' : 'thinking',
      currentStep,
      watchdog: true,
    })

    // Hard-stop only a silent LLM call. Do NOT abort tool/bash/deploy work here:
    // long builds can be quiet but still healthy; tool-level timeouts handle them.
    if (phase === 'llm' && idleMs > LLM_HARD_IDLE_MS && !watchdogAborted) {
      watchdogAborted = true
      try { currentAbortCtl.abort(new Error('LLM idle watchdog timeout')) } catch { /* ignore */ }
    }
  }, 15_000)
  idleWatchdog.unref?.()
  res.on('close', () => clearInterval(idleWatchdog))

  const planningDirective = buildPlanningDirective(agentContext)
  const autonomousDirective = buildAutonomousRuntimeDirective(agentContext)
  const guidedRailsDirective = buildGuidedRailsDirective(agentContext)
  const toolStrategyDirective = buildToolStrategyDirective(agentContext)
  const doneCriteriaDirective = buildDoneCriteriaDirective(agentContext)
  
  // v2.26: High-Intelligence Directive for High Complexity tasks.
  // Encourages deeper reasoning and more robust verification.
  if (agentContext?.task?.complexity === 'high') {
    convo.push({ role: 'user', content: `[high_complexity_directive]\nThis is a COMPLEX task. Do not rush. \n1. Explore the codebase thoroughly using read_project_rules, search_files and list_files.\n2. Read all relevant files before making a plan.\n3. Create a detailed plan with plan_set.\n4. Apply changes using edit_file (preferred) or write_file.\n5. MANDATORY: Verify every change with verify_code or npm_test.\n6. If you hit an error, read the file again to check for drift before retrying.\n[/high_complexity_directive]` })
  }

  if (planningDirective) convo.push({ role: 'user', content: planningDirective })
  if (autonomousDirective) convo.push({ role: 'user', content: autonomousDirective })
  if (guidedRailsDirective) convo.push({ role: 'user', content: guidedRailsDirective })
  if (toolStrategyDirective) convo.push({ role: 'user', content: toolStrategyDirective })
  if (doneCriteriaDirective) convo.push({ role: 'user', content: doneCriteriaDirective })
  
  sse(wrappedRes, 'agent_context', { ...agentContext, toolProfile, toolNames: activeToolNames }); sse(wrappedRes, 'agent_state', agentState)
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

  // recentToolHistory: хранит до TOOL_HISTORY_MAX записей.
  // Без ограничения на runs с maxSteps=60 список мог вырасти до 60×N записей.
  // Obligation/stuck/evidence checks используют последние записи — cap не теряет важного контекста.
  const TOOL_HISTORY_MAX = 120
  const recentCallFingerprints = [], recentToolHistory = [], planState = { done: new Set() }
  function pushToolHistory(entry) {
    recentToolHistory.push(entry)
    if (recentToolHistory.length > TOOL_HISTORY_MAX) recentToolHistory.shift()
  }
  let currentPhase = 'execute'
  let currentPhaseAllowedSet = null
  let autoSnapshotCreated = false
  // Anti-fabrication bookkeeping: which paths were actually read vs failed.
  // Used before the final answer to catch reports citing files that were
  // never successfully opened (observed: invented *.py files in a JS repo).
  const okReadPaths = new Set(), failedReadPaths = new Set()
  let fabricationPushback = false
  let verificationPushback = false
  let explicitLocalTestPushback = false
  let localTestSuccessClaimPushback = false
  let unsupportedEnvClaimPushback = false
  const obligationPushbacks = new Map()
  let pushedBackThisTurn = false
  let consecutiveFailures = 0
  const budget = createRetryBudget()
  let lastPhaseChangeStep = 0

  try {
    while (step < maxSteps) {

      if (Date.now() > deadline) {
        const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps, reason: 'deadline', userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
        sse(wrappedRes, 'error', { message: 'Deadline exceeded', finalStatus }); sseDone(wrappedRes, { steps: step, reason: 'deadline', finalStatus }, tokens); finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'deadline', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' }); break
      }
      step += 1
      if (step > 1 && step % 6 === 0) {
        const { renderAgentStateDigest } = await import('./contextManager.js')
        convo.push({ role: 'user', content: `[focus_chain_reminder]\n${renderAgentStateDigest(agentState, recentToolHistory)}` })
      }
      pushedBackThisTurn = false
      const phaseInfo = deriveTaskPhase({ agentContext, agentState, recentToolHistory })
      if (phaseInfo.phase !== currentPhase) lastPhaseChangeStep = step
      currentPhase = phaseInfo.phase
      currentPhaseAllowedSet = allowedToolsForPhase(currentPhase)
      agentState.phase = currentPhase
      agentState.phaseReason = phaseInfo.reason

      // State machine: stuck detection + escalation pushback
      const stuck = detectStuck({ recentToolHistory, budget, phase: currentPhase, step, planState, lastPhaseChangeStep })
      const escalation = shouldEscalate({ stuck, budget, step, maxSteps })
      if (escalation.escalate && !pushedBackThisTurn) {
        pushedBackThisTurn = true
        const escText = buildEscalationPrompt({ stuck, currentPhase, step })
        sse(wrappedRes, 'thought', { step, text: `⚠️ ${escalation.reason}` })
        convo.push({ role: 'user', content: escText })
      }

      try { if (persistedTask) updateAgentTask(persistedTask.id, { phase: currentPhase, state: agentState, history: convo }) } catch { /* best-effort */ }
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
      sse(wrappedRes, 'thinking', { step })
      sse(wrappedRes, 'agent_state', agentState)

      const capCheck = checkCap(userId)
      if (!capCheck.ok) {
        const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps, reason: 'cap-reached', userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
        sse(wrappedRes, 'error', { message: capCheck.reason, finalStatus }); sseDone(wrappedRes, { steps: step, reason: 'cap-reached', finalStatus }, tokens); finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'cap-reached', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' }); res.end(); return
      }

      const routing = shouldUseCheapEditor({ provider, step, recentToolHistory, userId })
      const activeProvider = routing.useCheap ? wrapProviderForEditor(provider, routing.cheapModel) : provider
      if (routing.useCheap) sse(wrappedRes, 'thought', { step, text: routingLabel(routing) })

      let currentModel = activeProvider.model
      if (consecutiveFailures >= 3 && currentModel === 'deepseek-chat') {
        currentModel = 'deepseek-reasoner'
        sse(wrappedRes, 'thought', { step, text: '🔄 Автоматическое самоисцеление: Обнаружено 3 последовательных сбоя. Временно повышаю уровень интеллекта модели до deepseek-reasoner для выхода из тупика!' })
      }

      let reply, streamedFinalAnswer = false
      try {
        const useStream = supportsStreaming(activeProvider.baseUrl)
        const messagesWithCache = applyAnthropicCacheHints(convo, activeProvider.baseUrl)
        const llmArgs = {
          baseUrl: activeProvider.baseUrl,
          apiKey: activeProvider.apiKey,
          authType: activeProvider.authType || 'bearer',
          authHeader: activeProvider.authHeader || '',
          extraHeaders: activeProvider.extraHeaders || {},
          model: currentModel,
          messages: messagesWithCache,
          temperature: Number(activeProvider.temperature ?? 0.3),
          signal: currentAbortCtl.signal,
          ...(useNativeTools ? { tools: toolsSpec, toolChoice: 'auto' } : {})
        }
        if (useStream) {
          reply = await streamingLLMCall(wrappedRes, step, llmArgs, { onUsage: (u) => accumulateUsage(u) })
          streamedFinalAnswer = !reply.toolCalls?.length && !reply.preParsedCalls?.length
        } else {
          reply = await callLLM(llmArgs); accumulateUsage(reply?.usage)
        }
      } catch (e) {
        const providerError = normalizeProviderError(e, { baseUrl: provider.baseUrl, model: provider.model, phase: 'agent-llm-call' })
        const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps, reason: 'llm-error', error: providerError, userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
        sse(wrappedRes, 'error', { message: 'LLM failed: ' + safeErrorMessage(providerError.message), providerError: safeProviderError(providerError), finalStatus }); sseDone(wrappedRes, { steps: step, reason: 'llm-error', finalStatus }, tokens); finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'llm-error', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' }); res.end(); return
      }

      res.__agentPhase = 'agent'
      res.__agentActiveTool = ''

      let spendNote = null
      try { spendNote = recordSpend({ userId, chatId, model: activeProvider.model, usage: reply?.usage || {} }) } catch { /* best-effort: ignore */ }
      if (reply?.usage) sse(wrappedRes, 'usage', { step, ...reply.usage, totals: { ...tokens }, cost: spendNote?.cost || 0 })

      let calls = []
      if (useNativeTools && Array.isArray(reply.toolCalls)) {
        for (const tc of reply.toolCalls) {
          const corrected = correctToolName(tc.name)
          const exists = TOOLS[corrected] || (extraTools && extraTools[corrected]) || isConsolidatedTool(corrected)
          calls.push({ 
            tool: corrected, 
            args: tc.args || {}, 
            nativeId: tc.id, 
            nativeRaw: tc.raw,
            unknown: !exists
          })
        }
      }
      if (calls.length === 0) {
        const xmlCalls = parseXmlFunctionCalls(reply.text || '')
        for (const c of xmlCalls) {
          const corrected = correctToolName(c.tool)
          const exists = TOOLS[corrected] || (extraTools && extraTools[corrected]) || isConsolidatedTool(corrected)
          calls.push({
            tool: corrected,
            args: c.args || {},
            unknown: !exists
          })
        }
      }

      if (calls.length === 0) {
        if (looksLikeUnapplliedCodeReply(reply.text, history) && !aborted && !pushedBackThisTurn) {
          pushedBackThisTurn = true
          sse(wrappedRes, 'thought', { step, text: 'Code not applied. Requesting fix.' })
          convo.push({ role: 'user', content: 'You provided code without tool calls. Apply changes with write_file/edit_file now.' }); continue
        }
        if (step === 1 && !pushedBackThisTurn && !aborted) {
          pushedBackThisTurn = true
          sse(wrappedRes, 'thought', { step, text: 'No tools called. Forcing action.' })
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
            sse(wrappedRes, 'thought', { step, text: `Самопроверка: ответ ссылается на файлы, которые НЕ удалось прочитать (${cited.slice(0, 5).join(', ')}). Требую переработку по реальным файлам.` })
            convo.push({ role: 'user', content: `[fabrication_check] Your draft cites files that DO NOT EXIST — every read_file on them failed: ${cited.join(', ')}. You invented their content. Start over: call list_files to see the REAL tree, read_file the REAL files, and rewrite the answer using only verbatim quotes from successful read_file results. Do not mention non-existent files.` })
            continue
          }
        }

        const lastUserAsk = [...history].reverse().find((m) => m.role === 'user')?.content || ''
        const didRealWork = recentToolHistory.some((h) => h.ok && !['ask_user', 'recall_facts', 'plan_check', 'plan_set'].includes(h.tool))
        const explicitLocalTestRequested = askedForExplicitLocalTest(lastUserAsk)
        const localTestAttempted = hasLocalTestAttempt(recentToolHistory)
        const localTestPassed = hasSuccessfulLocalTest(recentToolHistory)
        if (didRealWork && !convo.some(m => m.role === 'user' && String(m.content).startsWith('[reflection]')) && !aborted) {
          // Hard 20s cap: reflection is advisory — a hanging provider call
          // here must never block stream completion (same spinner-hang class).
          const verdict = await Promise.race([
            runReflectionCheck({ provider, ask: lastUserAsk, draft: reply.text || '', toolHistory: recentToolHistory }),
            new Promise((r) => setTimeout(() => r(null), 20_000)),
          ]).catch(() => null)
          if (verdict?.needsMoreWork) {
            sse(wrappedRes, 'thought', { step, text: `Самопроверка: ${verdict.reason}` })
            convo.push({ role: 'user', content: `[reflection] Gaps identified:\n${verdict.reason}` }); continue
          }
        }
        if (!verificationPushback && needsVerificationSinceLastEdit(recentToolHistory) && !aborted) {
          verificationPushback = true
          sse(wrappedRes, 'thought', { step, text: 'Самопроверка: после изменения кода не было verify_code/npm_test. Запускаю проверку перед финальным ответом.' })
          convo.push({ role: 'user', content: `[verification_required]\nYou changed code/config files but have not verified them after the last edit. Call verify_task, verify_code on touched files, or npm_test now. Do not final-answer until verification is done or explicitly explain a skipped verifier via tool result.` })
          continue
        }

        if (explicitLocalTestRequested && !localTestAttempted && !explicitLocalTestPushback && !aborted) {
          explicitLocalTestPushback = true
          sse(wrappedRes, 'thought', { step, text: 'Самопроверка: пользователь явно просил локальный тест, но реальный запуск теста ещё не подтверждён. Требую выполнить тест до финального ответа.' })
          convo.push({ role: 'user', content: `[explicit_local_test_enforcement]\nThe user explicitly asked for a real local test run. Before the final answer, run the exact local test command now via bash, shell_session_run, npm_test, or verify_task. Quote the real stdout/stderr or the exact failing command in the final answer. Do not skip this step.` })
          continue
        }

        if (hasStrongLocalTestSuccessClaim(reply.text || '') && !localTestPassed && !localTestSuccessClaimPushback && !aborted) {
          localTestSuccessClaimPushback = true
          sse(wrappedRes, 'thought', { step, text: 'Самопроверка: черновик заявляет, что тесты прошли, но в tool history нет успешного подтверждения. Требую реальный rerun или исправление отчёта.' })
          convo.push({ role: 'user', content: `[test_success_claim_check]\nYour draft claims that tests passed, but there is no successful local test evidence in tool history. Re-run the exact local test command now and keep the success claim only if the tool output actually passes. Otherwise correct the final answer to reflect the real failure/output.` })
          continue
        }

        if (Boolean(agentContext?.task?.obligations?.verify) && hasUnsupportedEnvironmentClaim(reply.text || '') && !localTestAttempted && !unsupportedEnvClaimPushback && !aborted) {
          unsupportedEnvClaimPushback = true
          sse(wrappedRes, 'thought', { step, text: 'Самопроверка: черновик заявляет, что локальная проверка невозможна, но прямого tool evidence нет. Требую явный rerun и точный stdout/stderr.' })
          convo.push({ role: 'user', content: `[test_blocker_evidence_check]\nYour draft claims that local verification is impossible / blocked by the environment. Do NOT make that claim without direct tool evidence. Run the exact local verification command now via bash or shell_session_run. If it truly cannot run, quote the exact command and the exact tool error verbatim in the final answer.` })
          continue
        }

        const doneCriteriaGap = unmetDoneCriteria(agentContext?.task?.type, recentToolHistory)
        if (doneCriteriaGap && !aborted) {
          sse(wrappedRes, 'thought', { step, text: `Критерии завершения ещё не выполнены: ${doneCriteriaGap}` })
          convo.push({ role: 'user', content: `[done_criteria_enforcement]\n${doneCriteriaGap}\nContinue with the required tool call(s). Do not final-answer yet.` })
          continue
        }

        const obligationGap = unmetGoalObligation(agentContext, recentToolHistory)
        if (obligationGap && !aborted) {
          const prev = Number(obligationPushbacks.get(obligationGap.key) || 0)
          if (prev < 2) {
            obligationPushbacks.set(obligationGap.key, prev + 1)
            agentState.obligationStatus = obligationGap.status
            sse(wrappedRes, 'thought', { step, text: `Автопилот не завершает задачу: ${obligationGap.message}. Продолжаю выполнять обязательный шаг.` })
            convo.push({ role: 'user', content: `[goal_obligation_enforcement]\nThe user request implies obligation "${obligationGap.key}" but it is not satisfied yet: ${obligationGap.message}.\n\nCurrent obligation status:\n${JSON.stringify(obligationGap.status, null, 2)}\n\nContinue with the required tool call(s). If impossible because of credentials/approval/policy/tooling, state the blocker explicitly in the final report with evidence. Do not silently omit this obligation.` })
            continue
          }
        }

        const unfinishedPlan = incompletePlanSteps(agentState)
        if (unfinishedPlan.length > 0 && !aborted) {
          sse(wrappedRes, 'thought', { step, text: `План ещё не закрыт: осталось ${unfinishedPlan.length} шаг(ов). Продолжаю выполнение.` })
          convo.push({ role: 'user', content: `[plan_enforcement]
You created a plan but have not completed it. Remaining steps:
${unfinishedPlan.map((s) => `- ${s.idx}. ${s.text}`).join('\n')}

Continue with tool calls. If a step is actually done, call plan_check for it first. Do not final-answer until all applicable plan steps are checked or explicitly revised with plan_set.` })
          continue
        }

        const finalTextWithEvidence = didRealWork ? appendRuntimeEvidence(reply.text || '', agentContext, recentToolHistory, agentState) : (reply.text || '')
        if (streamedFinalAnswer) sse(wrappedRes, 'assistant', { text: finalTextWithEvidence })
        else await streamFinalAnswer(wrappedRes, finalTextWithEvidence)

        // CRITICAL ORDER: send 'done' and close the stream FIRST. The
        // lesson-extraction below makes an extra LLM call — if it hangs
        // (slow provider, dead DeepSeek session) while 'done' hasn't been
        // sent, the UI spinner never stops and the Composer silently
        // swallows every next message. Lessons are best-effort background
        // work and must never delay stream completion.
        const finalStatus = buildFinalStatus({
          agentContext,
          recentToolHistory,
          agentState,
          aborted,
          step,
          maxSteps: DEFAULT_MAX_STEPS,
          reason: 'final',
          userText: [...history].reverse().find((m) => m.role === 'user')?.content || '',
          failedReadPaths,
          okReadPaths,
        })
        try { if (persistedTask) finishAgentTask(persistedTask.id, { status: finalStatus.taskCompleted ? 'succeeded' : (isBlocked(finalStatus) ? 'blocked' : 'partial'), state: agentState, history: convo, finalStatus }) } catch { /* best-effort */ }
        sseDone(wrappedRes, { steps: step, reason: 'final', finalStatus }, tokens); finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'final', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' }); res.end()
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
        sse(wrappedRes, 'thought', { step, text: String(reply.text).trim() })
      }

      if (calls.some(c => c.nativeId)) convo.push({ role: 'assistant', content: reply.text || '', tool_calls: calls.filter(c => c.nativeId).map(c => c.nativeRaw) })
      else convo.push({ role: 'assistant', content: reply.text || '' })

      calls = calls.map((call) => normalizeRuntimeCall(call))
      for (let i = 0; i < calls.length; i++) if (calls[i].tool === 'plan_check') calls[i] = normalizeRuntimeCall(dedupePlanCheck(calls[i], planState))
      const readBacks = makeReadBackForEdits(calls)
      for (const rb of readBacks) calls.push(normalizeRuntimeCall(rb))

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
        if (violatesPreDeployVerifyCall(call, recentToolHistory)) return { call, r: makeToolErrorResult('Blocked: verify_code required.'), pushedBack: true }
        if (isStuckLoop(recentCallFingerprints, callFingerprint(call))) return { call, r: makeToolErrorResult('Stuck in loop.'), pushedBack: true }

        if (call.unknown) {
          const rErr = makeToolErrorResult(`Инструмент "${call.tool}" не существует. Пожалуйста, используйте только разрешенные инструменты: ${[...allowedToolSet].join(', ')}`)
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        if (!isToolAllowed(call.tool, allowedToolSet, extraTools)) {
          const rErr = makeToolErrorResult(`Tool ${call.tool} is not available in the current ${toolProfile} tool profile. Use one of: ${[...allowedToolSet].join(', ')}`)
          sse(wrappedRes, 'tool_router', { step, sub: idx, name: call.tool, warnings: [rErr.error] })
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        if (!isToolAllowed(call.tool, currentPhaseAllowedSet, extraTools)) {
          const allowed = currentPhaseAllowedSet ? [...currentPhaseAllowedSet].join(', ') : 'all profile tools'
          const rErr = makeToolErrorResult(`Tool ${call.tool} is blocked in phase ${currentPhase}. Use one of: ${allowed}`)
          sse(wrappedRes, 'tool_router', { step, sub: idx, name: call.tool, warnings: [rErr.error], phase: currentPhase })
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        const validation = validateToolCall(call.tool, call.args || {}, { ...TOOLS, ...extraTools }[call.tool])
        if (!validation.ok) {
          if (!pushedBackThisTurn && !aborted) {
            pushedBackThisTurn = true
            // v2.24: surface schema errors as a visible thought + tool_result so
            // the UI (and tests) see the self-healing push-back explicitly.
            sse(wrappedRes, 'thought', { step, sub: idx, text: `ОШИБКА СХЕМЫ: ${call.tool} — ${validation.error}. Исправляю вызов инструмента.` })
            const rErr = makeToolErrorResult(`[schema_error] ${validation.error}`)
            sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
            return { call, r: rErr, pushedBack: true }
          }
          return { call, r: makeToolErrorResult(validation.error) }
        }
        call.args = validation.args
        if (!autoSnapshotCreated && ['write_file', 'edit_file', 'delete_file', 'create_folder', 'rename_item', 'workspace_snapshot_restore'].includes(call.tool)) {
          try {
            const snap = await withWorkspaceScope(chatId, () => createWorkspaceSnapshot({ label: `before-${call.tool}-step-${step}` }))
            autoSnapshotCreated = true
            sse(wrappedRes, 'tool_diagnostic', { step, sub: idx, name: 'workspace_snapshot_create', path: snap.file, message: `Rollback snapshot created: ${snap.id}` })
          } catch (e) {
            sse(wrappedRes, 'thought', { step, sub: idx, text: `Не удалось создать snapshot перед ${call.tool}: ${safeErrorMessage(e)}` })
          }
        }
        if (call.tool !== 'ask_user' && requiresApproval(call.tool, userId, call.args || {})) {
          const { id: aqId, promise: aqPromise, expiresAt } = registerQuestion({ kind: 'tool_approval', userId, chatId, step, sub: idx, tool: call.tool, category: categoryOf(call.tool), question: `Approve ${call.tool}?`, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }] })
          sse(wrappedRes, 'tool_approval', { step, sub: idx, question_id: aqId, expiresAt, tool: call.tool, args: call.args })
          let approved = false; try { const ans = await aqPromise; const pick = Array.isArray(ans?.selected) ? String(ans.selected[0]) : String(ans?.text || ans); approved = ['approve', 'yes', 'ok', 'allow', 'true'].includes(pick.toLowerCase().trim()) } catch { /* best-effort: ignore */ }
          if (!approved) return { call, r: { ok: false, error: 'User denied.' } }
        }

        res.__agentPhase = 'tool'
        res.__agentActiveTool = call.tool
        sse(wrappedRes, 'thought', { step, sub: idx, text: narrateRuntimeCall(call, agentContext), generated: true })
        sse(wrappedRes, 'tool_start', { step, sub: idx, name: call.tool, args: call.args })

        // State machine: record retry budget + advisory guard
        recordToolCall(budget, call.tool, call.args || {}, step)
        const guard = guardToolCall({ tool: call.tool, phase: currentPhase, budget, recentToolHistory, step })
        if (guard.advisory && guard.blocked) {
          sse(wrappedRes, 'thought', { step, sub: idx, text: `⚠️ ${guard.reason} Proceeding with advisory only.`, generated: true })
        }
        let r
        if (call.tool === 'ask_user') {
          const aArgs = call.args || {}, rawList = Array.isArray(aArgs.questions) ? aArgs.questions : [{ id: 'q1', question: aArgs.question || '?', options: aArgs.options || [], allowCustomResponse: aArgs.allow_custom !== false, multi: aArgs.multi !== false }]
          const answers = await Promise.all(rawList.slice(0, 6).map(q => { const { id, promise, expiresAt } = registerQuestion({ kind: 'ask_user', userId, chatId, step, sub: idx, question: q.question, options: q.options, multi: q.multi, allowCustom: q.allowCustomResponse }); sse(wrappedRes, 'ask_user', { step, sub: idx, question_id: id, expiresAt, question: q.question, options: q.options }); return promise.then(a => ({ ok: true, answer: a }), e => ({ ok: false, error: e.message })) }))
          r = { ok: true, result: answers.length === 1 ? answers[0].answer : { answers } }
        } else {
          // Expand consolidated tool calls (file→read_file, shell→bash, etc.)
          // The SSE events above keep the consolidated name (what the model sees),
          // but the actual execution goes to the underlying handler.
          const exp = expandConsolidatedCall(call.tool, call.args)
          if (exp.error) {
            r = { ok: false, error: exp.error }
          } else {
            r = await invokeTool(exp.name, { 
              ...exp.args, 
              _provider: provider,
              _projectRules: (await withWorkspaceScope(chatId, () => readProjectRules().catch(() => ''))),
              _recentActivity: (await withWorkspaceScope(chatId, () => listRecentWorkspaceActivity({ sinceMs: 24 * 60 * 60 * 1000 }).catch(() => []))).map(a => `${a.reason} ${a.path}`).join(', ')
            }, { 
              signal: currentAbortCtl.signal, 
              onStdout: (c) => sse(wrappedRes, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stdout', chunk: String(c).slice(0, 2000) }), 
              onStderr: (c) => sse(wrappedRes, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stderr', chunk: String(c).slice(0, 2000) }), 
              userId, chatId, extraTools 
            })
          }
        }
        const semanticOk = toolSucceeded(call.tool, r, call.args)
        if (categoryOf(call.tool) !== 'ask') {
          if (!semanticOk) {
            consecutiveFailures++
          } else {
            consecutiveFailures = 0
          }
        }
        if (!semanticOk && !pushedBackThisTurn && !aborted && categoryOf(call.tool) !== 'ask') {
          const semanticError = r.ok ? summarizeToolOutcome(call.tool, r, call.args) : r.error
          const recovery = getRecoveryAction({ tool: call.tool, error: semanticError, result: r.result, args: call.args, recentToolHistory })
          const hint = recovery?.message || getRecoveryHint(call.tool, semanticError, call.args, recentToolHistory)
          if (hint) {
            pushedBackThisTurn = true
            sse(wrappedRes, 'thought', { step, sub: idx, text: `ОШИБКА: ${call.tool} — ${semanticError}. Исправляю…` })
            const rErr = makeToolErrorResult(`[exec_error] ${semanticError}.\n\nREQUIRED ACTION TO RECOVER:\n${hint}\n\nExecute this action now.`)
            rErr.result = r.result
            sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, result: r.result, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
            return { call, r: rErr, pushedBack: true }
          }
          pushedBackThisTurn = true
          sse(wrappedRes, 'thought', { step, sub: idx, text: `Ошибка выполнения: ${call.tool} — ${semanticError}. Пробую восстановиться.` })
          const rErr = makeToolErrorResult(`[exec_error] ${semanticError}`)
          rErr.result = r.result
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, result: r.result, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }
        const stateResult = semanticOk ? r : { ...r, ok: false, error: r.error || summarizeToolOutcome(call.tool, r, call.args) }
        updateAgentStateFromTool(agentState, call.tool, stateResult, call.args); agentState.obligationStatus = obligationCompletionStatus(agentState.obligations || {}, recentToolHistory); try { if (persistedTask) updateAgentTask(persistedTask.id, { phase: agentState.phase || currentPhase, state: agentState, history: convo }) } catch { /* best-effort */ }; sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: semanticOk, result: r.result, error: semanticOk ? r.error : (r.error || summarizeToolOutcome(call.tool, r, call.args)), structured: normalizeToolResult(call.tool, stateResult, { step, sub: idx }) }); sse(wrappedRes, 'agent_state', agentState)
        res.__agentPhase = 'agent'
        res.__agentActiveTool = ''
        return { call, r, semanticOk }
        })())
      }

      let sawPushBack = false
      for (const res of results) { if (res?.pushedBack) sawPushBack = true; if (res?.call && res?.r) { const semanticOk = typeof res.semanticOk === 'boolean' ? res.semanticOk : !!res.r.ok; const historyEntry = normalizeRuntimeHistoryEntry({ tool: res.call.tool, ok: semanticOk, at: Date.now(), args: summarizeCallArgsForDigest(res.call.args || {}), outcome: summarizeToolOutcome(res.call.tool, res.r, res.call.args || {}) }); pushToolHistory(historyEntry); const semantic = historyEntry.semantic || runtimeSemantics(historyEntry); if (semantic.isRead && semantic.path) { (semanticOk ? okReadPaths : failedReadPaths).add(String(semantic.path)) } if ((res.call.tool === 'plan_set' || (res.call.tool === 'plan' && res.call.args?.action === 'set')) && semanticOk) planState.done = new Set(); else if ((res.call.tool === 'plan_check' || (res.call.tool === 'plan' && res.call.args?.action === 'check')) && semanticOk) (res.r.result?.checked || []).forEach(idx => planState.done.add(Number(idx))) }; try { if (res?.call && runLog) { const sem = runtimeSemantics({ tool: res.call.tool, args: JSON.stringify(res.call.args || {}), outcome: '' }); runLog.toolCall({ tool: res.call.tool, args: summarizeCallArgsForDigest(res.call.args || {}), ok: typeof res.semanticOk === 'boolean' ? res.semanticOk : !!res.r?.ok, semantic: sem, outcome: summarizeToolOutcome(res.call.tool, res.r || {}, res.call.args || {}), error: res.r?.ok ? null : (res.r?.error || null) }) } } catch { /* ignore log failures */ } }
      agentState.obligationStatus = obligationCompletionStatus(agentState.obligations || {}, recentToolHistory)

      // Always feed observations back into the conversation, even for
      // push-back/recovery turns. Otherwise the next LLM step would see the
      // assistant tool call but not the failure/recovery instruction.
      for (const { call, r } of results) {
        let obsRaw = r.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) : 'ERROR: ' + r.error
        let obsContent = clipToolOutput(call.tool, obsRaw, provider?.model)
        if (r.ok && r.result?.dataUrl && useNativeTools) obsContent = [{ type: 'text', text: clipToolOutput(call.tool, { ...obsRaw, dataUrl: undefined }, provider?.model) }, { type: 'image_url', image_url: { url: r.result.dataUrl } }]
        if (call.nativeId) convo.push({ role: 'tool', tool_call_id: call.nativeId, name: call.tool, content: obsContent })
        else convo.push({ role: 'user', content: `<arena-system-message>
Tool result for ${call.tool}:
ok: ${r.ok}
</arena-system-message>
${obsContent}` })
      }
      if (sawPushBack) continue

    }
    if (step >= maxSteps) {
      const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps, reason: 'max-steps', userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
      try { if (persistedTask) finishAgentTask(persistedTask.id, { status: 'blocked', state: agentState, history: convo, finalStatus }) } catch { /* best-effort */ }
      sse(wrappedRes, 'error', { message: `Stopped after ${maxSteps} steps`, finalStatus }); sseDone(wrappedRes, { steps: step, reason: 'max-steps', finalStatus }, tokens); finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'max-steps', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' })
    }
  } catch (e) {
    const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps, reason: 'crash', error: e, userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
    try { if (persistedTask) finishAgentTask(persistedTask.id, { status: 'failed', state: agentState, history: convo, finalStatus }) } catch { /* best-effort */ }
    sse(wrappedRes, 'error', { message: safeErrorMessage(e), finalStatus }); sseDone(wrappedRes, { steps: step, reason: 'crash', finalStatus }, tokens); finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'crash', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' })
  } finally { clearInterval(idleWatchdog); if (chatId) activeRunsByChat.delete(chatId); try { res.end() } catch { /* best-effort: ignore */ } }
}

function sseDone(wrappedRes, payload, tokens) { sse(wrappedRes, 'done', { ...payload, tokens }) }

export const __test = {
  askedForExplicitLocalTest,
  hasLocalTestAttempt,
  hasSuccessfulLocalTest,
  needsVerificationSinceLastEdit,
  obligationCompletionStatus,
}
