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

  if (!provider?.baseUrl || !provider?.apiKey) {
    sse(res, 'error', { message: 'Provider is not configured (baseUrl + apiKey required)' })
    sse(res, 'done', { steps: 0, reason: 'no-provider' })
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
  res.on('close', () => { aborted = true })

  try {
    while (step < maxSteps) {
      if (aborted) return
      if (Date.now() > deadline) {
        sse(res, 'error', { message: `Total deadline of ${DEFAULT_DEADLINE_MS / 1000}s exceeded after ${step} steps` })
        sse(res, 'done', { steps: step, reason: 'deadline' })
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
            sse(res, 'done', { steps: step, reason: 'llm-error' })
            res.end()
            return
          }
        } else {
          sse(res, 'error', { message: 'LLM call failed: ' + (e.message || String(e)) })
          sse(res, 'done', { steps: step, reason: 'llm-error' })
          res.end()
          return
        }
      }

      // Decide which tool path to follow
      let call = null
      if (useNativeTools && reply.toolCalls?.length > 0) {
        // Take the first tool call; loop handles them one at a time so the
        // model sees each result before deciding what's next.
        const tc = reply.toolCalls[0]
        if (TOOLS[tc.name]) {
          call = { tool: tc.name, args: tc.args || {}, nativeId: tc.id, nativeRaw: tc.raw }
        }
      }
      if (!call) {
        call = extractTextToolCall(reply.text)
      }

      if (!call) {
        // Heuristic safety net: did the user ask to fix/edit code but the
        // model dumped a fenced code block instead of calling edit_file?
        // This is the single most common 'agent gave up' failure mode —
        // especially on smaller models. Push back ONCE per turn.
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
        sse(res, 'done', { steps: step, reason: 'final' })
        res.end()
        return
      }

      // Echo the assistant turn so the model sees its own request next round.
      // For native tools we have to preserve the tool_calls structure so the
      // observation message can reference it via tool_call_id.
      if (call.nativeId) {
        convo.push({
          role: 'assistant',
          content: reply.text || '',
          tool_calls: [call.nativeRaw],
        })
      } else {
        convo.push({ role: 'assistant', content: reply.text || '' })
      }

      // Stream the intermediate reasoning (everything in reply.text except
      // the JSON envelope) to the UI so users see the model's plan in
      // real time, the way Arena's agent UI does.
      const thinkingText = call.nativeId
        ? (reply.text || '').trim()
        : (reply.text || '').replace(TOOL_FENCE_RE, '').trim()
      if (thinkingText) {
        sse(res, 'thought', { step, text: thinkingText })
      }

      sse(res, 'tool_start', { step, name: call.tool, args: call.args })

      let result
      if (call.tool === 'ask_user') {
        // Special-case: don't actually invoke the (no-op) handler. Open a
        // pending question, push it to the client UI via an SSE event,
        // and await the user's answer (or timeout).
        const { id: questionId, promise } = registerQuestion()
        sse(res, 'ask_user', {
          step,
          question_id: questionId,
          question: call.args?.question || '(no question)',
          options: Array.isArray(call.args?.options) ? call.args.options : [],
          multi: call.args?.multi !== false,
          allow_custom: call.args?.allow_custom !== false,
        })
        try {
          const answer = await promise
          result = { ok: true, result: answer }
        } catch (e) {
          result = { ok: false, error: e?.message || 'ask_user cancelled' }
        }
      } else {
        result = await invokeTool(call.tool, call.args)
      }

      sse(res, 'tool_result', {
        step,
        name: call.tool,
        ok: Boolean(result.ok),
        result: result.ok ? result.result : undefined,
        error: result.ok ? undefined : result.error,
      })

      // Feed the observation back. Two flavours depending on call path.
      const obsContent = result.ok
        ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2))
        : 'ERROR: ' + result.error

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
          content: `[tool_result name="${call.tool}" ok=${result.ok}]\n${obsContent}\n[/tool_result]`,
        })
      }
    }

    sse(res, 'error', { message: `Agent stopped after ${maxSteps} steps without a final answer` })
    sse(res, 'done', { steps: step, reason: 'max-steps' })
    res.end()
  } catch (e) {
    sse(res, 'error', { message: e?.message || String(e) })
    sse(res, 'done', { steps: step, reason: 'crash' })
    try { res.end() } catch { /* response already closed */ }
  }
}
