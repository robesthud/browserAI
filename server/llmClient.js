/**
 * llmClient.js
 *
 * Provider-agnostic LLM call used by the agent loop.
 *
 * Two transport paths:
 *   1. DeepSeek managed session — uses our existing handleDeepSeekWebChat
 *      (POW + cookies + non-OpenAI body). Triggered when the request is
 *      addressed to chat.deepseek.com/api/v0.
 *   2. Everything else — plain OpenAI-compatible POST /chat/completions.
 *      Works with BigModel, OpenAI, Groq, Together, OpenRouter, Mistral,
 *      Gemini's OpenAI proxy, Grok, etc.
 *
 * Native function-calling
 * -----------------------
 * If `tools` is provided, we attempt the standard OpenAI `tools[]` /
 * `tool_choice` schema. If the provider returns assistant.tool_calls in
 * the response, we surface them as the structured `toolCalls` field;
 * otherwise the caller falls back to parsing JSON inside the text.
 *
 * The DeepSeek managed transport does NOT support native tools (their
 * /chat/completion endpoint is not OpenAI compatible), so we always
 * fall back to JSON-in-text there.
 */
import { isDeepSeekWebUrl, handleDeepSeekWebChat } from './deepseekWeb.js'
import { buildSessionHeaders } from './stealthHeaders.js'

// ── Helpers ─────────────────────────────────────────────────────────────────
function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '')
}

function safeJsonParse(text) {
  try { return JSON.parse(text) } catch { return null }
}

// ── DeepSeek managed transport ──────────────────────────────────────────────
async function callDeepSeekManaged({ baseUrl, apiKey, model, messages, extraHeaders }) {
  let captured = null
  let statusCode = 200
  const fakeRes = {
    setHeader: () => {}, flushHeaders: () => {}, write: () => {}, end: () => {},
    on: () => {}, headersSent: false,
    status(code) { statusCode = code; return this },
    json(obj) { captured = obj; return this },
  }

  await handleDeepSeekWebChat({
    reqBody: {
      baseUrl,
      apiKey,
      authType: 'bearer',
      model: model || 'deepseek_chat',
      messages,
      stream: false,
      extraHeaders: extraHeaders || {},
    },
    res: fakeRes,
  })

  if (statusCode >= 400 || !captured) {
    throw new Error(`DeepSeek returned ${statusCode}: ${JSON.stringify(captured)?.slice(0, 400)}`)
  }
  const text = captured?.choices?.[0]?.message?.content || ''
  return { text: String(text || ''), toolCalls: [], usage: null }
}

// ── OpenAI-compatible transport ─────────────────────────────────────────────
async function callOpenAICompatible({
  baseUrl, apiKey, authType = 'bearer', authHeader = '',
  extraHeaders = {}, model, messages, temperature = 0.7,
  tools, toolChoice = 'auto',
}) {
  const headers = {
    'Content-Type': 'application/json',
    ...buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders }),
  }
  // buildSessionHeaders sets Authorization for bearer; for cookie/custom
  // it sets the respective header. We strip duplicates with normalized keys.

  const body = {
    model,
    messages,
    temperature,
    stream: false,
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    body.tool_choice = toolChoice
  }

  const url = joinUrl(baseUrl, 'chat/completions')
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })

  const raw = await r.text()
  if (!r.ok) {
    throw new Error(`Provider HTTP ${r.status} from ${url}: ${raw.slice(0, 400)}`)
  }

  const data = safeJsonParse(raw)
  if (!data) {
    throw new Error(`Provider returned non-JSON: ${raw.slice(0, 400)}`)
  }

  const choice = data?.choices?.[0]
  const msg = choice?.message || {}

  // OpenAI native tool calls: [{id, type:"function", function:{name, arguments}}]
  const nativeToolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls
        .filter((tc) => tc?.type === 'function' && tc?.function?.name)
        .map((tc) => ({
          id: tc.id || null,
          name: tc.function.name,
          args: safeJsonParse(tc.function.arguments || '{}') || {},
          raw: tc,
        }))
    : []

  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: nativeToolCalls,
    // Pass through provider-side token accounting so the agent loop can
    // surface running cost in the UI ('1.2k → 800 tok ≈ $0.003').
    usage: data?.usage ? {
      prompt: Number(data.usage.prompt_tokens || data.usage.input_tokens || 0),
      completion: Number(data.usage.completion_tokens || data.usage.output_tokens || 0),
      total: Number(data.usage.total_tokens || 0),
    } : null,
  }
}

// ── OpenAI-compatible STREAMING transport ────────────────────────────────────
//
// True provider-side SSE streaming. Used by callLLMStream() to get
// chunks of `content` / `tool_calls` as the model generates them,
// instead of the all-or-nothing path of callOpenAICompatible.
//
// Hooks:
//   onTextDelta(chunk)                        — every content chunk
//   onToolCallDelta({ idx, id?, name?, argsDelta? })
//                                              — every tool_calls chunk
//                                              (OpenAI streams them by
//                                              index; we forward as-is)
//   onUsage(usage)                            — final usage block, if any
//
// Returns { text, toolCalls, usage } at end-of-stream, same shape as
// the non-streaming variant.
async function callOpenAICompatibleStream({
  baseUrl, apiKey, authType = 'bearer', authHeader = '',
  extraHeaders = {}, model, messages, temperature = 0.7,
  tools, toolChoice = 'auto', signal,
  onTextDelta, onToolCallDelta, onUsage,
}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    ...buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders }),
  }
  const body = {
    model, messages, temperature,
    stream: true,
    stream_options: { include_usage: true }, // OpenAI: usage in final chunk
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    body.tool_choice = toolChoice
  }

  const url = joinUrl(baseUrl, 'chat/completions')
  const r = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(180_000),
  })
  if (!r.ok) {
    const raw = await r.text().catch(() => '')
    throw new Error(`Provider HTTP ${r.status} from ${url}: ${raw.slice(0, 400)}`)
  }
  if (!r.body) throw new Error('Provider returned no body for stream')

  // SSE assembler. Lines arrive as:
  //   data: {...json...}
  //   data: [DONE]
  let text = ''
  const toolByIdx = new Map() // idx → { id, name, argsBuf }
  let usage = null

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let stopped = false

  while (!stopped) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nlIdx
    while ((nlIdx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nlIdx).trim()
      buf = buf.slice(nlIdx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') { stopped = true; break }
      const chunk = safeJsonParse(payload)
      if (!chunk) continue
      const choice = chunk?.choices?.[0]
      const delta = choice?.delta || {}
      // Text content
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        try { onTextDelta?.(delta.content) } catch { /* hook errors must not kill stream */ }
      }
      // Native tool_calls (OpenAI stream-delta form)
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number.isInteger(tc?.index) ? tc.index : 0
          let slot = toolByIdx.get(idx)
          if (!slot) {
            slot = { id: '', name: '', argsBuf: '' }
            toolByIdx.set(idx, slot)
          }
          if (tc.id)                  slot.id   = tc.id
          if (tc.function?.name)      slot.name = tc.function.name
          if (typeof tc.function?.arguments === 'string') {
            slot.argsBuf += tc.function.arguments
          }
          try {
            onToolCallDelta?.({
              idx,
              id: slot.id || null,
              name: slot.name || null,
              argsDelta: tc.function?.arguments || '',
              argsBuf: slot.argsBuf,
            })
          } catch { /* ignore */ }
        }
      }
      // Provider-side "extended thinking" / reasoning streams. Four
      // shapes we care about — surfaced via the same onTextDelta hook
      // with kind:'thinking' so the UI can render them as a collapsed
      // block above the visible answer:
      //
      //   • Anthropic:   delta.reasoning (string)            — Claude 3.7+
      //   • OpenAI:      delta.reasoning.content (string)    — o1/o3 stream
      //   • DeepSeek R1: delta.reasoning_content (string)
      //   • Generic:     delta.thinking (string)             — some proxies
      //
      // All four are fed back as one logical "thinking" stream — the UI
      // appends them in arrival order into a single foldable block.
      let thinkingChunk = ''
      if (typeof delta.reasoning === 'string'        && delta.reasoning)         thinkingChunk += delta.reasoning
      else if (delta.reasoning && typeof delta.reasoning.content === 'string')   thinkingChunk += delta.reasoning.content
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) thinkingChunk += delta.reasoning_content
      if (typeof delta.thinking === 'string'         && delta.thinking)          thinkingChunk += delta.thinking
      if (thinkingChunk) {
        try { onTextDelta?.(thinkingChunk, { kind: 'thinking' }) } catch { /* ignore */ }
      }
      // Usage on the last chunk
      if (chunk.usage) {
        usage = {
          prompt:           Number(chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0),
          completion:       Number(chunk.usage.completion_tokens || chunk.usage.output_tokens || 0),
          total:            Number(chunk.usage.total_tokens || 0),
          // OpenAI o1: completion_tokens_details.reasoning_tokens
          // Anthropic: usage.thinking_tokens (newer Claude)
          reasoningTokens:  Number(
            chunk.usage.completion_tokens_details?.reasoning_tokens
            || chunk.usage.reasoning_tokens
            || chunk.usage.thinking_tokens
            || 0
          ),
        }
        try { onUsage?.(usage) } catch { /* ignore */ }
      }
    }
  }

  const toolCalls = [...toolByIdx.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => ({
      id: slot.id || null,
      name: slot.name,
      args: safeJsonParse(slot.argsBuf || '{}') || {},
      raw: { id: slot.id, function: { name: slot.name, arguments: slot.argsBuf } },
    }))
    .filter((tc) => tc.name)
  return { text, toolCalls, usage }
}

// ── Public ──────────────────────────────────────────────────────────────────
/**
 * Call an LLM and return { text, toolCalls }. Provider-agnostic.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role,content}>} opts.messages
 * @param {string} [opts.authType='bearer']
 * @param {string} [opts.authHeader='']
 * @param {object} [opts.extraHeaders={}]
 * @param {number} [opts.temperature=0.7]
 * @param {Array}  [opts.tools]           OpenAI-style tool schema
 * @param {string} [opts.toolChoice='auto']
 * @returns {Promise<{text: string, toolCalls: Array}>}
 */
export async function callLLM(opts) {
  if (!opts?.baseUrl || !opts?.apiKey) {
    throw new Error('callLLM: baseUrl and apiKey are required')
  }
  if (isDeepSeekWebUrl(opts.baseUrl)) {
    // DeepSeek managed transport — no native tools support.
    return callDeepSeekManaged({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      extraHeaders: opts.extraHeaders || {},
    })
  }
  return callOpenAICompatible(opts)
}

/**
 * Streaming counterpart of callLLM(). Calls onTextDelta()/onToolCallDelta()
 * as the provider emits chunks; resolves with the final {text, toolCalls,
 * usage} aggregate when the stream completes.
 *
 * For DeepSeek managed transport we don't have provider-side SSE, so we
 * fall back to a non-streaming call and emit a single fake delta at the
 * end to keep the caller's interface uniform.
 */
export async function callLLMStream(opts) {
  if (!opts?.baseUrl || !opts?.apiKey) {
    throw new Error('callLLMStream: baseUrl and apiKey are required')
  }
  if (isDeepSeekWebUrl(opts.baseUrl)) {
    const res = await callDeepSeekManaged({
      baseUrl: opts.baseUrl, apiKey: opts.apiKey,
      model: opts.model, messages: opts.messages,
      extraHeaders: opts.extraHeaders || {},
    })
    try { if (res?.text) opts.onTextDelta?.(res.text) } catch { /* ignore */ }
    try { if (res?.usage) opts.onUsage?.(res.usage) } catch { /* ignore */ }
    return res
  }
  return callOpenAICompatibleStream(opts)
}

/**
 * Heuristic — does this provider stream cleanly on SSE? Practically all
 * OpenAI-compatible endpoints do, but some flaky regional proxies cache
 * the response and break streaming; we expose a hook to opt out via env.
 */
export function supportsStreaming(baseUrl = '') {
  if (isDeepSeekWebUrl(baseUrl)) return false // soft-fallback handled inside callLLMStream
  if (String(process.env.BROWSERAI_DISABLE_STREAMING || '').trim()) return false
  return true
}

/**
 * Whether the given baseUrl is known to support OpenAI-style native
 * function calling. We use this to decide whether to attach the
 * `tools` parameter on the first call (and fall back to JSON-in-text
 * if the provider ignored it).
 */
export function supportsNativeTools(baseUrl = '') {
  if (isDeepSeekWebUrl(baseUrl)) return false
  const u = String(baseUrl).toLowerCase()
  return (
    u.includes('api.openai.com')    ||
    u.includes('open.bigmodel.cn')  ||
    u.includes('api.deepseek.com')  ||
    u.includes('api.groq.com')      ||
    u.includes('api.mistral.ai')    ||
    u.includes('api.together.xyz')  ||
    u.includes('openrouter.ai')     ||
    u.includes('generativelanguage.googleapis.com')
  )
}
