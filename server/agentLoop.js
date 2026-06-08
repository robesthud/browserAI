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
 * Two tool-calling strategies, picked per call:
 *   - NATIVE: providers that speak OpenAI's tools[] / tool_calls schema
 *     (see supportsNativeTools()) get the structured channel — more
 *     reliable, no JSON-parsing-from-text required.
 *   - TEXT:   everyone else (DeepSeek managed in particular) sees a
 *     plain-text system prompt that asks for a single fenced JSON
 *     envelope per tool invocation. We parse that envelope out of
 *     the model reply.
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

const DEFAULT_MAX_STEPS = 15
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000

const TOOL_FENCE_RE = /```(?:json|tool|tool_call)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/i

// ── System prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt({ extraSystem = '', native = false } = {}) {
  const head = [
    'You are an autonomous coding agent operating inside BrowserAI.',
    'You can read and write files in /workspace, search the web, fetch pages, and run shell commands in an isolated sandbox.',
    '',
    '# Hard rules — non-negotiable',
    '',
    '  1. **Never** paste source code, patches, or diffs in your chat reply. If',
    '     the user asks you to "fix bugs", "improve", "rewrite", "refactor",',
    '     "change", "edit", "add a feature" — you MUST apply the change',
    '     to the actual file via `edit_file` or `write_file`. A reply that',
    '     shows code in markdown without first calling a tool is a BUG.',
    '',
    '  2. **Always read before you write.** Call `read_file` before',
    '     `edit_file`/`write_file` so the patch is based on the current',
    '     contents, not an assumption.',
    '',
    '  3. **Prefer `edit_file`** over `write_file` for any change touching',
    '     less than 80% of the file. `write_file` replaces the entire file',
    '     and loses parts you forgot to include.',
    '',
    '  4. **Verify your work.** After a batch of edits run `verify_code`',
    '     (syntax / lint / tests). If it fails — fix and re-verify. Never',
    '     declare success without `verify_code` passing on touched files.',
    '',
    '  5. **Report only real, observed work.** Your final summary must list',
    '     each tool call you actually made (file paths, commit ids, command',
    '     exit codes — facts from tool results). Do NOT invent steps, files,',
    '     or numbers. If something failed, say so plainly.',
    '',
    '  6. Never invent tool names or parameter names — only what is listed',
    '     below. If a needed tool is missing, say so and ask the user.',
    '',
    '  7. Dangerous ops (deploy / restart / delete repo / drop DB) require',
    '     `ask_user` confirmation BEFORE calling `ops_run_action` with',
    '     `confirm:true`.',
    '',
    '# Standard workflow for code-change requests',
    '',
    '  1. `list_files` or `search_files` to locate the relevant files (skip',
    '     if the user already gave exact paths).',
    '  2. `read_file` each target file.',
    '  3. `edit_file` (small surgical replacement) — repeat per file.',
    '  4. `verify_code` on the touched paths.',
    '  5. If asked, `git_status` / `git_diff` to show what changed.',
    '  6. Write a short Russian-language SUMMARY listing only what you',
    '     really did: bullet points like "✓ server/foo.js: исправил X",',
    '     "✓ verify_code: ok", with file paths from your own tool calls.',
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
        'When you need to use a tool, reply with EXACTLY one fenced JSON block — nothing else in the message:',
        '```json',
        '{"tool":"<tool_name>","args":{...}}',
        '```',
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
    renderToolsForPrompt(),
    extraSystem ? '\n# Extra context\n\n' + extraSystem : '',
  ].filter(Boolean)

  return [...head, ...callingHelp, ...tail].join('\n')
}

// ── OpenAI-format tools[] schema, built from our registry ───────────────────
function buildNativeToolsSpec() {
  return Object.entries(TOOLS).map(([name, def]) => {
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
const TOOL_OUTPUT_HEAD = Number(process.env.TOOL_OUTPUT_HEAD || 6000)
const TOOL_OUTPUT_TAIL = Number(process.env.TOOL_OUTPUT_TAIL || 2000)
function clipForLLM(s) {
  const str = String(s || '')
  const max = TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL + 200
  if (str.length <= max) return str
  const head = str.slice(0, TOOL_OUTPUT_HEAD)
  const tail = str.slice(-TOOL_OUTPUT_TAIL)
  const hidden = str.length - TOOL_OUTPUT_HEAD - TOOL_OUTPUT_TAIL
  return `${head}\n\n… [${hidden} characters omitted to keep context small — run with a more specific filter to see the middle] …\n\n${tail}`
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
function extractTextToolCall(text = '') {
  const fence = TOOL_FENCE_RE.exec(text)
  const candidates = []
  if (fence) candidates.push(fence[1])
  const trimmed = String(text).trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed)
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw)
      if (obj && typeof obj.tool === 'string' && TOOLS[obj.tool]) {
        return { tool: obj.tool, args: obj.args || {} }
      }
    } catch { /* try next */ }
  }
  return null
}

// ── SSE helper ──────────────────────────────────────────────────────────────
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* closed */ }
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
  return withWorkspaceScope(opts?.workspaceScope || '', () => runAgentInner(opts || {}))
}

async function runAgentInner({
  provider,
  history = [],
  maxSteps = DEFAULT_MAX_STEPS,
  extraSystem = '',
  res,
}) {
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

  let useNativeTools = supportsNativeTools(provider.baseUrl)
  let systemPrompt = buildSystemPrompt({ extraSystem, native: useNativeTools })
  let toolsSpec = useNativeTools ? buildNativeToolsSpec() : undefined

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
      sse(res, 'thinking', { step })

      // Call the LLM. Some OpenAI-compatible endpoints advertise a familiar
      // base URL but a concrete model does not support native tool calling.
      // In that case, fall back to the universal JSON-in-text tool protocol.
      let reply
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
      if (reply?.usage) sse(res, 'usage', { step, ...reply.usage, totals: { ...tokens } })

      // Decide which tool path(s) to follow.
      // PARALLEL TOOLS: when the provider returns more than one tool_calls
      // entry in a single assistant message, we run them ALL concurrently
      // and feed every result back before the next LLM round. This is a
      // 3-5x speed-up on read-heavy turns ("read these 5 files").
      let calls = []
      if (useNativeTools && Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) {
        for (const tc of reply.toolCalls) {
          if (TOOLS[tc.name]) {
            calls.push({ tool: tc.name, args: tc.args || {}, nativeId: tc.id, nativeRaw: tc.raw })
          }
        }
      }
      if (calls.length === 0) {
        const textCall = extractTextToolCall(reply.text)
        if (textCall) calls = [textCall]
      }

      if (calls.length === 0) {
        // Heuristic safety net: did the user ask to fix/edit code but the
        // model dumped a fenced code block instead of calling edit_file?
        if (looksLikeUnapplliedCodeReply(reply.text, history) && !aborted) {
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
        sse(res, 'assistant', { text: reply.text || '' })
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

      // Run all tools in parallel. ask_user is sequential within its own
      // dispatch (it blocks waiting for the user) — it should rarely be
      // batched with other calls, but if a model does it, we await both.
      const results = await Promise.all(calls.map(async (call, idx) => {
        sse(res, 'tool_start', { step, sub: idx, name: call.tool, args: call.args })
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
          r = await invokeTool(call.tool, call.args, {
            signal: abortCtl.signal,
            onStdout: (c) => onProgress(c, 'stdout'),
            onStderr: (c) => onProgress(c, 'stderr'),
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

      // Feed every observation back into the conversation — one message
      // per native-tool call (so tool_call_id matches), or a single
      // textual block for the text protocol.
      for (const { call, r } of results) {
        const obsRaw = r.ok
          ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2))
          : 'ERROR: ' + r.error
        const obsContent = clipForLLM(obsRaw)

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
