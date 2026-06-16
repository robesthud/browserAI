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
import { toolProfileForTask, profileToolNames, isToolAllowed } from './toolAllowlist.js'
import { getRecoveryAction, getRecoveryHint as recoveryHint } from './recoveryEngine.js'
import { buildToolStrategyDirective } from './failurePlaybooks.js'
import { createWorkspaceSnapshot } from './workspaceSnapshots.js'
import { deriveTaskPhase, allowedToolsForPhase } from './taskStateMachine.js'
import { createAgentTask, updateAgentTask, finishAgentTask } from './agentTasks.js'
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
  buildPlanningDirective, buildAutonomousRuntimeDirective, buildGuidedRailsDirective, buildDoneCriteriaDirective, updateAgentStateFromTool,
  validateToolCall, makeToolErrorResult,
} from './agentCore.js'

const DEFAULT_MAX_STEPS = 15
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000
const IDLE_NOTICE_MS = 75 * 1000
const LLM_HARD_IDLE_MS = 2 * 60 * 1000
const activeRunsByChat = new Map()

export function listActiveAgentRuns() {
  return [...activeRunsByChat.entries()].map(([chatId, v]) => ({ chatId, startedAt: v.startedAt, ageMs: Date.now() - Number(v.startedAt || Date.now()) }))
}

export function clearActiveAgentRun(chatId = '') {
  return activeRunsByChat.delete(String(chatId || ''))
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
  return !recentToolHistory.slice(lastEdit + 1).some((h) => h?.ok && ['verify_code', 'npm_test', 'verify_task'].includes(h.tool))
}

function commandLooksLikeHealthCheck(argsText = '') {
  return /(curl|wget|http|health|docker logs|docker ps|compose ps|journalctl|logs)/i.test(String(argsText || ''))
}

function toolCommand(h = {}) {
  const args = parseDigestArgs(h.args)
  return String(args.command || '')
}

function commandMatches(h = {}, re) {
  return ['bash', 'shell_session_run', 'shell_background_start'].includes(h?.tool) && re.test(toolCommand(h))
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

function obligationCompletionStatus(obligations = {}, recentToolHistory = []) {
  const ok = recentToolHistory.filter((h) => h?.ok)
  const hasTool = (...tools) => ok.some((h) => tools.includes(h.tool))
  const hasBash = (re) => ok.some((h) => commandMatches(h, re))
  const edited = ok.some((h) => ['write_file', 'edit_file'].includes(h.tool))
  const verified = hasTool('verify_task', 'verify_code', 'npm_test', 'run_tests') || hasBash(/(npm|pnpm|yarn)\s+(test|run\s+test|run\s+build|build)|vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test/i)
  const status = {
    inspect: hasTool('list_files', 'read_file', 'search_files', 'read_project_rules') || hasBash(/(^|\s)(pwd|ls|find|grep|rg|cat|sed)\b/i),
    codeChange: edited || hasTool('git_commit') || hasBash(/git\s+(apply|commit)|npm\s+version/i),
    verify: verified,
    commit: hasTool('git_commit') || hasBash(/git\s+commit\b/i),
    push: ok.some((h) => h.tool === 'git_commit' && /pushed=true/i.test(String(h.outcome || ''))) || hasBash(/git\s+push\b/i),
    pr: hasTool('github_pr_create') || /pull request|\/pull\//i.test(ok.map((h) => h.outcome).join('\n')) || hasBash(/gh\s+pr\s+create/i),
    deploy: hasTool('ops_run_action') || hasBash(/(deploy\.sh|\bdeploy\b|docker\s+compose\s+up|docker-compose\s+up|systemctl\s+restart|kubectl\s+apply)/i),
    healthCheck: ok.some((h) => ['bash', 'shell_session_run', 'shell_background_start'].includes(h.tool) && commandLooksLikeHealthCheck(h.args)) || hasTool('docker_ps', 'ops_list_services') || hasBash(/curl|wget|health/i),
    logsCheck: hasTool('docker_logs', 'docker_ps') || hasBash(/docker\s+logs|docker\s+ps|journalctl|tail\s+.*log/i),
    finalReport: true,
  }
  if (obligations.codeChange && !edited && recentToolHistory.some((h) => h?.ok && ['git_clone', 'zip_files'].includes(h.tool))) status.codeChange = true
  return status
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
    const args = parseDigestArgs(h.args)
    const p = args.path || args.file_path || ''
    if (h.ok && ['write_file', 'edit_file'].includes(h.tool) && p && !changedFiles.includes(p)) changedFiles.push(p)
    if (h.ok && h.tool === 'read_file' && p && !readFiles.includes(p)) readFiles.push(p)
    if (['bash', 'shell_session_run', 'shell_background_start'].includes(h.tool)) commands.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${args.command || ''} → ${h.outcome || ''}`.slice(0, 500))
    if (['verify_task', 'verify_code', 'npm_test', 'run_tests'].includes(h.tool) || /test|build|verify|exit=0|passed/i.test(String(h.outcome || ''))) checks.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || ''}`)
    if (h.tool.startsWith('git_') || /git\s+(status|diff|commit|push)/i.test(args.command || '')) git.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || args.command || ''}`)
    if (h.tool.startsWith('ops_') || h.tool.startsWith('docker_') || /deploy|docker|curl|health|logs/i.test(`${args.command || ''} ${h.outcome || ''}`)) deploy.push(`${h.ok ? '✓' : '✗'} ${h.tool}: ${h.outcome || args.command || ''}`)
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

function narrateToolCall(tool = '', args = {}, agentContext = {}) {
  const cmd = String(args?.command || '').trim()
  if (tool === 'shell_session_run') return 'Выполняю команду в постоянной shell-сессии: так сохраняются cwd/env и удобнее вести длинную разработческую работу.'
  if (tool === 'shell_background_start') return 'Запускаю долгую команду в фоне, чтобы можно было читать вывод и не блокировать Agent Mode.'
  if (tool === 'shell_background_read') return 'Читаю текущий stdout/stderr фоновой команды.'
  if (tool === 'shell_background_stop') return 'Останавливаю фоновую shell-команду.'
  if (tool === 'shell_session_reset') return 'Сбрасываю постоянную shell-сессию, чтобы восстановить чистое состояние.'
  if (tool === 'bash') {
    if (/npm\s+(test|run test)|pnpm\s+test|yarn\s+test|vitest|jest/i.test(cmd)) return 'Запускаю тесты через bash, чтобы подтвердить изменения реальным выводом.'
    if (/npm\s+run\s+build|pnpm\s+build|yarn\s+build|vite build/i.test(cmd)) return 'Запускаю сборку через bash, чтобы проверить production-готовность.'
    if (/git\s+status/i.test(cmd)) return 'Проверяю состояние git перед следующими действиями.'
    if (/git\s+diff/i.test(cmd)) return 'Смотрю diff, чтобы убедиться, что изменения именно те, которые нужны.'
    if (/curl|wget/i.test(cmd)) return 'Проверяю endpoint/health через bash.'
    if (/docker\s+logs|docker\s+ps|docker compose/i.test(cmd)) return 'Проверяю Docker-состояние и логи через bash.'
    if (/grep|rg|find|ls|pwd|cat|sed/i.test(cmd)) return 'Осматриваю проект через bash, чтобы быстро найти нужные файлы и контекст.'
    return 'Выполняю bash-команду как часть автоматического Agent Mode.'
  }
  if (tool === 'list_files') return 'Сначала смотрю структуру workspace, чтобы работать по реальным путям.'
  if (tool === 'read_file') return `Читаю файл ${args?.path || ''}, прежде чем делать выводы или правки.`
  if (tool === 'search_files') return 'Ищу по проекту релевантные места для задачи.'
  if (tool === 'edit_file' || tool === 'write_file') return `Вношу изменение в ${args?.path || 'файл'} и затем проверю результат.`
  if (tool === 'verify_task' || tool === 'verify_code') return 'Запускаю проверку после изменений, чтобы не заявлять успех без evidence.'
  if (tool === 'secret_scan') return 'Проверяю, что в изменения не попали секреты.'
  if (tool.startsWith('git_')) return 'Выполняю git-шаг и буду опираться только на результат команды.'
  if (tool.startsWith('ops_')) return 'Выполняю operator/ops действие с последующей проверкой состояния.'
  if (tool === 'ask_user') return 'Нужна твоя развилка/подтверждение, без неё безопасно продолжить нельзя.'
  const type = agentContext?.task?.type || 'task'
  return `Выполняю инструмент ${tool} для шага ${type}.`
}

function toolSucceeded(tool, r) {
  if (!r?.ok) return false
  const result = r.result || {}
  if (['bash', 'shell_session_run'].includes(tool) && result.exitCode != null) return Number(result.exitCode) === 0
  if (tool === 'npm_test') return result.passed === true || Number(result.exitCode) === 0
  if (tool === 'verify_task') return result.passed === true
  if (tool === 'verify_code') return result.valid !== false && result.ok !== false
  if (tool === 'run_tests') return result.passed !== false
  return true
}

function summarizeToolOutcome(tool, r) {
  if (!r?.ok) return String(r?.error || 'failed').slice(0, 180)
  const result = r.result
  if (tool === 'read_file') return `${result?.content?.length || 0} chars`
  if (tool === 'write_file') return `${result?.bytes || 0} bytes written`
  if (tool === 'edit_file') return `replaced=${result?.replaced ?? 1}`
  if (tool === 'verify_code') return result?.valid === false ? 'invalid' : 'valid/skipped'
  if (tool === 'npm_test') return result?.passed ? 'passed' : `failed exit=${result?.exitCode ?? '?'}`
  if (tool === 'verify_task') return result?.passed ? `passed ${result?.results?.length || 0} checks` : `failed ${result?.results?.length || 0} checks`
  if (tool === 'git_clone') return `path=${result?.path || ''}`
  if (tool === 'git_commit') return `committed=${result?.committed !== false} pushed=${Boolean(result?.pushed)} ${String(result?.stderr || '').slice(0, 80)}`
  if (tool === 'ops_run_action') return `exit=${result?.exitCode ?? '?'} ${String(result?.stdout || result?.message || '').slice(0, 120)}`
  if (tool === 'zip_files') return `path=${result?.file_path || ''} entries=${result?.entries || 0}`
  if (tool === 'secret_scan') return result?.ok ? `ok scanned=${result?.scannedFiles || 0}` : `findings high=${result?.high || 0} medium=${result?.medium || 0}`
  if (tool === 'workspace_snapshot_create') return `id=${result?.id || ''} entries=${result?.entries || 0}`
  if (tool === 'workspace_snapshot_restore') return `id=${result?.id || ''} restored=${Boolean(result?.restored)}`
  if (tool === 'bash' || tool === 'shell_session_run') return `exit=${result?.exitCode ?? '?'} duration=${result?.durationMs || 0}ms`
  if (tool === 'shell_background_start') return `task=${result?.taskId || ''}`
  if (tool === 'shell_background_read') return `running=${Boolean(result?.running)} exit=${result?.exitCode ?? ''}`
  if (tool === 'shell_background_stop') return `stopped=${Boolean(result?.stopped)}`
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
  for (let i = recentToolHistory.length - 1; i >= Math.max(0, recentToolHistory.length - 14); i -= 1) {
    const h = recentToolHistory[i]
    if (h?.ok && ['verify_code', 'verify_task', 'npm_test', 'run_tests'].includes(h.tool)) return false
    if (h?.ok && commandMatches(h, /(npm|pnpm|yarn)\s+(test|run\s+test|run\s+build|build)|vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test/i)) return false
  }
  return true
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
  sse(res, 'agent_context', { deterministicAction: { id: action.id, tool: action.tool, reason: action.reason, risk: action.risk, requiresApproval: action.requiresApproval }, task: { type: action.id, complexity: 'low' } })
  if (action.requiresApproval) {
    const { id: aqId, promise: aqPromise, expiresAt } = registerQuestion({
      kind: 'tool_approval', userId, chatId, step: 0, sub: 0,
      tool: action.tool, category: categoryOf(action.tool),
      question: action.approvalQuestion || `Разрешить ${action.tool}?`,
      options: [{ id: 'approve', label: 'Разрешить' }, { id: 'deny', label: 'Запретить' }],
    })
    sse(res, 'tool_approval', { step: 0, sub: 0, question_id: aqId, expiresAt, tool: action.tool, category: categoryOf(action.tool), args: action.args || {} })
    let approved = false
    try {
      const ans = await aqPromise
      const pick = Array.isArray(ans?.selected) ? String(ans.selected[0]) : String(ans?.text || ans)
      approved = ['approve', 'yes', 'ok', 'allow', 'true', 'разрешить'].includes(pick.toLowerCase().trim())
    } catch { /* denied/expired */ }
    if (!approved) {
      await streamFinalAnswer(res, '❌ Действие отменено: нет подтверждения.')
      sseDone(res, { steps: 0, reason: `${action.id}-denied` }, tokens)
      res.end()
      return
    }
  }
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
function getRecoveryHint(tool, error, args = {}, recentToolHistory = []) {
  return recoveryHint({ tool, error, args, recentToolHistory })
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

  sse(res, 'stream_protocol', { version: 1, events: ['stream_protocol', 'agent_context', 'agent_task', 'agent_state', 'thinking', 'thinking_delta', 'assistant_delta', 'assistant', 'thought', 'tool_preview', 'tool_router', 'tool_start', 'tool_progress', 'tool_result', 'tool_diagnostic', 'ask_user', 'tool_approval', 'usage', 'done', 'error'] })

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
  let currentPhase = 'execute'
  let currentPhaseAllowedSet = null
  let autoSnapshotCreated = false
  // Anti-fabrication bookkeeping: which paths were actually read vs failed.
  // Used before the final answer to catch reports citing files that were
  // never successfully opened (observed: invented *.py files in a JS repo).
  const okReadPaths = new Set(), failedReadPaths = new Set()
  let fabricationPushback = false
  let verificationPushback = false
  const obligationPushbacks = new Map()
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
      const phaseInfo = deriveTaskPhase({ agentContext, agentState, recentToolHistory })
      currentPhase = phaseInfo.phase
      currentPhaseAllowedSet = allowedToolsForPhase(currentPhase)
      agentState.phase = currentPhase
      agentState.phaseReason = phaseInfo.reason
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
          convo.push({ role: 'user', content: `[verification_required]\nYou changed code/config files but have not verified them after the last edit. Call verify_task, verify_code on touched files, or npm_test now. Do not final-answer until verification is done or explicitly explain a skipped verifier via tool result.` })
          continue
        }

        const doneCriteriaGap = unmetDoneCriteria(agentContext?.task?.type, recentToolHistory)
        if (doneCriteriaGap && !aborted) {
          sse(res, 'thought', { step, text: `Критерии завершения ещё не выполнены: ${doneCriteriaGap}` })
          convo.push({ role: 'user', content: `[done_criteria_enforcement]\n${doneCriteriaGap}\nContinue with the required tool call(s). Do not final-answer yet.` })
          continue
        }

        const obligationGap = unmetGoalObligation(agentContext, recentToolHistory)
        if (obligationGap && !aborted) {
          const prev = Number(obligationPushbacks.get(obligationGap.key) || 0)
          if (prev < 2) {
            obligationPushbacks.set(obligationGap.key, prev + 1)
            agentState.obligationStatus = obligationGap.status
            sse(res, 'thought', { step, text: `Автопилот не завершает задачу: ${obligationGap.message}. Продолжаю выполнять обязательный шаг.` })
            convo.push({ role: 'user', content: `[goal_obligation_enforcement]\nThe user request implies obligation "${obligationGap.key}" but it is not satisfied yet: ${obligationGap.message}.\n\nCurrent obligation status:\n${JSON.stringify(obligationGap.status, null, 2)}\n\nContinue with the required tool call(s). If impossible because of credentials/approval/policy/tooling, state the blocker explicitly in the final report with evidence. Do not silently omit this obligation.` })
            continue
          }
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

        const finalTextWithEvidence = didRealWork ? appendRuntimeEvidence(reply.text || '', agentContext, recentToolHistory, agentState) : (reply.text || '')
        if (streamedFinalAnswer) sse(res, 'assistant', { text: finalTextWithEvidence })
        else await streamFinalAnswer(res, finalTextWithEvidence)

        // CRITICAL ORDER: send 'done' and close the stream FIRST. The
        // lesson-extraction below makes an extra LLM call — if it hangs
        // (slow provider, dead DeepSeek session) while 'done' hasn't been
        // sent, the UI spinner never stops and the Composer silently
        // swallows every next message. Lessons are best-effort background
        // work and must never delay stream completion.
        try { if (persistedTask) finishAgentTask(persistedTask.id, { status: 'succeeded', state: agentState, history: convo }) } catch { /* best-effort */ }
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

        if (!isToolAllowed(call.tool, allowedToolSet, extraTools)) {
          const rErr = makeToolErrorResult(`Tool ${call.tool} is not available in the current ${toolProfile} tool profile. Use one of: ${[...allowedToolSet].join(', ')}`)
          sse(res, 'tool_router', { step, sub: idx, name: call.tool, warnings: [rErr.error] })
          sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: false, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }

        if (!isToolAllowed(call.tool, currentPhaseAllowedSet, extraTools)) {
          const allowed = currentPhaseAllowedSet ? [...currentPhaseAllowedSet].join(', ') : 'all profile tools'
          const rErr = makeToolErrorResult(`Tool ${call.tool} is blocked in phase ${currentPhase}. Use one of: ${allowed}`)
          sse(res, 'tool_router', { step, sub: idx, name: call.tool, warnings: [rErr.error], phase: currentPhase })
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
        if (!autoSnapshotCreated && ['write_file', 'edit_file', 'delete_file', 'create_folder', 'rename_item', 'workspace_snapshot_restore'].includes(call.tool)) {
          try {
            const snap = await withWorkspaceScope(chatId, () => createWorkspaceSnapshot({ label: `before-${call.tool}-step-${step}` }))
            autoSnapshotCreated = true
            sse(res, 'tool_diagnostic', { step, sub: idx, name: 'workspace_snapshot_create', path: snap.file, message: `Rollback snapshot created: ${snap.id}` })
          } catch (e) {
            sse(res, 'thought', { step, sub: idx, text: `Не удалось создать snapshot перед ${call.tool}: ${e.message}` })
          }
        }
        if (call.tool !== 'ask_user' && requiresApproval(call.tool, userId, call.args || {})) {
          const { id: aqId, promise: aqPromise, expiresAt } = registerQuestion({ kind: 'tool_approval', userId, chatId, step, sub: idx, tool: call.tool, category: categoryOf(call.tool), question: `Approve ${call.tool}?`, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }] })
          sse(res, 'tool_approval', { step, sub: idx, question_id: aqId, expiresAt, tool: call.tool, args: call.args })
          let approved = false; try { const ans = await aqPromise; const pick = Array.isArray(ans?.selected) ? String(ans.selected[0]) : String(ans?.text || ans); approved = ['approve', 'yes', 'ok', 'allow', 'true'].includes(pick.toLowerCase().trim()) } catch { /* best-effort: ignore */ }
          if (!approved) return { call, r: { ok: false, error: 'User denied.' } }
        }

        res.__agentPhase = 'tool'
        res.__agentActiveTool = call.tool
        sse(res, 'thought', { step, sub: idx, text: narrateToolCall(call.tool, call.args, agentContext), generated: true })
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
        const semanticOk = toolSucceeded(call.tool, r)
        if (!semanticOk && !pushedBackThisTurn && !aborted && categoryOf(call.tool) !== 'ask') {
          const semanticError = r.ok ? summarizeToolOutcome(call.tool, r) : r.error
          const recovery = getRecoveryAction({ tool: call.tool, error: semanticError, result: r.result, args: call.args, recentToolHistory })
          const hint = recovery?.message || getRecoveryHint(call.tool, semanticError, call.args, recentToolHistory)
          if (hint) {
            pushedBackThisTurn = true
            sse(res, 'thought', { step, sub: idx, text: `ОШИБКА: ${call.tool} — ${semanticError}. Исправляю…` })
            const rErr = makeToolErrorResult(`[exec_error] ${semanticError}.\n\nREQUIRED ACTION TO RECOVER:\n${hint}\n\nExecute this action now.`)
            rErr.result = r.result
            sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: false, result: r.result, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
            return { call, r: rErr, pushedBack: true }
          }
          pushedBackThisTurn = true
          sse(res, 'thought', { step, sub: idx, text: `Ошибка выполнения: ${call.tool} — ${semanticError}. Пробую восстановиться.` })
          const rErr = makeToolErrorResult(`[exec_error] ${semanticError}`)
          rErr.result = r.result
          sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: false, result: r.result, error: rErr.error, structured: normalizeToolResult(call.tool, rErr, { step, sub: idx }) })
          return { call, r: rErr, pushedBack: true }
        }
        const stateResult = semanticOk ? r : { ...r, ok: false, error: r.error || summarizeToolOutcome(call.tool, r) }
        updateAgentStateFromTool(agentState, call.tool, stateResult, call.args); agentState.obligationStatus = obligationCompletionStatus(agentState.obligations || {}, recentToolHistory); try { if (persistedTask) updateAgentTask(persistedTask.id, { phase: agentState.phase || currentPhase, state: agentState, history: convo }) } catch { /* best-effort */ }; sse(res, 'tool_result', { step, sub: idx, name: call.tool, ok: semanticOk, result: r.result, error: semanticOk ? r.error : (r.error || summarizeToolOutcome(call.tool, r)), structured: normalizeToolResult(call.tool, stateResult, { step, sub: idx }) }); sse(res, 'agent_state', agentState)
        res.__agentPhase = 'agent'
        res.__agentActiveTool = ''
        return { call, r }
        })())
      }

      let sawPushBack = false
      for (const res of results) { if (res?.pushedBack) sawPushBack = true; if (res?.call && res?.r) { recentToolHistory.push({ tool: res.call.tool, ok: !!res.r.ok, at: Date.now(), args: summarizeCallArgsForDigest(res.call.args || {}), outcome: summarizeToolOutcome(res.call.tool, res.r) }); if (res.call.tool === 'read_file' && res.call.args?.path) { (res.r.ok ? okReadPaths : failedReadPaths).add(String(res.call.args.path)) } if (res.call.tool === 'plan_set' && res.r.ok) planState.done = new Set(); else if (res.call.tool === 'plan_check' && res.r.ok) (res.r.result?.checked || []).forEach(idx => planState.done.add(Number(idx))) } }
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
    if (step >= maxSteps) { sse(res, 'error', { message: `Stopped after ${maxSteps} steps` }); sseDone(res, { steps: step, reason: 'max-steps' }, tokens) }
  } catch (e) { try { if (persistedTask) finishAgentTask(persistedTask.id, { status: 'failed', state: agentState, history: convo }) } catch { /* best-effort */ }; sse(res, 'error', { message: e.message }); sseDone(res, { steps: step, reason: 'crash' }, tokens) } finally { clearInterval(idleWatchdog); if (chatId) activeRunsByChat.delete(chatId); try { res.end() } catch { /* best-effort: ignore */ } }
}

function sseDone(res, payload, tokens) { sse(res, 'done', { ...payload, tokens }) }
