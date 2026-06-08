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
