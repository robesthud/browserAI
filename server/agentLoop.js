// === Privileged Agent Runtime Platform (Agent Runtime) ===
// === Privileged Agent Runtime Platform (Agent Runtime) ===
// LLM decides. Runtime executes with real host privileges.

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
import { expandConsolidatedCall, isConsolidatedTool, buildConsolidatedNativeSpec } from './toolConsolidation.js'
import { getRecoveryAction, getRecoveryHint as recoveryHint } from './recoveryEngine.js'
import { buildToolStrategyDirective } from './failurePlaybooks.js'
import { createWorkspaceSnapshot } from './workspaceSnapshots.js'
import { deriveTaskPhase, allowedToolsForPhase, createRetryBudget, recordToolCall, guardToolCall, detectStuck, shouldEscalate, buildEscalationPrompt } from './taskStateMachine.js'
import { createAgentTask, updateAgentTask, finishAgentTask } from './agentTasks.js'
import {
  clipToolOutput, manageContext, applyAnthropicCacheHints,
  upsertAgentStateDigest,
} from './contextManager.js'
import { safeErrorMessage, safeProviderError } from './errorSanitizer.js'
import { redactSecrets } from './sandboxPolicy.js'
import { renderProjectMemoryForPrompt, upsertProjectFact } from './projectMemory.js'
import log from './logger.js'
import {
  needsVerificationSinceLastEdit,
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
import { validateFinalClaims } from './finalClaimValidator.js'
import {
  DIRECT_TOOL_NAMES,
  extractMarkdownShellCommand,
  isDirectToolTag,
  parseXmlToolBody,
} from './agentDecision.js'
import { resolveAgentTurn } from './agentTurnOrchestrator.js'
import {
  shouldPushShellFirst,
  shellFirstPushbackMessage,
} from './agentActionPolicy.js'
import { composeEvidenceBackedFinal } from './agentFinalComposer.js'
import { recordToolWorkspaceEvents } from './workspaceEventLog.js'
// (errorTaxonomy not imported — reserved for future structured crash classification)
import {
  normalizeRuntimeCall,
  narrateRuntimeCall,
  shouldReadBackCall,
  violatesPreDeployVerifyCall,
} from './runtimeCallSemantics.js'
import { toolSucceeded, summarizeToolOutcome } from './runtimeToolResultSemantics.js'
import { buildAgentSystemPrompt } from './agentPrompt.js'
import { recordSpend, checkCap } from './costTracker.js'
import { resolveNextProvider, isTransientProviderError } from './providerFallback.js'
import { shouldUseCheapEditor, wrapProviderForEditor, routingLabel, reviewerModelFor, getAutopilotModelForTurn } from './architectEditor.js'
import { suggestStrongSibling } from './modelKnowledge.js'
// Privileged Agent Runtime Platform - no approval system
import { isPrivilegedMode } from '../runtime/RUNTIME_MODE.js';
import {
  buildAgentContext, normalizeToolResult, createAgentState,
  buildPlanningDirective, buildAutonomousRuntimeDirective, buildGuidedRailsDirective, buildDoneCriteriaDirective, updateAgentStateFromTool,
  validateToolCall, makeToolErrorResult,
} from './agentCore.js'

// Все таймауты читаются из env, чтобы можно было настроить без пересборки.
// BROWSERAI_MAX_STEPS       — лимит шагов агента (default: 50)
// BROWSERAI_DEADLINE_MS     — общий дедлайн run в мс (default: 20 мин)
// BROWSERAI_IDLE_NOTICE_MS  — через сколько мс без события показывать watchdog-статус (default: 75с)
// BROWSERAI_LLM_IDLE_MS     — через сколько мс молчания LLM считается зависшим (default: 120с)
// envNum: читает env как число, использует fallback ТОЛЬКО если переменная не задана или NaN.
// Number("0") || 15 === 15 — это ложный fallback; явная проверка !v устраняет баг.
function envNum(key, fallback) { const v = Number(process.env[key]); return (process.env[key] !== undefined && Number.isFinite(v)) ? v : fallback }
const DEFAULT_MAX_STEPS   = envNum('BROWSERAI_MAX_STEPS',      50) // agentCore suggestedMaxSteps can raise per complexity
const DEFAULT_DEADLINE_MS = envNum('BROWSERAI_DEADLINE_MS',  20 * 60 * 1000)
const IDLE_NOTICE_MS      = envNum('BROWSERAI_IDLE_NOTICE_MS', 75 * 1000)
// LLM hard idle timeout: 5 минут (default). Поднято с 2 мин потому что
// финальный ответ может долго стримиться assistant_delta чанками,
// особенно для длинных задач с тяжёлым summary + Runtime evidence блоком.
const LLM_HARD_IDLE_MS    = envNum('BROWSERAI_LLM_IDLE_MS',  5 * 60 * 1000)
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
  'file_write':    'write_file',
  'file_read':     'read_file',
  'file_edit':     'edit_file',
  'file_delete':   'delete_file',
  'file_list':     'list_files',
  'file_search':   'search_files',
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
  let repoMap
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
  // Сортируем ключи для детерминированного fingerprint.
  // JSON.stringify(v, replacer-array) — второй аргумент как массив строк работает как allowlist ключей.
  // Чтобы ВКЛЮЧИТЬ все ключи (не фильтровать) и при этом отсортировать их,
  // используем replacer-функцию или предварительно строим отсортированный объект.
  try {
    const sorted = Object.keys(args).sort().reduce((o, k) => { o[k] = args[k]; return o }, {})
    normalised = JSON.stringify(sorted)
  } catch { normalised = '{}' }
  return `${call.tool}::${normalised}`
}

// Семейство для similarity detection — группирует вызовы по tool + ключевому аргументу
// чтобы поймать "ls /workspace", "ls /workspace/chats", "ls -la /workspace/chats/foo" как одну семью.
function callFamily(call) {
  if (!call) return ''
  const args = call.args || {}
  // Берём только аргументы из allowlist — остальные игнорируем для similarity
  const sig = ['path', 'file_path', 'url', 'command', 'query', 'service', 'task_id', 'action']
    .filter((k) => args[k] != null)
    .map((k) => {
      let v = String(args[k])
      // Нормализуем пути и команды для similarity
      if (k === 'path' || k === 'file_path' || k === 'url') {
        v = v.replace(/\/[^/\s]+$/, '/*') // обрезаем имя файла для группировки
      }
      if (k === 'command') {
        // Нормализуем shell команды с путями: "ls /workspace/foo" → "ls /workspace/*"
        // Берём первое слово (бинарь) и путь если есть
        const cmdTrim = v.replace(/\s+/g, ' ').slice(0, 120)
        const m = cmdTrim.match(/^(\S+)\s+(\S+)/)
        if (m) {
          const binary = m[1].split('/').pop() // имя бинаря без пути
          const path = m[2].replace(/\/[^/\s]+$/, '/*')
          v = `${binary} ${path}`
        } else {
          v = cmdTrim.split(' ')[0]
        }
      }
      return `${k}=${v}`
    })
    .sort()
    .join('|')
  return `${call.tool}::${sig}`
}

// STUCK_THRESHOLD = 4: два одинаковых read_file подряд — нормальная ситуация
// (агент перечитывает файл после правки). Три подряд — уже признак петли.
// Четыре — надёжный сигнал для прерывания без ложных срабатываний.
const STUCK_THRESHOLD = 4
// Similarity threshold: вызовы из одного семейства (разные пути в одной директории)
// считаются петлёй если их 6+ за последние 12 шагов.
const SIMILAR_STUCK_THRESHOLD = 6
function isStuckLoop(recentCalls, currentFingerprint, recentFamilies, currentFamily) {
  if (!currentFingerprint) return false
  let consecutive = 0
  for (let i = recentCalls.length - 1; i >= 0; i -= 1) {
    if (recentCalls[i] === currentFingerprint) consecutive += 1
    else break
  }
  if (consecutive + 1 >= STUCK_THRESHOLD) return true

  const recentWindow = recentCalls.slice(-10)
  const totalInWindow = recentWindow.filter((x) => x === currentFingerprint).length
  if (totalInWindow + 1 >= STUCK_THRESHOLD) return true

  // Similarity detection: если 6+ вызовов из одного семейства за 12 — это петля
  // (агент пробует разные пути в одной директории, ls /workspace, ls /workspace/chats, и т.д.)
  if (currentFamily && recentFamilies) {
    const familyWindow = recentFamilies.slice(-12)
    const totalFamily = familyWindow.filter((f) => f === currentFamily).length
    if (totalFamily + 1 >= SIMILAR_STUCK_THRESHOLD) return true
  }
  return false
}

function summarizeCallArgsForDigest(args = {}) {
  if (!args || typeof args !== 'object') return ''
  const pick = {}
  // Команды обрезаем на 1000 символов (а не 160!) чтобы obligation tracker
  // мог распознать git commit / git push в длинных &&-цепочках.
  // Остальные поля — 160 символов достаточно для summary.
  const LIMIT_COMMAND = 1000
  const LIMIT_SHORT = 160
  for (const k of ['action', 'path', 'file_path', 'source_path', 'output_path', 'url', 'query', 'message', 'service', 'task_id']) {
    if (args[k] != null) pick[k] = String(args[k]).slice(0, LIMIT_SHORT)
  }
  if (args.command != null) pick.command = String(args.command).slice(0, LIMIT_COMMAND)
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
  // Automated Reviewer Sibling Upgrade (like Arena.ai):
  const strongModel = suggestStrongSibling(provider.model)
  let reviewProvider = provider
  if (strongModel) {
    const { listKeys } = await import('./db.js')
    const keys = listKeys()
    const matchedKey = keys.find(k => k.model === strongModel)
    if (matchedKey) {
      reviewProvider = matchedKey
      console.log(`[Reviewer] Upgraded to strong sibling ${strongModel} for code-review turn!`);
    }
  }
  const toolSummary = (toolHistory || []).slice(-12).map((h) => `${h.ok ? '✓' : '✗'} ${h.tool}`).join(', ')
  const prompt = `Review if the task is done.\nGoal: ${ask}\nTools: ${toolSummary}\nDraft: ${draft}\nReply DONE or TODO: reason.`
  
  // Use a slightly lower temperature for consistent critique
  const reply = await callLLM({
    baseUrl: reviewProvider.baseUrl, apiKey: reviewProvider.apiKey,
    authType: reviewProvider.authType || 'bearer',
    authHeader: reviewProvider.authHeader || '',
    extraHeaders: reviewProvider.extraHeaders || {},
    model: reviewProvider.model,
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

  if (!cleaned) { sse(wrappedRes, 'assistant', { text: '' }); return }
  // Текст уже полный — шлём одним куском, не дробим по 32 символа.
  // Клиент буферизует на 60ms, лишние roundtrip только мешают.
  sse(wrappedRes, 'assistant_delta', { chunk: cleaned })
  sse(wrappedRes, 'assistant', { text: cleaned })
}

// ── LLM Streaming call ──────────────────────────────────────────────────────
async function streamingLLMCall(wrappedRes, step, opts, hooks = {}) {
  const directToolNameRe = DIRECT_TOOL_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const OPEN_RE  = new RegExp(`<(?:x?ai:function_call|tool_use|function_call|thinking|thought|think|${directToolNameRe})([^>]*)>`, 'i')
  const DIRECT_OPEN_RE = new RegExp(`<(${directToolNameRe})([^>]*)>`, 'i')
  const GENERIC_CLOSE_RE = /<\/(?:x?ai:function_call|tool_use|function_call|thinking|thought|think)>/i
  let scanBuf = '', visibleTextBuf = '', insideXml = false, xmlTagName = '', xmlOpenAttrs = ''
  const preParsedCalls = []
  const nativePreviewed = new Set()

  function safeJson(text) { try { return JSON.parse(text) } catch { return {} } }

  function emitBufferedThought(extra = '') {
    if (_textFlushTimer) { clearTimeout(_textFlushTimer); _textFlushTimer = null }
    const text = `${visibleTextBuf || ''}${extra || ''}`
    visibleTextBuf = ''
    if (text.trim()) sse(wrappedRes, 'thought', { step, text })
  }

  function tryConsumeMarkdownShellFence() {
    const open = scanBuf.search(/```(?:bash|sh|shell)\s*\n/i)
    if (open < 0) return false
    const before = scanBuf.slice(0, open)
    const rest = scanBuf.slice(open)
    const openMatch = rest.match(/^```(?:bash|sh|shell)\s*\n/i)
    if (!openMatch) return false

    if (before) emitBufferedThought(before)
    else if (visibleTextBuf) emitBufferedThought()

    const closeIdx = rest.indexOf('```', openMatch[0].length)
    if (closeIdx < 0) {
      // Hold the partial markdown command until the closing fence arrives;
      // do not leak it as assistant_delta.
      scanBuf = rest
      return true
    }

    const fullFence = rest.slice(0, closeIdx + 3)
    const command = extractMarkdownShellCommand(fullFence)
    scanBuf = rest.slice(closeIdx + 3)
    if (command) {
      const parsed = { kind: 'tool', tool: 'shell', args: { action: 'run', command } }
      preParsedCalls.push(parsed)
      sse(wrappedRes, 'tool_preview', { step, name: parsed.tool, args: parsed.args })
      hooks.onParsedCall?.(parsed)
      return true
    }

    // Not a real command after all — render it normally.
    visibleTextBuf += fullFence
    flushVisibleText(true)
    return true
  }

  function parseXmlBody(body, tagName, openAttrs) {
    return parseXmlToolBody(body, tagName, openAttrs)
  }

  // Server-side text buffer: accumulate small chunks before emitting SSE.
  // DeepSeek and some providers emit 1-4 char chunks; flushing each one
  // creates a separate SSE frame → client renders as separate messages on
  // slow mobile connections. Buffer at least 20 chars OR 30ms, whichever first.
  let _textFlushTimer = null
  const TEXT_FLUSH_MIN_CHARS = 50   // минимум символов перед отправкой SSE
  const TEXT_FLUSH_MAX_MS    = 220  // hold briefly so pre-tool narration can be emitted as thought, not final text

  function flushVisibleText(force = false) {
    if (!visibleTextBuf) return
    if (!force && visibleTextBuf.length < TEXT_FLUSH_MIN_CHARS) {
      // Schedule a forced flush so we never hold longer than MAX_MS
      if (!_textFlushTimer) {
        _textFlushTimer = setTimeout(() => { _textFlushTimer = null; flushVisibleText(true) }, TEXT_FLUSH_MAX_MS)
      }
      return
    }
    if (_textFlushTimer) { clearTimeout(_textFlushTimer); _textFlushTimer = null }
    const text = visibleTextBuf
    visibleTextBuf = ''
    if (preParsedCalls.length > 0 || insideXml || nativePreviewed.size > 0) sse(wrappedRes, 'thought', { step, text })
    else sse(wrappedRes, 'assistant_delta', { step, chunk: text })
  }

  function consumeChunk(chunk) {
    scanBuf += chunk
    while (true) {
      if (!insideXml) {
        if (tryConsumeMarkdownShellFence()) continue
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
        if (before) emitBufferedThought(before)
        xmlTagName = m[0].replace(/[<>]/g, '').split(' ')[0]
        xmlOpenAttrs = m[1] || ''
        insideXml = true; scanBuf = scanBuf.slice(m.index + m[0].length)
      } else {
        const direct = isDirectToolTag(xmlTagName)
        const closeRe = direct
          ? new RegExp(`</${String(xmlTagName).replace(/^x?ai:/i, '')}>`, 'i')
          : GENERIC_CLOSE_RE
        let m = scanBuf.match(closeRe)
        let autoClosedByNextTool = false
        if (!m && direct) {
          const next = scanBuf.match(DIRECT_OPEN_RE)
          if (next && next.index > 0) {
            m = { index: next.index, 0: '' }
            autoClosedByNextTool = true
          }
        }
        if (!m) return
        const body = scanBuf.slice(0, m.index)
        scanBuf = scanBuf.slice(m.index + (autoClosedByNextTool ? 0 : m[0].length))
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
      if (visibleTextBuf) flushVisibleText(true)
      sse(wrappedRes, 'tool_preview', { step, sub: idx, name, args: safeJson(tc.argsBuf || '{}') })
    },
    onUsage: (u) => hooks.onUsage?.(u),
  })
  if (insideXml && isDirectToolTag(xmlTagName)) {
    const parsed = parseXmlBody(scanBuf, xmlTagName, xmlOpenAttrs)
    scanBuf = ''; insideXml = false; xmlTagName = ''; xmlOpenAttrs = ''
    if (parsed?.kind === 'tool') {
      preParsedCalls.push(parsed)
      sse(wrappedRes, 'tool_preview', { step, name: parsed.tool, args: parsed.args })
      hooks.onParsedCall?.(parsed)
    }
  }
  if (scanBuf) { visibleTextBuf += scanBuf; scanBuf = '' }
  if (visibleTextBuf) flushVisibleText(true)  // force-flush remaining buffer
  if (_textFlushTimer) { clearTimeout(_textFlushTimer); _textFlushTimer = null }
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
  sse(wrappedRes, 'agent_context', { deterministicAction: { id: action.id, tool: action.tool, reason: action.reason, risk: action.risk }, task: { type: action.id, complexity: 'low' } })
  // Privileged Agent Runtime Platform — approvals permanently disabled
  const r = await invokeTool(action.tool, action.args || {}, { userId, chatId })
  sse(wrappedRes, 'tool_result', { step: 0, sub: 0, name: action.tool, ok: !!r.ok, result: r.result, error: r.error, structured: normalizeToolResult(action.tool, r, { step: 0, sub: 0 }), compact: true })
  const fileEvents = await recordToolWorkspaceEvents({ tool: action.tool, args: action.args || {}, result: r.result || {}, ok: !!r.ok, step: 0, sub: 0 }).catch(() => [])
  if (fileEvents.length) sse(wrappedRes, 'file_change', { step: 0, sub: 0, name: action.tool, events: fileEvents, summary: { count: fileEvents.length, paths: fileEvents.map((e) => e.path).slice(0, 20) } })
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
function finalizeRun({ runLog, sseTrace, history, finalStatus, reason, step, maxSteps: _maxSteps, recentToolHistory, agentContext: _agentContext, res: _res, startTime, route = '/api/agent/chat', userId = '', chatId = '', activeProvider = null }) {
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
    // D — save useful memories after a successful run
  if (reason === 'final' && userId) {
    const _userText = ([...history].reverse().find(m => m?.role === 'user')?.content || '').slice(0, 200)
    autoSaveMemory(userId, recentToolHistory, _userText, { chatId, provider: activeProvider, history }).catch(() => {})
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

async function runAgentInner({ provider, history = [], maxSteps: maxStepsArg = 0, extraSystem = '', userId = '', workspaceScope = '', res, runId: runIdOpt = '', taskType: taskTypeOpt = '' }) {
  // UI slider overrides DEFAULT_MAX_STEPS when user set it explicitly (maxSteps > 0)
  const { getParams } = await import('./db.js').then(m => m)
  const _params = (() => { try { return getParams() } catch { return {} } })()
  const _uiMaxSteps = Number(_params.maxSteps || 0)
  const maxSteps = _uiMaxSteps > 0 ? _uiMaxSteps : (maxStepsArg > 0 ? maxStepsArg : DEFAULT_MAX_STEPS)
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
  sse(wrappedRes, 'stream_protocol', { version: 1, events: ['stream_protocol', 'agent_context', 'agent_task', 'agent_state', 'thinking', 'thinking_delta', 'assistant_delta', 'assistant', 'thought', 'tool_preview', 'tool_router', 'tool_start', 'tool_progress', 'tool_result', 'file_change', 'tool_diagnostic', 'ask_user', 'usage', 'done', 'error'] })

  if (chatId) {
    const existing = activeRunsByChat.get(chatId)
    if (existing) {
      // #42 FIX: Instead of blocking, automatically abort the previous run
      // and start the new one. This prevents the "Request already running" error.
      try {
        existing.abortCtl.abort('superseded by new request')
      } catch { /* ignore */ }
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
    sse(wrappedRes, 'error', { message: 'Provider not configured', finalStatus })
    sseDone(wrappedRes, { steps: 0, reason: 'no-provider', finalStatus }, tokens)
    finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'no-provider', step: 0, maxSteps: 0, recentToolHistory: [], agentContext: {}, res, startTime, route: '/api/agent/chat' })
    res.end()
    if (chatId) activeRunsByChat.delete(chatId)
    return
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
    const map = loadCustomToolsFor(userId)
    if (map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length) extraTools = map
  } catch { /* best-effort: ignore */ }

  // Classify FIRST so the system prompt can match the task weight:
  // low-complexity (greeting / single question) gets the lite prompt
  // (~2.5k tokens) instead of the full 16k-token engineering prompt.
  const agentContext = buildAgentContext({ provider, history, extraSystem, userId, workspaceScope, maxSteps })
  let serverRoute = routeHistory(history, { forceAgent: Boolean(provider.forceAgent) })

  // Dynamic Autopilot Routing (Initial Plan Turn) - like Arena.ai:
  const isAutopilot = provider && (provider.model === 'autopilot' || provider.isAutopilot)
  if (isAutopilot) {
    const autoModel = getAutopilotModelForTurn({ step: 1, recentToolHistory: [], userId })
    if (autoModel) {
      const { listKeys } = await import('./db.js')
      const keys = listKeys()
      const matchedKey = keys.find(k => k.model === autoModel || (k.availableModels && k.availableModels.includes(autoModel)))
      if (matchedKey) {
        provider = { ...matchedKey, model: autoModel, isAutopilot: true }
        sse(wrappedRes, 'thought', { text: `🤖 [Autopilot] Автоматически выбрана оптимальная модель для планирования: ${autoModel}` })
      }
    }
  }

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

  // Full Agent Mode is the default runtime: even CHAT/WEB-classified turns enter
  // the agent loop and keep tool access. The lightweight no-tools route is kept
  // only as an explicit opt-in escape hatch for deployments that want cheaper
  // simple chat turns.
  const lightweightRouteEnabled = String(process.env.BROWSERAI_LIGHTWEIGHT_ROUTE || '0').toLowerCase() === '1'
  if (lightweightRouteEnabled && provider.baseUrl !== 'mock' && !provider.forceAgent && (serverRoute.mode === 'chat' || serverRoute.mode === 'web')) {
    sse(wrappedRes, 'agent_context', { ...agentContext, serverRoute })
    let escalated = false
    try {
      await runLightweightChat({ res, wrappedRes, provider, history, userId, chatId, mode: serverRoute.mode })
    } catch (err) {
      if (err.message === 'escalate-to-agent') {
        escalated = true
        sse(wrappedRes, 'thought', { step: 0, text: '🔄 Автоматическая эскалация: Обнаружен вызов инструментов в режиме чата. Повышаю режим до полноценного Режима Агента для безопасного выполнения!' })
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

  const liteRun = agentContext?.task?.complexity === 'low'
  const toolProfile = toolProfileForTask(agentContext?.task)
  const activeToolNames = liteRun ? null : profileToolNames(toolProfile)
  const allowedToolSet = activeToolNames ? new Set(activeToolNames) : null

  let useNativeTools = supportsNativeTools(provider.baseUrl)
  let systemPrompt = await buildSystemPrompt({ extraSystem, native: useNativeTools, extraTools, chatId, lite: liteRun, toolNames: activeToolNames })
  // buildConsolidatedNativeSpec уже импортирован статически (см. импорты вверху файла).
  // Передаём extraTools чтобы кастомные инструменты попали в native spec.
  let toolsSpec = useNativeTools ? (liteRun ? buildNativeToolsSpec(extraTools, { lite: true, toolNames: activeToolNames }) : buildConsolidatedNativeSpec(extraTools)) : undefined

  const convo = [{ role: 'system', content: systemPrompt }, ...history]
  const deadline = Date.now() + DEFAULT_DEADLINE_MS
  let step = 0, aborted = false
  res.on('close', () => { aborted = true; currentAbortCtl.abort('client closed') })

  // effectiveMaxSteps может быть больше запрошенного (задача классифицирована как сложная).
  // Создаём отдельную переменную, чтобы не мутировать параметр функции.
  let effectiveMaxSteps = Math.max(maxSteps, agentContext.runtime.effectiveMaxSteps || 0)
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
      if (lessons?.text) {
        // A — strip closing tag from lessons.md content (agent-written, could contain injection)
        const safeLessonsText = String(lessons.text).replace(/<\/arena-system-message>/gi, '')
        convo.push({ role: 'user', content: `<arena-system-message>\nLessons Learned (from .browserai/lessons.md):\n${safeLessonsText}\n</arena-system-message>` })
      }
    } catch { /* ignore */ }
  }

  // wrappedRes: keep-alive пинги должны проходить через trace-wrapper
  // чтобы попадать в sseTrace и replay artifact.
  const keepAliveInterval = setInterval(() => sseKeepAlive(wrappedRes), 15_000)
  res.on('close', () => clearInterval(keepAliveInterval))

  // recentToolHistory: хранит до TOOL_HISTORY_MAX записей.
  // D — Auto-recall: inject relevant memories from past sessions before step 1
  if (userId && !liteRun) {
    try {
      const { recallMemory } = await import('./semanticMemory.js')
      const lastUserMsg = String(([...history].reverse().find(m => m?.role === 'user')?.content) || '').slice(0, 400)
      const memBlocks = []
      // Project-memory (chat-scoped): stack, server, deploy commands etc.
      const projectMem = renderProjectMemoryForPrompt(userId, chatId)
      if (projectMem) memBlocks.push(projectMem)
      // Semantic cross-session recall
      if (lastUserMsg) {
        const recalled = await recallMemory(userId, lastUserMsg, { topK: 3 })
        if (recalled.length > 0) {
          memBlocks.push(`# Из памяти предыдущих сессий
${recalled.map(r => '- ' + r.text).join('\n')}`)
        }
      }
      if (memBlocks.length > 0) {
        const memBlock = memBlocks.join('\n\n')
        const firstUserIdx = convo.findIndex(m => m.role === 'user')
        if (firstUserIdx >= 0) {
          convo[firstUserIdx] = { ...convo[firstUserIdx], content: memBlock + '\n\n' + String(convo[firstUserIdx].content || '') }
        }
      }
    } catch { /* best-effort: memory unavailable */ }
  }

  // Без ограничения на runs с maxSteps=60 список мог вырасти до 60×N записей.
  // Obligation/stuck/evidence checks используют последние записи — cap не теряет важного контекста.
  const TOOL_HISTORY_MAX = 120
  const recentCallFingerprints = [], recentCallFamilies = [], recentToolHistory = [], planState = { done: new Set() }
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
  let shellFirstPushbackCount = 0
  // Capped pushback counters — previously these fired EVERY step when
  // triggered, which caused infinite loops with models that re-stated
  // their answer without tool calls. Now each pushback is bounded.
  const MAX_PUSHBACK_PER_KIND = 2
  let unappliedCodePushbackCount = 0
  let noToolsPushbackCount = 0
  // reflectionDone: флаг вместо O(N) convo.some() на каждом шаге
  let reflectionDone = false
  const obligationPushbacks = new Map()
  let pushedBackThisTurn = false
  let consecutiveFailures = 0
  const budget = createRetryBudget()
  let lastPhaseChangeStep = 0

  try {
    while (step < effectiveMaxSteps) {

      if (Date.now() > deadline) {
        const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps: effectiveMaxSteps, reason: 'deadline', userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
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
      const escalation = shouldEscalate({ stuck, budget, step, maxSteps: effectiveMaxSteps })
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
        const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps: effectiveMaxSteps, reason: 'cap-reached', userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
        sse(wrappedRes, 'error', { message: capCheck.reason, finalStatus })
        sseDone(wrappedRes, { steps: step, reason: 'cap-reached', finalStatus }, tokens)
        finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'cap-reached', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' })
        clearInterval(idleWatchdog)
        clearInterval(keepAliveInterval)
        res.end()
        return
      }

      // Dynamic Autopilot Sibling Routing (Turn-by-turn Cascade) - like Arena.ai:
      if (isAutopilot) {
        const autoModel = getAutopilotModelForTurn({ step, recentToolHistory, userId })
        if (autoModel && provider.model !== autoModel) {
          const { listKeys } = await import('./db.js')
          const keys = listKeys()
          const matchedKey = keys.find(k => k.model === autoModel || (k.availableModels && k.availableModels.includes(autoModel)))
          if (matchedKey) {
            provider = { ...matchedKey, model: autoModel, isAutopilot: true }
            sse(wrappedRes, 'thought', { step, text: `🤖 [Autopilot] Переключаюсь на оптимальную модель для этого шага: ${autoModel}` })
          }
        }
      }

      const routing = shouldUseCheapEditor({ provider, step, recentToolHistory, userId })
      let activeProvider = routing.useCheap ? wrapProviderForEditor(provider, routing.cheapModel) : provider
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
          messages: redactConvo(messagesWithCache),  // mask tokens before LLM
          temperature: Number(activeProvider.temperature ?? 0.3),
          signal: currentAbortCtl.signal,
          ...(useNativeTools ? { tools: toolsSpec, toolChoice: 'auto' } : {})
        }
        if (useStream) {
          reply = await streamingLLMCall(wrappedRes, step, llmArgs, { onUsage: (u) => accumulateUsage(u) })
          streamedFinalAnswer = !reply.toolCalls?.length && !reply.preParsedCalls?.length
        } else {
          // A4 — heartbeat for non-streaming providers (DeepSeek, Gemini):
          // send agent_state every 3s so user sees the model is thinking, not frozen
          const _hbInterval = setInterval(() => {
            try {
              sse(wrappedRes, 'agent_state', {
                ...agentState,
                status: 'thinking',
                currentStep: `⏳ Модель обрабатывает запрос… (шаг ${step})`,
                watchdog: true,
              })
            } catch { /* best-effort — connection may have closed */ }
          }, 3000)
          _hbInterval?.unref?.()  // S1-D1: don't hold process open for heartbeat timer
          try {
            reply = await callLLM(llmArgs)
          } finally {
            clearInterval(_hbInterval)
          }
          accumulateUsage(reply?.usage)
        }
      } catch (e) {
        const providerError = normalizeProviderError(e, { baseUrl: provider.baseUrl, model: provider.model, phase: 'agent-llm-call' })
        // C — try fallback provider before giving up
        if (isTransientProviderError(providerError) && !aborted) {
          try {
            const fallback = await resolveNextProvider(activeProvider, providerError)
            if (fallback) {
              const src = fallback._fallbackSource || 'fallback'
              sse(wrappedRes, 'thought', { step, text: `⚡ Провайдер ${activeProvider.model} недоступен. Переключаюсь на ${fallback.model || src}…` })
              activeProvider = fallback
              currentModel = fallback.model || currentModel
              pushedBackThisTurn = false  // S2-C1: reset pushback state for retry on new provider
              continue  // retry this step with the new provider
            }
          } catch { /* fallback resolution failed — fall through to error */ }
        }
        const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps: effectiveMaxSteps, reason: 'llm-error', error: providerError, userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
        // LLM-timeout recovery: если watchdog сработал, но ВСЕ obligations
        // уже закрыты и был реальный progress — считаем задачу выполненной.
        // Иначе UI показывает "error" хотя фактически работа сделана.
        const isWatchdogTimeout = /idle watchdog timeout|aborted/i.test(String(providerError?.message || ''))
        const obligationsSatisfied = (() => {
          const obs = agentState?.obligationStatus || {}
          const required = agentContext?.task?.obligations || {}
          return Object.entries(required).every(([k, v]) => !v || obs[k] === true)
        })()
        if (isWatchdogTimeout && obligationsSatisfied && (finalStatus.evidenceSummary?.filesChanged > 0 || finalStatus.evidenceSummary?.commandsRun > 0)) {
          finalStatus.taskCompleted = true
          finalStatus.blockers = []
          sse(wrappedRes, 'thought', { step, text: 'LLM-таймаут после выполненной работы — закрываю как успех (obligations все ✓).' })
        }
        sse(wrappedRes, 'error', { message: 'LLM failed: ' + safeErrorMessage(providerError.message), providerError: safeProviderError(providerError), finalStatus })
        sseDone(wrappedRes, { steps: step, reason: 'llm-error', finalStatus }, tokens)
        finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'llm-error', step, maxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' })
        clearInterval(idleWatchdog)
        clearInterval(keepAliveInterval)
        res.end()
        return
      }

      res.__agentPhase = 'agent'
      res.__agentActiveTool = ''

      let spendNote = null
      try { spendNote = recordSpend({ userId, chatId, model: activeProvider.model, usage: reply?.usage || {} }) } catch { /* best-effort: ignore */ }
      if (reply?.usage) sse(wrappedRes, 'usage', { step, ...reply.usage, totals: { ...tokens }, cost: spendNote?.cost || 0 })

      const toolExists = (name) => Boolean(TOOLS[name] || (extraTools && extraTools[name]) || isConsolidatedTool(name))
      const turn = resolveAgentTurn({
        reply,
        useNativeTools,
        correctToolName,
        toolExists,
        agentContext,
        recentToolHistory,
        history,
        noToolsPushbackCount,
        unappliedCodePushbackCount,
        maxPushbacks: MAX_PUSHBACK_PER_KIND,
        pushedBackThisTurn,
        aborted,
      })
      let calls = turn.kind === 'tool_calls' ? [...turn.calls] : []

      if (calls.length === 0) {
        if (turn.kind === 'pushback') {
          if (turn.code === 'unapplied_code') unappliedCodePushbackCount++
          else noToolsPushbackCount++
          pushedBackThisTurn = true
          if (turn.thought) sse(wrappedRes, 'thought', { step, text: turn.thought })
          convo.push({ role: 'user', content: turn.userPrompt }); continue
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
        if (didRealWork && !reflectionDone && !aborted) {
          // Hard 20s cap: reflection is advisory — a hanging provider call
          // here must never block stream completion (same spinner-hang class).
          const verdict = await Promise.race([
            runReflectionCheck({ provider, ask: lastUserAsk, draft: reply.text || '', toolHistory: recentToolHistory }),
            new Promise((r) => setTimeout(() => r(null), 20_000)),
          ]).catch(() => null)
          reflectionDone = true
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

        const preFinalStatus = buildFinalStatus({
          agentContext,
          recentToolHistory,
          agentState,
          aborted,
          step,
          maxSteps: effectiveMaxSteps,
          reason: 'final',
          userText: [...history].reverse().find((m) => m.role === 'user')?.content || '',
          failedReadPaths,
          okReadPaths,
          claimIssues: null,
        })
        const finalTextWithEvidence = didRealWork ? composeEvidenceBackedFinal({ draft: reply.text || '', agentContext, recentToolHistory, agentState, finalStatus: preFinalStatus }) : (reply.text || '')
        // Anti-hallucination: проверяем claims финального ответа против реальных tool results.
        // Если найдены серьёзные расхождения (severity=error) — добавляем в финал блок предупреждения.
        const failedCommands = new Set(recentToolHistory.filter((h) => !h.ok).map((h, i) => `${i}:${h.tool}`))
        const claimCheck = validateFinalClaims(finalTextWithEvidence, {
          okReadPaths,
          failedReadPaths,
          touchedFiles: agentState.touchedFiles || new Set(),
          recentToolHistory,
          failedCommands,
        })
        if (!claimCheck.verified && claimCheck.issues.length > 0) {
          // Keep self-check findings structured in finalStatus/evidence. Do not
          // append raw anti-hallucination diagnostics into the user-visible
          // final answer; that made the chat look like an internal debug log.
          if (streamedFinalAnswer) {
            sse(wrappedRes, 'assistant', { text: finalTextWithEvidence })
          } else {
            await streamFinalAnswer(wrappedRes, finalTextWithEvidence)
          }
          agentState.claimIssues = claimCheck.issues
        } else {
          if (streamedFinalAnswer) {
            // Текст уже был отправлен дельтами во время стриминга.
            // Отправляем финальный assistant-ивент с полным текстом + evidence,
            // чтобы UI мог обновить сообщение (добавить runtime evidence блок).
            sse(wrappedRes, 'assistant', { text: finalTextWithEvidence })
          } else {
            await streamFinalAnswer(wrappedRes, finalTextWithEvidence)
          }
        }

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
          maxSteps: effectiveMaxSteps,
          reason: 'final',
          userText: [...history].reverse().find((m) => m.role === 'user')?.content || '',
          failedReadPaths,
          okReadPaths,
          claimIssues: agentState.claimIssues || null,
        })
        try { if (persistedTask) finishAgentTask(persistedTask.id, { status: finalStatus.taskCompleted ? 'succeeded' : (isBlocked(finalStatus) ? 'blocked' : 'partial'), state: agentState, history: convo, finalStatus }) } catch { /* best-effort */ }
        sseDone(wrappedRes, { steps: step, reason: 'final', finalStatus }, tokens)
        finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'final', step, maxSteps: effectiveMaxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' })
        res.end()
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

      if (!aborted && shouldPushShellFirst({ calls, agentContext, already: shellFirstPushbackCount })) {
        shellFirstPushbackCount++
        sse(wrappedRes, 'thought', { step, text: 'Слишком много мелких file/verify вызовов. Перехожу на один компактный shell-шаг.' })
        convo.push({
          role: 'user',
          content: shellFirstPushbackMessage(),
        })
        continue
      }

      // ── Parallel safe reads (Arena-style) ─────────────────────────────────
      // Pure read-only tools (read_file, search_files, list_files, web_search,
      // web_fetch, recall_facts, kb_search) have no shared mutable state.
      // When ALL calls in a turn are read-only we run them in parallel, matching
      // Arena's behaviour and cutting wall-clock latency for multi-file reads.
      // ANY write/shell/git/ops call in the batch forces full sequential mode
      // to preserve the write→read ordering invariant.
      const SAFE_PARALLEL_TOOLS = new Set([
        'read_file','list_files','search_files','web_search','web_fetch',
        'recall_facts','kb_search','kb_list','git_status','docker_ps',
        'docker_logs','ops_list_services','file_history','secret_scan',
        'get_agent_result','shell_background_read','shell_background_list',
      ])
      const SAFE_PARALLEL_FAMILIES = new Set(['web', 'kb', 'memory'])
      const allSafeParallel = calls.every((c2) => {
        if (c2.unknown) return false
        const sem = c2.semantic || runtimeSemantics({ tool: c2.tool, args: (() => { try { return JSON.stringify(c2.args || {}) } catch { return '{}' } })(), outcome: '' })
        if (SAFE_PARALLEL_TOOLS.has(c2.tool)) return true
        if (SAFE_PARALLEL_FAMILIES.has(sem.family) && sem.action !== 'write' && sem.action !== 'edit' && sem.action !== 'delete') return true
        // consolidated file read
        if (c2.tool === 'file' && ['read','list','search','snapshot_list'].includes(c2.args?.action)) return true
        return false
      })

      // Кешируем на уровне шага (не вызова) — экономия I/O при нескольких tool calls за шаг
      const [stepProjectRules, stepRecentActivity] = await Promise.all([
        withWorkspaceScope(chatId, () => readProjectRules().catch(() => '')),
        withWorkspaceScope(chatId, () => listRecentWorkspaceActivity({ sinceMs: 24 * 60 * 60 * 1000 }).catch(() => [])),
      ])
  const stepRecentActivityStr = stepRecentActivity.map(a => `${a.reason} ${a.path}`).join(', ')
  const results = []

  // Executor for a single call — extracted to reuse in both parallel/sequential paths
      const executeOneCall = async (call, idx, { isParallel = false } = {}) => {
        const currentFingerprint = callFingerprint(call)
        const currentFamily = callFamily(call)
        recentCallFingerprints.push(currentFingerprint); if (recentCallFingerprints.length > 20) recentCallFingerprints.shift()
        recentCallFamilies.push(currentFamily); if (recentCallFamilies.length > 20) recentCallFamilies.shift()
        if (violatesPreDeployVerifyCall(call, recentToolHistory)) return { call, r: makeToolErrorResult('Blocked: verify_code required.'), pushedBack: true }
        if (isStuckLoop(recentCallFingerprints, currentFingerprint, recentCallFamilies, currentFamily)) {
          return {
            call,
            r: {
              ok: false,
              error: `Stuck in loop: ты уже ${SIMILAR_STUCK_THRESHOLD}+ раз вызываешь похожие команды (${currentFamily.slice(0, 80)}). Попробуй ДРУГОЙ подход: прочитай документацию, спроси пользователя через ask_user, или сделай вывод о blocker.`,
              result: null,
            },
            pushedBack: true,
          }
        }

        if (call.unknown) {
          // allowedToolSet может быть null (liteRun без профиля) — защищаем spread
          const toolList = allowedToolSet ? [...allowedToolSet].join(', ') : Object.keys(TOOLS).join(', ')
          const rErr = makeToolErrorResult(`Инструмент "${call.tool}" не существует. Пожалуйста, используйте только разрешенные инструменты: ${toolList}`)
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        const checkTool = call.semantic?.tool || call.tool
        if (!isToolAllowed(checkTool, allowedToolSet, extraTools)) {
          const toolList = allowedToolSet ? [...allowedToolSet].join(', ') : 'all tools'
          const rErr = makeToolErrorResult(`Tool ${checkTool} is not available in the current ${toolProfile} tool profile. Use one of: ${toolList}`)
          sse(wrappedRes, 'tool_router', { step, sub: idx, name: call.tool, warnings: [rErr.error] })
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        if (!isToolAllowed(checkTool, currentPhaseAllowedSet, extraTools)) {
          const allowed = currentPhaseAllowedSet ? [...currentPhaseAllowedSet].join(', ') : 'all profile tools'
          const rErr = makeToolErrorResult(`Tool ${checkTool} is blocked in phase ${currentPhase}. Use one of: ${allowed}`)
          sse(wrappedRes, 'tool_router', { step, sub: idx, name: call.tool, warnings: [rErr.error], phase: currentPhase })
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        const validation = validateToolCall(call.tool, call.args || {}, { ...TOOLS, ...extraTools }[call.tool])
        if (!validation.ok) {
          if (!pushedBackThisTurn && !aborted) {
            if (!isParallel) pushedBackThisTurn = true  // P1: don't mutate shared state in parallel
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
        if (false) { /* Privileged Runtime — approvals OFF */
          // approval disabled, question: `Approve ${call.tool}?`, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }] })
          
          // Если ЛЮБОЙ ответ истёк по таймауту — считаем tool неуспешным,
          // чтобы агент пошёл в recovery / pushback, а не завис на 10 минут.
          const timedOut = answers.some((a) => a && a.timedOut)
          const anyError = answers.some((a) => a && a.ok === false)
          if (timedOut || anyError) {
            const errMsg = timedOut
              ? 'ask_user timeout: пользователь не ответил. Продолжай с разумным default (например, выбери самый безопасный вариант или отметь ask_user как blocked) — НЕ повторяй ask_user снова для этого же вопроса.'
              : `ask_user error: ${answers.find((a) => a && a.ok === false)?.error || 'unknown'}`
            r = { ok: false, error: errMsg, result: { answers, timedOut } }
          } else {
            r = { ok: true, result: answers.length === 1 ? answers[0].answer : { answers } }
          }
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
              _projectRules: stepProjectRules,
              _recentActivity: stepRecentActivityStr
            }, { 
              signal: currentAbortCtl.signal, 
              onStdout: (c) => sse(wrappedRes, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stdout', chunk: String(c).slice(0, 2000) }), 
              onStderr: (c) => sse(wrappedRes, 'tool_progress', { step, sub: idx, name: call.tool, kind: 'stderr', chunk: String(c).slice(0, 2000) }), 
              userId, chatId, extraTools 
            })
          }
        }
        const semanticOk = toolSucceeded(call.tool, r, call.args)
        if ('privileged' !== 'ask') {
          if (!semanticOk) {
            consecutiveFailures++
          } else {
            consecutiveFailures = 0
          }
        }
        if (!semanticOk && !pushedBackThisTurn && !aborted && 'privileged' !== 'ask') {
          const semanticError = r.ok ? summarizeToolOutcome(call.tool, r, call.args) : r.error
          const recovery = getRecoveryAction({ tool: call.tool, error: semanticError, result: r.result, args: call.args, recentToolHistory })
          const hint = recovery?.message || getRecoveryHint(call.tool, semanticError, call.args, recentToolHistory)
          if (hint) {
            if (!isParallel) pushedBackThisTurn = true  // P1
            sse(wrappedRes, 'thought', { step, sub: idx, text: `ОШИБКА: ${call.tool} — ${semanticError}. Исправляю…` })
            const rErr = makeToolErrorResult(`[exec_error] ${semanticError}.\n\nREQUIRED ACTION TO RECOVER:\n${hint}\n\nExecute this action now.`)
            rErr.result = r.result
            sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, result: r.result, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
            return { call, r: rErr, pushedBack: true }
          }
          if (!isParallel) pushedBackThisTurn = true  // P1
          sse(wrappedRes, 'thought', { step, sub: idx, text: `Ошибка выполнения: ${call.tool} — ${semanticError}. Пробую восстановиться.` })
          const rErr = makeToolErrorResult(`[exec_error] ${semanticError}`)
          rErr.result = r.result
          sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: false, result: r.result, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }
        const stateResult = semanticOk ? r : { ...r, ok: false, error: r.error || summarizeToolOutcome(call.tool, r, call.args) }
        // updateAgentStateFromTool handles underlying names (plan_set, plan_check),
        // but the loop receives the consolidated 'plan' name. Expand here so
        // agentState.plan / .plan.done stay in sync with the actual tool outcome.
        const expForState = expandConsolidatedCall(call.tool, call.args)
        const stateToolName = (expForState && !expForState.error && expForState.name) ? expForState.name : call.tool
        updateAgentStateFromTool(agentState, stateToolName, stateResult, call.args)
        agentState.obligationStatus = obligationCompletionStatus(agentState.obligations || {}, recentToolHistory)
        try { if (persistedTask) updateAgentTask(persistedTask.id, { phase: agentState.phase || currentPhase, state: agentState, history: convo }) } catch { /* best-effort */ }
        sse(wrappedRes, 'tool_result', { step, sub: idx, name: call.tool, ok: semanticOk, result: r.result, error: semanticOk ? r.error : (r.error || summarizeToolOutcome(call.tool, r, call.args)), structured: normalizeToolResult(call.tool, stateResult, { step, sub: idx }) })
        const fileEvents = await recordToolWorkspaceEvents({ tool: call.tool, args: call.args || {}, result: r.result || {}, ok: semanticOk, step, sub: idx, runId: runLog?.runId || '' }).catch(() => [])
        if (fileEvents.length) {
          sse(wrappedRes, 'file_change', { step, sub: idx, name: call.tool, runId: runLog?.runId || '', events: fileEvents, summary: { count: fileEvents.length, paths: fileEvents.map((e) => e.path).slice(0, 20) } })
        }
        sse(wrappedRes, 'agent_state', agentState)
        res.__agentPhase = 'agent'
        res.__agentActiveTool = ''
        return { call, r, semanticOk }
      }

      // ── Dispatch: parallel for safe-reads, sequential otherwise ────────────
      if (allSafeParallel && calls.length > 1) {
        // Run all read-only calls concurrently
        const parallel = await Promise.all(calls.map((call, idx) => executeOneCall(call, idx, { isParallel: true })))
        // P1: after parallel batch, set pushedBackThisTurn if any call pushed back
        if (parallel.some(r => r?.pushedBack)) pushedBackThisTurn = true
        results.push(...parallel)
      } else {
        // Sequential (default) — preserves write→read ordering
        for (let idx = 0; idx < calls.length; idx++) {
          results.push(await executeOneCall(calls[idx], idx))
        }
      }

      let sawPushBack = false
      // Переименовываем итератор: `res` — занято внешним Express response объектом.
      // Shadowing вызывал бы неочевидные баги если бы внутри понадобился res.end().
      for (const toolRes of results) {
        if (toolRes?.pushedBack) sawPushBack = true
        if (toolRes?.call && toolRes?.r) {
          const semanticOk = typeof toolRes.semanticOk === 'boolean' ? toolRes.semanticOk : !!toolRes.r.ok
          const historyEntry = normalizeRuntimeHistoryEntry({ tool: toolRes.call.tool, ok: semanticOk, at: Date.now(), args: summarizeCallArgsForDigest(toolRes.call.args || {}), outcome: summarizeToolOutcome(toolRes.call.tool, toolRes.r, toolRes.call.args || {}) })
          pushToolHistory(historyEntry)
          const semantic = historyEntry.semantic || runtimeSemantics(historyEntry)
          if (semantic.isRead && semantic.path) { (semanticOk ? okReadPaths : failedReadPaths).add(String(semantic.path)) }
          if ((toolRes.call.tool === 'plan_set' || (toolRes.call.tool === 'plan' && toolRes.call.args?.action === 'set')) && semanticOk) planState.done = new Set()
          // Переименовано checkedIdx — иначе затеняет внешний for-loop idx (строка ~1383)
          else if ((toolRes.call.tool === 'plan_check' || (toolRes.call.tool === 'plan' && toolRes.call.args?.action === 'check')) && semanticOk) (toolRes.r.result?.checked || []).forEach(checkedIdx => planState.done.add(Number(checkedIdx)))
        }
        try {
          if (toolRes?.call && runLog) {
            const sem = runtimeSemantics({ tool: toolRes.call.tool, args: JSON.stringify(toolRes.call.args || {}), outcome: '' })
            runLog.toolCall({ tool: toolRes.call.tool, args: summarizeCallArgsForDigest(toolRes.call.args || {}), ok: typeof toolRes.semanticOk === 'boolean' ? toolRes.semanticOk : !!toolRes.r?.ok, semantic: sem, outcome: summarizeToolOutcome(toolRes.call.tool, toolRes.r || {}, toolRes.call.args || {}), error: toolRes.r?.ok ? null : (toolRes.r?.error || null) })
          }
        } catch { /* ignore log failures */ }
      }
      agentState.obligationStatus = obligationCompletionStatus(agentState.obligations || {}, recentToolHistory)

      // Always feed observations back into the conversation, even for
      // push-back/recovery turns. Otherwise the next LLM step would see the
      // assistant tool call but not the failure/recovery instruction.
      for (const { call, r } of results) {
        let obsRaw = r.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) : 'ERROR: ' + r.error
        let obsContent = clipToolOutput(call.tool, obsRaw, provider?.model)
        // r.result?.dataUrl: для multimodal — передаём объект без dataUrl (не строку obsRaw)
        if (r.ok && r.result?.dataUrl && useNativeTools) {
          const resultWithoutDataUrl = typeof r.result === 'object' ? { ...r.result, dataUrl: undefined } : r.result
          obsContent = [
            { type: 'text', text: clipToolOutput(call.tool, resultWithoutDataUrl, provider?.model) },
            { type: 'image_url', image_url: { url: r.result.dataUrl } },
          ]
        }
        if (call.nativeId) convo.push({ role: 'tool', tool_call_id: call.nativeId, name: call.tool, content: obsContent })
        else {
          // A — sanitize obsContent: strip closing tag to prevent tool-output-based system-message injection
          const safeObs = typeof obsContent === 'string'
            ? obsContent.replace(/<\/arena-system-message>/gi, '')
            : obsContent  // array (multimodal) — no injection path
          convo.push({ role: 'user', content: `<arena-system-message>\nTool result for ${call.tool}:\nok: ${r.ok}\n</arena-system-message>\n${safeObs}` })
        }
      }
      if (sawPushBack) continue

    }
    if (step >= effectiveMaxSteps) {
      const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps: effectiveMaxSteps, reason: 'max-steps', userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
      try { if (persistedTask) finishAgentTask(persistedTask.id, { status: 'blocked', state: agentState, history: convo, finalStatus }) } catch { /* best-effort */ }
      sse(wrappedRes, 'assistant_delta', {
        chunk: `

Я дошёл до лимита выполнения (${effectiveMaxSteps} шагов), но текущее состояние и файлы сохранены. Можно продолжить с этого места — я не буду начинать заново.`,
      })
      sseDone(wrappedRes, { steps: step, reason: 'max-steps', finalStatus }, tokens)
      finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'max-steps', step, maxSteps: effectiveMaxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' })
    }
  } catch (e) {
    const finalStatus = buildFinalStatus({ agentContext, recentToolHistory, agentState, aborted, step, maxSteps: effectiveMaxSteps, reason: 'crash', error: e, userText: [...history].reverse().find((m) => m.role === 'user')?.content || '', failedReadPaths, okReadPaths })
    try { if (persistedTask) finishAgentTask(persistedTask.id, { status: 'failed', state: agentState, history: convo, finalStatus }) } catch { /* best-effort */ }
    sse(wrappedRes, 'error', { message: safeErrorMessage(e), finalStatus })
    sseDone(wrappedRes, { steps: step, reason: 'crash', finalStatus }, tokens)
    finalizeRun({ runLog, sseTrace, history, finalStatus, reason: 'crash', step, maxSteps: effectiveMaxSteps, recentToolHistory, agentContext, res, startTime, route: '/api/agent/chat' })
  } finally {
    clearInterval(idleWatchdog)
    clearInterval(keepAliveInterval)
    if (chatId) activeRunsByChat.delete(chatId)
    try { res.end() } catch { /* best-effort: ignore */ }
  }
}

// ── Token masking for LLM history ────────────────────────────────────────
// Redact secrets (API keys, tokens, passwords) from assistant and system
// messages before sending to LLM. Prevents leaking tokens the LLM might
// "remember" from earlier turns (e.g. if user pasted a token, agent saw
// it once, then we DON'T want it echoed back to the LLM provider repeatedly).
//
// IMPORTANT: user messages are NOT redacted — when the user explicitly
// pastes a token in chat and asks the agent to use it (e.g. "push to GitHub
// with my token ghp_..."), we MUST let the LLM see the real token so it
// can use it in shell commands. Otherwise the agent will write commands
// with <redacted:...> placeholders which fail at execution.
function redactConvo(messages) {
  return messages.map((m) => {
    // user role: пропускаем без изменений — пользователь САМ вставил токен
    if (m.role === 'user') return m
    // assistant + system: маскируем на случай если LLM "запомнил" токен
    if (typeof m.content === 'string') {
      const redacted = redactSecrets(m.content)
      if (redacted === m.content) return m
      return { ...m, content: redacted }
    }
    if (Array.isArray(m.content)) {
      const parts = m.content.map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          const redacted = redactSecrets(part.text)
          return redacted === part.text ? part : { ...part, text: redacted }
        }
        return part
      })
      return { ...m, content: parts }
    }
    return m
  })
}

function sseDone(wrappedRes, payload, tokens) { sse(wrappedRes, 'done', { ...payload, tokens }) }

// D — Auto-save memory: extract useful facts from a completed run
//     Also runs factExtractor (LLM-based) to distill project context into project_memory
async function autoSaveMemory(userId, recentToolHistory, userText, { chatId = '', provider = null, history = [] } = {}) {
  if (!userId || !recentToolHistory?.length) return
  try {
    const { rememberMemory } = await import('./semanticMemory.js')
    const facts = []
    // Remember successful deploy patterns
    const deployOk = recentToolHistory.filter(h => h.ok && h.semantic?.isDeploy)
    if (deployOk.length) {
      const cmd = deployOk[deployOk.length - 1]?.semantic?.command || deployOk[deployOk.length - 1]?.tool || ''
      if (cmd) facts.push(`Деплой сработал: ${cmd.slice(0, 120)}`)
    }
    // Remember what recovered after failures
    const failures = recentToolHistory.filter(h => !h.ok)
    const lastOk = [...recentToolHistory].reverse().find(h => h.ok)
    if (failures.length >= 2 && lastOk && userText) {
      facts.push(`Для задачи "${userText.slice(0, 80)}" помогло: ${lastOk.tool}`)
    }
    for (const fact of facts.slice(0, 3)) {
      await rememberMemory(userId, fact)
    }
  } catch { /* best-effort */ }

  // factExtractor: LLM-based extraction of project context facts
  if (provider?.baseUrl && provider?.apiKey && history.length > 0 && chatId) {
    try {
      const { extractAndStore } = await import('./factExtractor.js')
      const result = await extractAndStore({ userId, chatId, provider, history: history.slice(-6) })
      // Also store extracted facts in project_memory (chat-scoped, fast recall)
      if (result?.facts?.length && chatId) {
        for (const fact of result.facts) {
          const m = fact.match(/^(?:Fact|Decision):\s*(.+)$/i)
          const text = m ? m[1].trim() : fact.trim()
          if (text.length > 10) {
            const key = text.slice(0, 40).replace(/[^a-zA-Z0-9_а-яА-Я\s]/g, '').trim().replace(/\s+/g, '_').toLowerCase()
            if (key) upsertProjectFact(userId, chatId, key, text)
          }
        }
      }
    } catch { /* best-effort */ }
  }
}

export const __test = {
  askedForExplicitLocalTest,
  hasLocalTestAttempt,
  hasSuccessfulLocalTest,
  needsVerificationSinceLastEdit,
  obligationCompletionStatus,
  callFingerprint,
  callFamily,
  isStuckLoop,
  summarizeCallArgsForDigest,
  redactConvo,
}
