/**
 * agentLoop.js
 *
 * Multi-step LLM ↔ tool agent for chat.deepseek.com (managed session).
 *
 * Flow:
 *   1. Build a system prompt that lists every tool and demands a strict
 *      JSON envelope when the model wants to invoke one.
 *   2. Send {system, user_history} to DeepSeek via deepseekWeb.handleDeepSeekWebChat
 *      in *non-stream* mode (we need the whole response to parse JSON).
 *   3. Parse:
 *        - if the reply contains a fenced JSON block matching the tool
 *          schema, execute the tool and feed the result back as a new
 *          user turn, then loop.
 *        - otherwise treat the reply as the final answer and emit it.
 *   4. Hard limit: MAX_STEPS iterations (default 15) and TOTAL_DEADLINE_MS
 *      total wall time. The loop is wrapped by /api/agent/chat and the
 *      results are streamed back to the client as Server-Sent Events
 *      with these event types:
 *          event: thinking      data: {"step":N}
 *          event: tool_start    data: {"step":N,"name":..,"args":..}
 *          event: tool_result   data: {"step":N,"name":..,"ok":..,"result":..,"error":..}
 *          event: assistant     data: {"text":"final answer markdown"}
 *          event: done          data: {"steps":N}
 *          event: error         data: {"message":..}
 */
import {
  getActiveBearer,
  getCookieHeader,
  isSessionValid,
} from './deepseekTokenRefresher.js'
import { handleDeepSeekWebChat } from './deepseekWeb.js'
import { TOOLS, renderToolsForPrompt, invokeTool } from './agentTools.js'

const DEFAULT_MAX_STEPS = 15
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000  // 5 min total

const TOOL_FENCE_RE = /```(?:json|tool|tool_call)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/i

function buildSystemPrompt({ extraSystem = '' } = {}) {
  return [
    'You are an autonomous coding agent operating inside BrowserAI.',
    'You can read and write files in /workspace, search the web, fetch pages, and run shell commands in an isolated sandbox.',
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
    'Rules:',
    '  1. ALWAYS plan first: think about which tools you need before calling them.',
    '  2. Never invent tool names or parameters — only use what is listed below.',
    '  3. Read before write: if you are going to edit a file, read it first.',
    '  4. Prefer edit_file over write_file for small changes.',
    '  5. When done, write a concise Russian-language summary for the user.',
    '  6. If a tool fails, recover (try again with different args, or fall back).',
    '',
    '# Available tools',
    '',
    renderToolsForPrompt(),
    extraSystem ? '\n# Extra context\n\n' + extraSystem : '',
  ].filter(Boolean).join('\n')
}

/**
 * Try to extract a tool call from the model's reply.
 * Returns {tool, args} or null if no valid tool call was found.
 */
function extractToolCall(text = '') {
  const fence = TOOL_FENCE_RE.exec(text)
  const candidates = []
  if (fence) candidates.push(fence[1])
  // Also try the whole text in case the model forgot the fence
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

/**
 * Run DeepSeek once via the managed session and collect the full text reply.
 * We reuse handleDeepSeekWebChat in non-stream mode to keep auth/POW/cookies
 * logic in one place.
 */
async function callDeepSeek({ messages, model = 'deepseek_chat' }) {
  if (!isSessionValid()) {
    throw new Error('DeepSeek managed session is not configured or expired.')
  }
  const apiKey = getActiveBearer()
  const cookieHeader = getCookieHeader()

  // Build a fake `res` that just captures the JSON the adapter would
  // write. The adapter calls res.json({...}) once for non-stream.
  let captured = null
  let statusCode = 200
  const fakeRes = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: () => {},
    end: () => {},
    on: () => {},
    headersSent: false,
    status(code) { statusCode = code; return this },
    json(obj) { captured = obj; return this },
  }

  await handleDeepSeekWebChat({
    reqBody: {
      baseUrl: 'https://chat.deepseek.com/api/v0',
      apiKey,
      authType: 'bearer',
      model,
      messages,
      stream: false,
      extraHeaders: {
        Cookie: cookieHeader,
        Referer: 'https://chat.deepseek.com/',
        Origin: 'https://chat.deepseek.com',
      },
    },
    res: fakeRes,
  })

  if (statusCode >= 400 || !captured) {
    throw new Error(`DeepSeek returned status ${statusCode}: ${JSON.stringify(captured)?.slice(0, 400)}`)
  }
  const text = captured?.choices?.[0]?.message?.content || ''
  return String(text || '')
}

/**
 * SSE write helper.
 */
function sse(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch { /* response closed */ }
}

/**
 * Main agent loop. Streams events to `res` as the model thinks/acts.
 *
 * @param {object} opts
 * @param {Array<{role,content}>} opts.history  full chat history including the latest user turn
 * @param {string} [opts.model]                  'deepseek_chat' or 'deepseek_reasoner'
 * @param {number} [opts.maxSteps]
 * @param {string} [opts.extraSystem]
 * @param {object} opts.res                      HTTP response (SSE)
 */
export async function runAgent({
  history = [],
  model = 'deepseek_chat',
  maxSteps = DEFAULT_MAX_STEPS,
  extraSystem = '',
  res,
}) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const systemPrompt = buildSystemPrompt({ extraSystem })

  // Conversation we send back to DeepSeek every step.
  // We keep the user-visible history (system + user + assistant) and
  // append every tool result as a fresh user turn ("user role" message
  // tagged [tool_result]) so the model treats it as observation input.
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

      let reply
      try {
        reply = await callDeepSeek({ messages: convo, model })
      } catch (e) {
        sse(res, 'error', { message: 'DeepSeek call failed: ' + (e.message || String(e)) })
        sse(res, 'done', { steps: step, reason: 'llm-error' })
        res.end()
        return
      }

      const call = extractToolCall(reply)

      if (!call) {
        // Final answer — emit and finish
        sse(res, 'assistant', { text: reply })
        sse(res, 'done', { steps: step, reason: 'final' })
        res.end()
        return
      }

      // Echo the model's tool call to the history so it sees its own request
      convo.push({ role: 'assistant', content: reply })

      sse(res, 'tool_start', { step, name: call.tool, args: call.args })

      const result = await invokeTool(call.tool, call.args)

      sse(res, 'tool_result', {
        step,
        name: call.tool,
        ok: Boolean(result.ok),
        result: result.ok ? result.result : undefined,
        error: result.ok ? undefined : result.error,
      })

      // Append observation back into the conversation
      convo.push({
        role: 'user',
        content: `[tool_result name="${call.tool}" ok=${result.ok}]\n${
          result.ok
            ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2))
            : 'ERROR: ' + result.error
        }\n[/tool_result]`,
      })
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
