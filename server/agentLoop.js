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
import { callLLM, supportsNativeTools } from './llmClient.js'
import { registerQuestion } from './askUserRegistry.js'
import { buildClineSystemPrompt } from './clinePrompt.js'
import { recordSpend, checkCap, chatTotalUsd } from './costTracker.js'
import { shouldUseCheapEditor, wrapProviderForEditor, routingLabel } from './architectEditor.js'

const DEFAULT_MAX_STEPS = 15
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000

const TOOL_FENCE_RE = /```(?:json|tool|tool_call)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/i

// ── System prompt ───────────────────────────────────────────────────────────
//
// Two implementations live side by side:
//   • buildClineSystemPrompt() — the big Cline-style prompt with 12+
//     dedicated sections (AGENT_ROLE, TOOL_USE, TOOL_USE_FORMATTING,
//     TOOL_USE_GUIDELINES, AVAILABLE_TOOLS, EDITING_FILES, TASK_PROGRESS,
//     CAPABILITIES, RULES, SYSTEM_INFORMATION, MEMORY, OBJECTIVE,
//     USER_INSTRUCTIONS). Default. Used by `buildSystemPrompt` below.
//   • buildSystemPromptLegacy() — the previous concise prompt. Kept for
//     emergency rollback via `BROWSERAI_PROMPT_STYLE=legacy`.
//
// Switching: set env BROWSERAI_PROMPT_STYLE=legacy to revert.
function buildSystemPrompt({ extraSystem = '', native = false, extraTools = null } = {}) {
  if (String(process.env.BROWSERAI_PROMPT_STYLE || 'cline').toLowerCase() === 'legacy') {
    return buildSystemPromptLegacy({ extraSystem, native, extraTools })
  }
  // The Cline prompt already knows how to format the extraSystem (modelHint
  // + recall + projectRules + recentActivity are concatenated by the caller
  // in server/index.js and passed in as a single extraSystem string).
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
    '    never patch from memory. If a file is huge, `search_files` first',
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

// ── OpenAI-format tools[] schema, built from our registry ───────────────────
function buildNativeToolsSpec(extraTools = null) {
  const combined = extraTools && typeof extraTools === 'object' ? { ...TOOLS, ...extraTools } : TOOLS
  return Object.entries(combined).map(([name, def]) => {
    const properties = {}
    const required = []
    for (const [pName, pMeta] of Object.entries(def.params || {})) {
      properties[pName] = {
        type: pMeta.type === 'number' ? 'number'
              : pMeta.type === 'boolean' ? 'boolean'
              : 'string',
        description: pMeta.description || '',
      }
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

// Clip a tool result before injecting it into the LLM conversation.
// Without this, a single `bash` call with 100 KB of output can push us
// past every provider's context window in 2-3 turns. We keep the head
// + tail so the model sees both the start of the output and the most
// recent (often most useful) lines, with a clear gap marker.
//
// IMPORTANT: head/tail are model-aware via tokenBudgetFor() in
// server/modelKnowledge.js. A 64k DeepSeek call gets tighter clipping
// than a 200k Claude — env vars still override.
import { tokenBudgetFor } from './modelKnowledge.js'
function clipForLLM(s, modelId = '') {
  const budget = tokenBudgetFor(modelId)
  const head = Number(process.env.TOOL_OUTPUT_HEAD || budget.head)
  const tail = Number(process.env.TOOL_OUTPUT_TAIL || budget.tail)
  const str = String(s || '')
  const max = head + tail + 200
  if (str.length <= max) return str
  const hidden = str.length - head - tail
  return `${str.slice(0, head)}\n\n… [${hidden} characters omitted to keep context small — run with a more specific filter to see the middle] …\n\n${str.slice(-tail)}`
}

/**
 * Auto-compact the running `convo` array when it's about to push past
 * the provider's context window. Strategy:
 *   1. Estimate total chars in convo (≈4 chars per token, conservative).
 *   2. If we're under 60% of the model's budget → noop.
 *   3. Otherwise replace the OLDEST third of the conversation (everything
 *      after the system message and before the most recent N turns) with
 *      a single condensed summary message that lists what was done so
 *      the agent doesn't lose its bearings.
 *
 * Called once per iteration of the main loop. Cheap O(n) over convo size.
 */
function maybeAutoCompact(convo, modelId) {
  const budget = tokenBudgetFor(modelId)
  const budgetChars = budget.ctxTokens * 4
  let total = 0
  for (const m of convo) total += String(m?.content || '').length
  if (total < budgetChars * 0.6) return false
  // Keep system + last 8 messages verbatim; squash the middle.
  const sys = convo[0]?.role === 'system' ? convo[0] : null
  const keepTail = 8
  if (convo.length - (sys ? 1 : 0) <= keepTail + 2) return false
  const head = sys ? [sys] : []
  const middleStart = sys ? 1 : 0
  const middleEnd = convo.length - keepTail
  const middle = convo.slice(middleStart, middleEnd)
  const tail = convo.slice(middleEnd)
  // Build a terse digest: "U: …", "A used: tool1, tool2", "Tool: …"
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
    content:
      '[auto-compact summary of earlier turns — full text was dropped to free up context]\n\n' +
      lines.join('\n').slice(0, 4000),
  }
  convo.splice(middleStart, middle.length, digest)
  return true
}

// ── Programmatic safety nets (IQ+20 patches) ────────────────────────────────
// These run alongside the system prompt; they catch failure modes that
// instruction-following alone is unreliable about.

/**
 * Identify a tool call by its key+args fingerprint so we can detect when
 * the model spams the exact same call repeatedly (e.g. read_file the same
 * path 5 times because it forgot it already did). Args are JSON-stringified
 * with sorted keys for stability across runs.
 */
function callFingerprint(call) {
  if (!call) return ''
  const args = call.args || {}
  let normalised
  try {
    normalised = JSON.stringify(args, Object.keys(args).sort())
  } catch { normalised = '{}' }
  return `${call.tool}::${normalised}`
}


// ── XML Function Call Parser (Arena.ai / Anthropic / Grok style) ────────────
// Models that don't expose native OpenAI tool_calls (DeepSeek, Gemini Web,
// some older Llamas) reliably emit ONE of these XML envelopes:
//
//   <xai:function_call>
//     <xai:tool_name>read_file</xai:tool_name>
//     <parameter name="path">server/index.js</parameter>
//   </xai:function_call>
//
// We also accept the older <function_call name="..."> shape from Anthropic
// circa Claude-2 and the newer <tool_use name="..."> Claude-3 one.
//
// Multiple blocks back-to-back → parallel tool batch in the same loop tick.
const XML_TOOL_CALL_RE = /<(?:xai:function_call|tool_use|function_call)([^>]*)>([\s\S]*?)<\/(?:xai:function_call|tool_use|function_call)>/gi
const XML_PARAM_RE = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi

function parseXmlFunctionCalls(text) {
  const calls = []
  // Reset lastIndex because we share the RegExp across calls.
  XML_TOOL_CALL_RE.lastIndex = 0
  let match
  while ((match = XML_TOOL_CALL_RE.exec(text)) !== null) {
    const openAttrs = match[1] || ''
    const content = match[2] || ''
    // Tool name can live in any of: <xai:tool_name>X</xai:tool_name>,
    // <tool_name>X</tool_name>, or as a name="X" attribute on the opening tag.
    const nameMatch =
      content.match(/<xai:tool_name>([^<]+)<\/xai:tool_name>/i) ||
      content.match(/<tool_name>([^<]+)<\/tool_name>/i) ||
      openAttrs.match(/name\s*=\s*["']([^"']+)["']/i)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    const args = {}
    XML_PARAM_RE.lastIndex = 0
    let paramMatch
    while ((paramMatch = XML_PARAM_RE.exec(content)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim()
    }
    // Also accept Claude-style <invoke> body as JSON inside the call.
    const invokeJsonMatch = content.match(/<invoke[^>]*>([\s\S]*?)<\/invoke>/i)
    if (invokeJsonMatch) {
      try { Object.assign(args, JSON.parse(invokeJsonMatch[1].trim())) } catch { /* ignore */ }
    }
    calls.push({ tool: name, args })
  }
  return calls
}
/**
 * Detect a tool-call loop: the model has called the SAME (tool, args)
 * triple ≥3 times in a row across recent turns. When this happens we
 * push back instead of running it for the 4th time.
 */
const STUCK_THRESHOLD = 3
function isStuckLoop(recentCalls, currentFingerprint) {
  if (!currentFingerprint) return false
  let count = 0
  for (let i = recentCalls.length - 1; i >= 0; i -= 1) {
    if (recentCalls[i] === currentFingerprint) count += 1
    else break
  }
  return count + 1 >= STUCK_THRESHOLD
}

/**
 * Force a read-back after every edit_file / write_file. The model often
 * "applies an edit and moves on" — but the edit may have failed silently,
 * or it may have matched the wrong place in a near-duplicate file. A
 * follow-up read_file is the only way to be sure. We inject the read on
 * the SAME turn so it joins the parallel batch without an extra LLM round.
 */
function makeReadBackForEdits(calls) {
  const out = []
  const seen = new Set()
  for (const call of calls || []) {
    if (call.tool !== 'edit_file' && call.tool !== 'write_file') continue
    const p = call.args?.path
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push({ tool: 'read_file', args: { path: p }, nativeId: null, nativeRaw: null, _readBack: true })
  }
  return out
}

/**
 * Did the user just receive an UNcommittable change (or a recent
 * verify_code FAIL) but the model is now asking for git_push?
 * Refuse and push back. Keeps "fixed→pushed broken code" loops from
 * shipping.
 */
function violatesPreDeployVerify(call, recentToolHistory) {
  if (call.tool !== 'git_push' && call.tool !== 'git_commit') return false
  // Look at the last ~10 tool calls in this conversation for a successful
  // verify_code. If there's none — or the most recent verify failed —
  // block the push.
  let sawOk = false
  for (let i = recentToolHistory.length - 1; i >= Math.max(0, recentToolHistory.length - 10); i -= 1) {
    const h = recentToolHistory[i]
    if (h?.tool === 'verify_code') {
      if (h.ok) sawOk = true
      else return true // most recent verify failed
      break
    }
  }
  return !sawOk
}

/**
 * The model called plan_check([1,1,1]) or plan_check on already-done
 * indices. Dedupe + drop already-done before invoking, so the plan
 * card progress doesn't show 'done' on the same step twice.
 */
function dedupePlanCheck(call, planState) {
  if (call.tool !== 'plan_check') return call
  let indices = []
  try {
    indices = Array.isArray(call.args?.indices)
      ? call.args.indices
      : JSON.parse(String(call.args?.indices || '[]'))
  } catch { return call }
  const unique = [...new Set(indices.map(Number).filter((n) => Number.isInteger(n)))]
  const fresh = unique.filter((n) => !planState.done.has(n))
  if (fresh.length === unique.length && unique.length === indices.length) return call
  return { ...call, args: { ...call.args, indices: fresh } }
}

// Heuristic: did the user ask for an edit-style change ("исправь",
// "поправь", "оживи код", "сделай так чтобы…", "fix the bug",
// "refactor", etc) AND the model's reply contains a substantial code
// block instead of a tool call? Then it's almost certainly the "modelы
// прислал коды вместо того чтобы их применить" anti-pattern the user
// complained about — push back instead of accepting it as a final answer.
const EDIT_REQUEST_RE = /(исправ|поправ|почини|испрви|переписать|refactor|fix |rewrite|edit |применит|апплай|внеси изменен|сделай так|реализуй|сделай|implement|добав\w* код|улучш|оптимиз|почини баг|удали (?:из|из файла|строк))/i
const CODE_BLOCK_RE = /```[a-z0-9_+-]*\n[\s\S]{120,}?\n```/i
const TOOLISH_REPLY_RE = /^\s*```(?:json|tool)?\s*\{/im
function looksLikeUnapplliedCodeReply(text = '', history = []) {
  const reply = String(text || '')
  if (!CODE_BLOCK_RE.test(reply)) return false
  if (TOOLISH_REPLY_RE.test(reply)) return false   // a bona-fide tool envelope we just failed to parse
  // Look at the LAST user turn to decide whether the user was asking for
  // an edit. If they were just asking "show me the function" we don't
  // want to nag — passing code back is the right answer there.
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  const askText = String(lastUser?.content || '')
  return EDIT_REQUEST_RE.test(askText)
}

// ── Parse a JSON-in-text tool call ──────────────────────────────────────────
// Returns { tool, args, malformed? } — `malformed:true` when the response
// CLEARLY tried to call a tool (had a fenced JSON or trailing brace) but
// the JSON didn't parse. The loop uses that flag to trigger a single
// "fix your JSON" push-back instead of silently dropping the call.
function extractTextToolCall(text = '', extraTools = null) {
  const fence = TOOL_FENCE_RE.exec(text)
  const candidates = []
  if (fence) candidates.push(fence[1])
  const trimmed = String(text).trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed)
  let sawToolish = candidates.length > 0
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw)
      const known = obj && typeof obj.tool === 'string' && (TOOLS[obj.tool] || (extraTools && extraTools[obj.tool]))
      if (known) {
        return { tool: obj.tool, args: obj.args || {} }
      }
      // Parsed but wrong shape — still counts as "the model tried to
      // call a tool but failed", so the loop can push back.
      sawToolish = true
    } catch {
      sawToolish = true
    }
  }
  return sawToolish ? { malformed: true } : null
}

// ── SSE helper ──────────────────────────────────────────────────────────────
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* closed */ }
}

/**
 * Emit the final assistant text as a sequence of small 'assistant_delta'
 * events plus a final 'assistant' event with the complete text. The
 * frontend appends each delta into the message bubble live, then snaps
 * to the canonical final string. Stays under 100 events per response.
 */
/**
 * Tiny "did I finish the task?" check.
 *
 * Run BEFORE we accept the agent's first proposed final answer. Asks the
 * same LLM provider a yes/no question + reason. Cheap (~120 prompt
 * tokens). Catches the most common 'gave-up-too-early' failures:
 *   - user asked to edit N files, agent edited 1
 *   - user asked "is it deployed?" and agent answered "I think so" without
 *     calling verify_code / git_status
 *   - agent says "done" but no edit_file in toolHistory
 *
 * Returns { needsMoreWork: bool, reason: string, usage }.
 * Errors are swallowed by the caller — reflection is best-effort.
 */
async function runReflectionCheck({ provider, ask, draft, toolHistory }) {
  const toolSummary = (toolHistory || [])
    .slice(-12)
    .map((h) => `${h.ok ? '✓' : '✗'} ${h.tool}`)
    .join(', ') || '(none)'
  const prompt = [
    'Ты — критик автономного агента. Оцени, выполнил ли он задачу пользователя.',
    '',
    `Запрос пользователя:\n${String(ask || '').slice(0, 1500)}`,
    '',
    `Какие инструменты были вызваны (последние): ${toolSummary}`,
    '',
    `Черновик финального ответа агента:\n${String(draft || '').slice(0, 2000)}`,
    '',
    'Ответь СТРОГО одной строкой:',
    '  DONE                — если запрос полностью закрыт',
    '  TODO: <причина>     — если есть пропущенные шаги, требующие ещё tool-вызовов',
    '',
    'TODO выдавай ТОЛЬКО для реально пропущенных действий (например: ' +
    'пользователь просил исправить 3 файла — исправлен 1; пользователь ' +
    'просил задеплоить — не было ops_run_action; код был изменён, но ' +
    'verify_code не запускался). Не придирайся к стилю и формулировкам.',
  ].join('\n')

  const reply = await callLLM({
    baseUrl: provider.baseUrl, apiKey: provider.apiKey,
    authType: provider.authType || 'bearer',
    authHeader: provider.authHeader || '',
    extraHeaders: provider.extraHeaders || {},
    model: provider.model,
    messages: [
      { role: 'system', content: 'You are a terse reviewer. One line. No markdown.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
  })
  const out = String(reply?.text || '').trim().split(/\r?\n/)[0] || ''
  const todoMatch = out.match(/^\s*todo\s*[:\-—]?\s*(.+)$/i)
  if (todoMatch) {
    return { needsMoreWork: true, reason: todoMatch[1].trim(), usage: reply.usage }
  }
  return { needsMoreWork: false, reason: '', usage: reply.usage }
}

async function streamFinalAnswer(res, fullText) {
  const text = String(fullText || '')
  if (!text) {
    sse(res, 'assistant', { text: '' })
    return
  }
  // Group into chunks of roughly 24-40 characters, breaking on whitespace
  // when possible so words don't split mid-character.
  const targetChunk = 32
  const parts = []
  let buf = ''
  for (let i = 0; i < text.length; i += 1) {
    buf += text[i]
    if (buf.length >= targetChunk && /[\s.,;:!?\n)\]}»]/.test(buf[buf.length - 1])) {
      parts.push(buf); buf = ''
    }
  }
  if (buf) parts.push(buf)
  for (const chunk of parts) {
    sse(res, 'assistant_delta', { chunk })
    // Tiny pause to let the UI render — caps at ~12ms per word, so a
    // 500-char answer feels like fast typing (~250ms total).
    if (parts.length > 4) await new Promise((r) => setTimeout(r, 12))
  }
  sse(res, 'assistant', { text })
}

// Convenience: send 'done' with the latest token totals attached. Always
// include them — the UI ignores zeros for providers that don't return usage.
function sseDone(res, payload, tokens) {
  sse(res, 'done', { ...payload, tokens })
}

// ── Main loop ───────────────────────────────────────────────────────────────
/**
 * Run the agent until it produces a final answer or hits a limit.
 *
 * @param {object} opts
 * @param {object} opts.provider              {baseUrl, apiKey, authType, authHeader, extraHeaders, model}
 * @param {Array<{role,content}>} opts.history
 * @param {number} [opts.maxSteps]
 * @param {string} [opts.extraSystem]
 * @param {object} opts.res                   Express response, will be SSE-streamed
 */
export async function runAgent(opts) {
  return withWorkspaceScope(opts?.workspaceScope || '', () => runAgentInner({ ...(opts || {}), workspaceScope: opts?.workspaceScope || '' }))
}

async function runAgentInner({
  provider,
  history = [],
  maxSteps = DEFAULT_MAX_STEPS,
  extraSystem = '',
  userId = '',
  workspaceScope = '',
  res,
}) {
  const chatId = String(workspaceScope || '')
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  // Initialise token counters early so the no-provider exit path can reference
  // them without a ReferenceError. tokens.* are mutated in accumulateUsage().
  const tokens = { prompt: 0, completion: 0, total: 0, llmCalls: 0 }
  function accumulateUsage(u) {
    if (!u) return
    tokens.prompt += Number(u.prompt || 0)
    tokens.completion += Number(u.completion || 0)
    tokens.total += Number(u.total || (u.prompt + u.completion) || 0)
    tokens.llmCalls += 1
  }

  if (!provider?.baseUrl || !provider?.apiKey) {
    sse(res, 'error', { message: 'Provider is not configured (baseUrl + apiKey required)' })
    sseDone(res, { steps: 0, reason: 'no-provider' }, tokens)
    res.end()
    return
  }

  // Custom user-defined tools (HTTP / webhook). Loaded once per agent run.
  let extraTools = null
  if (userId) {
    try {
      const { loadCustomToolsFor } = await import('./customTools.js')
      const map = loadCustomToolsFor(userId)
      if (Object.keys(map).length) extraTools = map
    } catch (e) { console.warn('[agent] custom tools load failed:', e?.message || e) }
  }
  // MCP tools (from /data/mcp.json — global to the instance, shared across users).
  try {
    const { listMcpTools } = await import('./mcpClient.js')
    const mcp = listMcpTools()
    if (Object.keys(mcp).length) {
      extraTools = { ...(extraTools || {}), ...mcp }
    }
  } catch (e) { console.warn('[agent] mcp tools load failed:', e?.message || e) }

  let useNativeTools = supportsNativeTools(provider.baseUrl)
  let systemPrompt = buildSystemPrompt({ extraSystem, native: useNativeTools, extraTools })
  let toolsSpec = useNativeTools ? buildNativeToolsSpec(extraTools) : undefined

  const convo = [
    { role: 'system', content: systemPrompt },
    ...history,
  ]

  const deadline = Date.now() + DEFAULT_DEADLINE_MS
  let step = 0
  let aborted = false
  // Shared abort controller so a Stop click in the UI propagates ALL the way
  // down: cancels the in-flight LLM HTTP fetch AND any tool that supports
  // AbortSignal (bash sandbox, web_fetch, browser_*). Without this, hitting
  // Stop while the model is mid-bash would still wait the full 30s timeout.
  const abortCtl = new AbortController()
  res.on('close', () => { aborted = true; try { abortCtl.abort('client closed') } catch { /* ignore */ } })

  // ── Tracked state for safety nets (Agent IQ +20)
  // recentCallFingerprints: rolling list of [tool::args] strings — used by
  // the stuck-in-loop detector. recentToolHistory: per-call {tool,ok,result}
  // — used by the pre-deploy verify guard. planState.done: a Set of plan
  // step indices already marked complete — used by dedupePlanCheck.
  const recentCallFingerprints = []
  const recentToolHistory = []
  const planState = { done: new Set() }
  // Whether we've already pushed back this turn — we cap at ONE push-back
  // per LLM turn to avoid ping-pong.
  let pushedBackThisTurn = false

  try {
    while (step < maxSteps) {
      if (aborted) return
      if (Date.now() > deadline) {
        sse(res, 'error', { message: `Total deadline of ${DEFAULT_DEADLINE_MS / 1000}s exceeded after ${step} steps` })
        sseDone(res, { steps: step, reason: 'deadline' }, tokens)
        res.end()
        return
      }
      step += 1
      pushedBackThisTurn = false
      // Keep the conversation under the model's context budget. If we
      // had to compact, emit a 'thought' so the user sees it happened
      // (otherwise it would look like the agent silently forgot).
      if (maybeAutoCompact(convo, provider?.model)) {
        sse(res, 'thought', { step, text: 'Контекст приближается к лимиту модели — сжал старые шаги в краткую сводку.' })
      }
      sse(res, 'thinking', { step })

      // ── Cost cap gate ─────────────────────────────────────────────
      // If the user has hit their per-day USD cap, we refuse the next
      // LLM call and tell them why. Override: env BROWSERAI_DAILY_USD
      // or remember_fact daily_usd_cap=NN.
      const capCheck = checkCap(userId)
      if (!capCheck.ok) {
        sse(res, 'error', { message: capCheck.reason })
        sseDone(res, { steps: step, reason: 'cap-reached' }, tokens)
        res.end()
        return
      }

      // ── Architect/Editor routing (Aider-style) ────────────────────
      // After step 1, if the model has been doing mechanical edits, we
      // swap to a cheaper sibling for the executor turns. Strong model
      // stays on planning + summary turns. Saves 30-60% on long sessions.
      const routing = shouldUseCheapEditor({
        provider, step,
        recentToolHistory,
        userId,
      })
      const activeProvider = routing.useCheap
        ? wrapProviderForEditor(provider, routing.cheapModel)
        : provider
      if (routing.useCheap) {
        sse(res, 'thought', { step, text: `Architect/Editor: ${routingLabel(routing)} (${routing.reason})` })
      }

      // Call the LLM. Some OpenAI-compatible endpoints advertise a familiar
      // base URL but a concrete model does not support native tool calling.
      // In that case, fall back to the universal JSON-in-text tool protocol.
      let reply
      try {
        reply = await callLLM({
          baseUrl:      activeProvider.baseUrl,
          apiKey:       activeProvider.apiKey,
          authType:     activeProvider.authType || 'bearer',
          authHeader:   activeProvider.authHeader || '',
          extraHeaders: activeProvider.extraHeaders || {},
          model:        activeProvider.model,
          messages:     convo,
          temperature:  Number(activeProvider.temperature ?? 0.3),
          ...(useNativeTools ? { tools: toolsSpec, toolChoice: 'auto' } : {}),
        })
      } catch (e) {
        if (useNativeTools) {
          useNativeTools = false
          toolsSpec = undefined
          systemPrompt = buildSystemPrompt({ extraSystem, native: false })
          convo[0] = { role: 'system', content: systemPrompt }
          sse(res, 'thought', {
            step,
            text: 'Native tool-calling is unavailable for this model/provider; switching to BrowserAI universal text tool protocol.',
          })
          try {
            reply = await callLLM({
              baseUrl:      provider.baseUrl,
              apiKey:       provider.apiKey,
              authType:     provider.authType || 'bearer',
              authHeader:   provider.authHeader || '',
              extraHeaders: provider.extraHeaders || {},
              model:        provider.model,
              messages:     convo,
              temperature:  Number(provider.temperature ?? 0.3),
            })
          } catch (fallbackError) {
            sse(res, 'error', { message: 'LLM call failed: ' + (fallbackError.message || String(fallbackError)) })
            sseDone(res, { steps: step, reason: 'llm-error' }, tokens)
            res.end()
            return
          }
        } else {
          sse(res, 'error', { message: 'LLM call failed: ' + (e.message || String(e)) })
          sseDone(res, { steps: step, reason: 'llm-error' }, tokens)
          res.end()
          return
        }
      }
      // Stream a usage event so the UI updates the token badge live, not
      // only after the whole agent loop finishes.
      accumulateUsage(reply?.usage)
      // Persist spend so the user can see $X/day in the UI and so the
      // daily cap above can fire next turn. Best-effort — never blocks.
      let spendNote = null
      try {
        const sp = recordSpend({
          userId, chatId,
          model: activeProvider.model,
          usage: reply?.usage || {},
        })
        spendNote = sp
      } catch { /* tracker offline */ }
      if (reply?.usage) sse(res, 'usage', {
        step,
        ...reply.usage,
        totals: { ...tokens },
        cost: spendNote?.cost || 0,
        dailyTotal: spendNote?.dailyTotal || 0,
        chatTotal: chatTotalUsd(chatId).cost,
        model: activeProvider.model,
      })

      // Decide which tool path(s) to follow.
      // PARALLEL TOOLS: when the provider returns more than one tool_calls
      // entry in a single assistant message, we run them ALL concurrently
      // and feed every result back before the next LLM round. This is a
      // 3-5x speed-up on read-heavy turns ("read these 5 files").
      let calls = []
      if (useNativeTools && Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) {
        for (const tc of reply.toolCalls) {
          if (TOOLS[tc.name] || (extraTools && extraTools[tc.name])) {
            calls.push({ tool: tc.name, args: tc.args || {}, nativeId: tc.id, nativeRaw: tc.raw })
          }
        }
      }
      let malformedToolCall = false
      if (calls.length === 0) {
        // 1) XML envelope (Arena.ai / Anthropic / Grok style) — supports
        //    multiple <xai:function_call> blocks for parallel batches.
        const xmlCalls = parseXmlFunctionCalls(reply.text || '')
        for (const c of xmlCalls) {
          if (TOOLS[c.tool] || (extraTools && extraTools[c.tool])) calls.push(c)
        }
        // 2) Legacy single JSON fenced block (kept for back-compat with
        //    models that learnt the old prompt).
        if (calls.length === 0) {
          const textCall = extractTextToolCall(reply.text, extraTools)
          if (textCall?.malformed) malformedToolCall = true
          else if (textCall) calls = [textCall]
        }
      }

      if (calls.length === 0) {
        // Malformed-JSON safety net: model tried to call a tool but the
        // envelope was broken. Ask for a clean retry once instead of
        // silently treating it as a final answer.
        if (malformedToolCall && !pushedBackThisTurn && !aborted) {
          pushedBackThisTurn = true
          sse(res, 'thought', { step, text: 'JSON tool-вызова сломан, прошу повторить.' })
          convo.push({
            role: 'user',
            content:
              'Твой предыдущий ответ выглядел как tool-вызов, но JSON не парсится. ' +
              'Повтори ответ строго одним fenced-блоком ```json {"tool":"...","args":{...}} ``` ' +
              'без лишнего текста до или после.',
          })
          continue
        }
        // Heuristic safety net: did the user ask to fix/edit code but the
        // model dumped a fenced code block instead of calling edit_file?
        if (looksLikeUnapplliedCodeReply(reply.text, history) && !aborted && !pushedBackThisTurn) {
          pushedBackThisTurn = true
          sse(res, 'thought', {
            step,
            text: 'Заметил: ты прислал код в чат, но не применил его через edit_file/write_file. Перезапрашиваю с напоминанием.',
          })
          convo.push({
            role: 'user',
            content:
              'Ты прислал код в чат, но не применил его к файлам. ' +
              'Сейчас обязательно ПРИМЕНИ изменения через edit_file (или write_file для нового файла), ' +
              'а потом запусти verify_code на затронутых путях. В чат код больше НЕ присылай.',
          })
          continue
        }
        // Final answer
        // Self-reflection: before committing the answer, ask the model
        // one cheap "did I actually finish what the user asked?" check.
        // This is the small sub-agent loop that big AI assistants use to
        // catch sloppy stop-too-early answers. Skipped on the very first
        // turn (no work to reflect on) and when the previous turn was
        // already a reflection retry to avoid infinite ping-pong.
        const lastUserAsk = [...history].reverse().find((m) => m.role === 'user')?.content || ''
        const didRealWork = recentToolHistory.some((h) => h.ok && !['ask_user', 'recall_facts', 'plan_check', 'plan_set'].includes(h.tool))
        const reflectionAlreadyDone = convo.some((m) => m.role === 'user' && String(m.content || '').startsWith('[reflection]'))
        if (didRealWork && !reflectionAlreadyDone && !aborted) {
          const verdict = await runReflectionCheck({
            provider, ask: lastUserAsk, draft: reply.text || '', toolHistory: recentToolHistory,
          }).catch(() => null)
          if (verdict?.usage) accumulateUsage(verdict.usage)
          if (verdict?.needsMoreWork) {
            sse(res, 'thought', { step, text: `Самопроверка: ${verdict.reason}. Продолжаю.` })
            convo.push({
              role: 'user',
              content:
                `[reflection] You said you were done, but a self-check identified gaps:\n${verdict.reason}\n\n` +
                'Address them now using tools. If they are not real gaps, briefly explain why and finalise.',
            })
            continue
          }
        }
        // Stream the final answer in word-sized chunks instead of one
        // giant payload. Gives the UI a perceived typing animation even
        // when the provider didn't expose true token-by-token streaming
        // for this call. Cheap (~80 chunks for a typical paragraph).
        await streamFinalAnswer(res, reply.text || '')
        sseDone(res, { steps: step, reason: 'final' }, tokens)
        res.end()
        return
      }

      // Echo the assistant turn so the model sees its own request next round.
      // For native tools we have to preserve the full tool_calls structure
      // so each observation can reference its own tool_call_id.
      const anyNative = calls.some((c) => c.nativeId)
      if (anyNative) {
        convo.push({
          role: 'assistant',
          content: reply.text || '',
          tool_calls: calls.filter((c) => c.nativeId).map((c) => c.nativeRaw),
        })
      } else {
        convo.push({ role: 'assistant', content: reply.text || '' })
      }

      // Stream the intermediate reasoning (everything in reply.text except
      // the JSON envelope) to the UI so users see the model's plan in
      // real time, the way Arena's agent UI does.
      const thinkingText = anyNative
        ? (reply.text || '').trim()
        : (reply.text || '').replace(TOOL_FENCE_RE, '').trim()
      if (thinkingText) {
        sse(res, 'thought', { step, text: thinkingText })
      }

      // ── Safety nets pass: stuck-loop, pre-deploy verify, plan dedupe.
      // Pre-deploy verify can short-circuit the whole turn (push-back).
      const blockedReasons = []
      for (const c of calls) {
        if (violatesPreDeployVerify(c, recentToolHistory)) {
          blockedReasons.push(
            `Прежде чем ${c.tool === 'git_push' ? 'пушить' : 'коммитить'} — запусти verify_code и убедись что код проходит. ` +
            `Текущий запрос на ${c.tool} заблокирован.`,
          )
          break
        }
      }
      if (blockedReasons.length && !pushedBackThisTurn) {
        pushedBackThisTurn = true
        sse(res, 'thought', { step, text: 'Заблокировал git_push/commit — нет успешного verify_code за последние шаги. Перезапрашиваю.' })
        convo.push({ role: 'user', content: blockedReasons.join('\n') })
        continue
      }

      // Stuck-loop detector: same exact (tool, args) called STUCK_THRESHOLD
      // times in a row. Push back ONCE per turn, telling the model to vary.
      for (const c of calls) {
        const fp = callFingerprint(c)
        if (isStuckLoop(recentCallFingerprints, fp) && !pushedBackThisTurn) {
          pushedBackThisTurn = true
          sse(res, 'thought', { step, text: `Цикл: тот же вызов ${c.tool} повторяется. Прошу попробовать другой подход.` })
          convo.push({
            role: 'user',
            content:
              `Ты уже звал ${c.tool} с теми же аргументами ${STUCK_THRESHOLD} раз подряд и результат не помогает. ` +
              `Попробуй другой инструмент или другие параметры; не повторяй идентичный вызов.`,
          })
          break
        }
      }
      if (pushedBackThisTurn) continue

      // Dedupe plan_check before invocation.
      for (let i = 0; i < calls.length; i += 1) {
        if (calls[i].tool === 'plan_check') calls[i] = dedupePlanCheck(calls[i], planState)
      }

      // Read-back injection: every edit_file / write_file gets a paired
      // read_file in the same batch so the loop sees the result on disk
      // (catches silent edit failures and bad replacements).
      const readBacks = makeReadBackForEdits(calls)
      for (const rb of readBacks) calls.push(rb)

      // Run all tools in parallel. ask_user is sequential within its own
      // dispatch (it blocks waiting for the user) — it should rarely be
      // batched with other calls, but if a model does it, we await both.
      const results = await Promise.all(calls.map(async (call, idx) => {
        // Record fingerprint BEFORE running so the next turn sees it
        // (otherwise the very next call could match itself and trigger).
        recentCallFingerprints.push(callFingerprint(call))
        if (recentCallFingerprints.length > 20) recentCallFingerprints.shift()
        sse(res, 'tool_start', { step, sub: idx, name: call.tool, args: call.args, readBack: Boolean(call._readBack) })
        let r
        if (call.tool === 'ask_user') {
          const { id: questionId, promise } = registerQuestion()
          sse(res, 'ask_user', {
            step, sub: idx,
            question_id: questionId,
            question: call.args?.question || '(no question)',
            options: Array.isArray(call.args?.options) ? call.args.options : [],
            multi: call.args?.multi !== false,
            allow_custom: call.args?.allow_custom !== false,
          })
          try { r = { ok: true, result: await promise } }
          catch (e) { r = { ok: false, error: e?.message || 'ask_user cancelled' } }
        } else {
          // AUTO-RECOVERY: a tool can return ok:false but a string error
          // hint that's actually recoverable (e.g. "old_text not found in
          // X — refine to make it unique"). We don't retry blindly here —
          // the loop pushes the error back into context and the model
          // decides. But we DO clip outsized payloads so a 5 MB bash log
          // doesn't blow up the next LLM call.
          // Live-tail for long bash / verify_code calls: stream stdout
          // chunks to the UI as they appear so the user sees npm install /
          // git clone progress, not a 30-second silent block followed by
          // a wall of text at the end.
          const onProgress = (chunk, kind) => {
            sse(res, 'tool_progress', { step, sub: idx, name: call.tool, kind, chunk: String(chunk).slice(0, 2000) })
          }
          // Inject the live provider so use_subagents (and any future
          // recursive tools) can spawn nested LLM calls without the
          // caller having to thread credentials manually.
          const argsWithProvider = (call.tool === 'use_subagents')
            ? { ...(call.args || {}), _provider: provider }
            : call.args
          r = await invokeTool(call.tool, argsWithProvider, {
            signal: abortCtl.signal,
            onStdout: (c) => onProgress(c, 'stdout'),
            onStderr: (c) => onProgress(c, 'stderr'),
            userId,
            extraTools,
          })
        }
        sse(res, 'tool_result', {
          step, sub: idx,
          name: call.tool,
          ok: Boolean(r.ok),
          result: r.ok ? r.result : undefined,
          error: r.ok ? undefined : r.error,
        })
        return { call, r }
      }))

      // Update tracking state from THIS round's results so the next
      // iteration's safety nets have fresh data.
      for (const { call, r } of results) {
        recentToolHistory.push({ tool: call.tool, ok: Boolean(r.ok), at: Date.now() })
        if (call.tool === 'plan_set' && r.ok && Array.isArray(r.result?.plan)) {
          planState.done = new Set()
        } else if (call.tool === 'plan_check' && r.ok && Array.isArray(r.result?.checked)) {
          for (const i of r.result.checked) planState.done.add(Number(i))
        }
      }
      if (recentToolHistory.length > 40) recentToolHistory.splice(0, recentToolHistory.length - 40)

      // Feed every observation back into the conversation — one message
      // per native-tool call (so tool_call_id matches), or a single
      // textual block for the text protocol.
      for (const { call, r } of results) {
        const obsRaw = r.ok
          ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2))
          : 'ERROR: ' + r.error
        const obsContent = clipForLLM(obsRaw, provider?.model)

        if (call.nativeId) {
          convo.push({
            role: 'tool',
            tool_call_id: call.nativeId,
            name: call.tool,
            content: obsContent,
          })
        } else {
          convo.push({
            role: 'user',
            content: `[tool_result name="${call.tool}" ok=${r.ok}]\n${obsContent}\n[/tool_result]`,
          })
        }
      }
    }

    sse(res, 'error', { message: `Agent stopped after ${maxSteps} steps without a final answer` })
    sseDone(res, { steps: step, reason: 'max-steps' }, tokens)
    res.end()
  } catch (e) {
    sse(res, 'error', { message: e?.message || String(e) })
    sseDone(res, { steps: step, reason: 'crash' }, tokens)
    try { res.end() } catch { /* response already closed */ }
  }
}
