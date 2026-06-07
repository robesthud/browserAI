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
import { callLLM, supportsNativeTools } from './llmClient.js'

const DEFAULT_MAX_STEPS = 15
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000

const TOOL_FENCE_RE = /```(?:json|tool|tool_call)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/i

// ── System prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt({ extraSystem = '', native = false } = {}) {
  const head = [
    'You are an autonomous coding agent operating inside BrowserAI.',
    'You can read and write files in /workspace, search the web, fetch pages, and run shell commands in an isolated sandbox.',
    '',
  ]
  const rules = [
    'Rules:',
    '  1. ALWAYS plan first — think about which tools you need before calling them.',
    '  2. Never invent tool names or parameters — only use what is listed below.',
    '  3. Read before write: if you are going to edit a file, read it first.',
    '  4. Prefer edit_file over write_file for small changes.',
    '  5. When done, write a concise Russian-language summary for the user.',
    '  6. If a tool fails, recover (try again with different args, or fall back).',
    '',
  ]
  const callingHelp = native
    ? [
        'Call tools using the standard function-calling interface of this provider.',
        'Only call tools that are listed in the available tool spec below; do not invent names.',
        'When you have the final answer for the user, reply with plain markdown (no tool call).',
        '',
      ]
    : [
        'When you need to use a tool, reply with EXACTLY one fenced JSON block — nothing else in the message:',
        '```json',
        '{"tool":"<tool_name>","args":{...}}',
        '```',
        '',
        'After you receive a tool result you may either:',
        '  • call another tool (same JSON envelope), or',
        '  • give the user the final answer as plain markdown (no JSON envelope).',
        '',
      ]
  const tail = [
    '# Available tools',
    '',
    renderToolsForPrompt(),
    extraSystem ? '\n# Extra context\n\n' + extraSystem : '',
  ].filter(Boolean)

  return [...head, ...callingHelp, ...rules, ...tail].join('\n')
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
export async function runAgent({
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

  const useNativeTools = supportsNativeTools(provider.baseUrl)
  const systemPrompt = buildSystemPrompt({ extraSystem, native: useNativeTools })
  const toolsSpec = useNativeTools ? buildNativeToolsSpec() : undefined

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

      // Call the LLM
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
        sse(res, 'error', { message: 'LLM call failed: ' + (e.message || String(e)) })
        sse(res, 'done', { steps: step, reason: 'llm-error' })
        res.end()
        return
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

      const result = await invokeTool(call.tool, call.args)

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
    try { res.end() } catch {}
  }
}
