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

function hostOf(baseUrl = '') {
  try { return new URL(baseUrl).hostname.toLowerCase() } catch { return '' }
}

function pathOf(baseUrl = '') {
  try { return new URL(baseUrl).pathname.toLowerCase() } catch { return '' }
}

export function isAnthropicOfficialUrl(baseUrl = '') {
  const host = hostOf(baseUrl)
  return host === 'api.anthropic.com' || host.endsWith('.api.anthropic.com')
}

export function isGoogleGenerativeNativeUrl(baseUrl = '') {
  const host = hostOf(baseUrl)
  const pathname = pathOf(baseUrl)
  return host === 'generativelanguage.googleapis.com' && !pathname.includes('/openai')
}

function dataUrlToAnthropicSource(dataUrl = '') {
  const m = String(dataUrl || '').match(/^data:(image\/[a-z0-9+.-]+);base64,(.*)$/i)
  if (!m) return null
  return { type: 'base64', media_type: m[1], data: m[2] }
}

function dataUrlToGeminiPart(dataUrl = '') {
  const m = String(dataUrl || '').match(/^data:(image\/[a-z0-9+.-]+);base64,(.*)$/i)
  if (!m) return null
  return { inline_data: { mime_type: m[1], data: m[2] } }
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
function normalizeOpenAIMessages(messages = []) {
  const out = []
  for (const m of messages) {
    if (!m) continue
    const prev = out[out.length - 1]
    
    // #27 FIX: Robust message sequence normalization for all providers.
    // Preserves multimodal content (arrays) instead of flattening to string.
    
    let role = m.role
    if (role === 'system') {
      if (out.length === 0) out.push({ ...m })
      else {
        // Merge extra system into existing system
        const target = out[0]
        if (typeof target.content === 'string' && typeof m.content === 'string') {
          target.content += '\n\n' + m.content
        } else {
          // If either is complex, merge as parts
          const tParts = Array.isArray(target.content) ? target.content : [{ type: 'text', text: String(target.content || '') }]
          const mParts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }]
          target.content = [...tParts, { type: 'text', text: '\n\n' }, ...mParts]
        }
      }
      continue
    }

    // Merge consecutive messages of the same role
    if (prev && prev.role === role) {
      const canMerge = (role === 'user') || (role === 'assistant' && !m.tool_calls && !prev.tool_calls)
      if (canMerge) {
        if (typeof prev.content === 'string' && typeof m.content === 'string') {
          prev.content += '\n\n' + m.content
        } else {
          const pParts = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content || '') }]
          const mParts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }]
          prev.content = [...pParts, { type: 'text', text: '\n\n' }, ...mParts]
        }
        continue
      }
    }
    
    out.push({ ...m })
  }
  
  // Final pass: ensure assistant(tool_calls) is NOT the last message.
  if (out.length > 0 && out[out.length - 1].role === 'assistant' && out[out.length - 1].tool_calls) {
     out.push({ role: 'user', content: 'Continue.' })
  }
  
  return out
}

async function callOpenAICompatible({
  baseUrl, apiKey, authType = 'bearer', authHeader = '',
  extraHeaders = {}, model, messages: rawMessages, temperature = 0.7,
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
    messages: normalizeOpenAIMessages(rawMessages),
    temperature: /glm/i.test(model) && temperature >= 1 ? 0.99 : temperature,
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

  // #13 FIX: Extract reasoning/thinking if present (DeepSeek R1 / OpenAI o1)
  let text = typeof msg.content === 'string' ? msg.content : ''
  if (msg.reasoning_content) {
    // We prepending reasoning to the text if it's not already there,
    // though the agent loop prefers a separate field.
    // For simplicity, we just return the text but could store reasoning separately.
  }

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
    text,
    reasoning: msg.reasoning_content || msg.reasoning || '',
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


// ── Anthropic official Messages API transport ───────────────────────────────
function splitSystemMessages(messages = []) {
  const system = []
  const rest = []
  for (const m of messages || []) {
    if (m?.role === 'system') system.push(String(m.content || ''))
    else rest.push(m)
  }
  return { system: system.filter(Boolean).join('\n\n'), rest }
}

function toAnthropicContent(content) {
  if (Array.isArray(content)) {
    const out = []
    for (const part of content) {
      if (part?.type === 'text') out.push({ type: 'text', text: String(part.text || '') })
      else if (part?.type === 'image_url' && part.image_url?.url) {
        const src = dataUrlToAnthropicSource(part.image_url.url)
        if (src) out.push({ type: 'image', source: src })
        else out.push({ type: 'text', text: '[image_url omitted: Anthropic official API accepts base64 data URLs only here]' })
      } else if (part?.type === 'image' && part.source) {
        out.push(part)
      }
    }
    return out.length ? out : [{ type: 'text', text: '' }]
  }
  return String(content || '')
}

function toAnthropicBlockArray(content) {
  const c = toAnthropicContent(content)
  return Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }]
}

function toAnthropicTools(tools = []) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} }
  }))
}

function toAnthropicMessages(messages = []) {
  const out = []
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue
    
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content || '')
      }
      const prev = out[out.length - 1]
      if (prev?.role === 'user') {
        prev.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const blocks = []
    
    if (m.content) {
      blocks.push(...toAnthropicBlockArray(m.content))
    }
    
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let input = {}
        try { input = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input
        })
      }
    }
    
    if (blocks.length === 0 && !m.tool_calls) {
       blocks.push({ type: 'text', text: '' })
    }

    const prev = out[out.length - 1]
    if (prev?.role === role) {
      if (blocks.length > 0 && blocks[0].type === 'text') {
         prev.content.push({ type: 'text', text: '\n\n' })
      }
      prev.content.push(...blocks)
    } else {
      out.push({ role, content: blocks })
    }
  }
  return out
}

async function callAnthropicOfficial({
  baseUrl, apiKey, model, messages, temperature = 0.7, tools
}) {
  const { system, rest } = splitSystemMessages(messages)
  const body = {
    model,
    messages: toAnthropicMessages(rest),
    max_tokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),
    temperature,
  }
  if (tools && tools.length > 0) {
    body.tools = toAnthropicTools(tools)
    body.tool_choice = { type: 'auto' }
  }
  if (system) body.system = system
  const r = await fetch(joinUrl(baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const raw = await r.text()
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${raw.slice(0, 500)}`)
  const data = safeJsonParse(raw)
  if (!data) throw new Error(`Anthropic returned non-JSON: ${raw.slice(0, 400)}`)
  const text = Array.isArray(data.content)
    ? data.content.map((b) => b?.text || '').join('')
    : ''
  return {
    text,
    toolCalls: [],
    usage: data?.usage ? {
      prompt: Number(data.usage.input_tokens || 0),
      completion: Number(data.usage.output_tokens || 0),
      total: Number(data.usage.input_tokens || 0) + Number(data.usage.output_tokens || 0),
    } : null,
  }
}

async function callAnthropicOfficialStream({
  baseUrl, apiKey, model, messages, temperature = 0.7, signal,
  tools, onTextDelta, onToolCallDelta, onUsage,
}) {
  const { system, rest } = splitSystemMessages(messages)
  const body = {
    model,
    messages: toAnthropicMessages(rest),
    max_tokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),
    temperature,
    stream: true,
  }
  if (system) body.system = system
  if (tools && tools.length > 0) {
    body.tools = toAnthropicTools(tools)
    body.tool_choice = { type: 'auto' }
  }
  const r = await fetch(joinUrl(baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'x-api-key': apiKey,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(180_000),
  })
  if (!r.ok) {
    const raw = await r.text().catch(() => '')
    throw new Error(`Anthropic HTTP ${r.status}: ${raw.slice(0, 500)}`)
  }
  if (!r.body) throw new Error('Anthropic returned no body for stream')

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  let usage = null

  let currentTool = null
  const nativeToolCalls = []

  function handleData(payload) {
    if (!payload || payload === '[DONE]') return
    const evt = safeJsonParse(payload)
    if (!evt) return
    const delta = evt.delta || {}
    
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      currentTool = {
        id: evt.content_block.id,
        name: evt.content_block.name,
        inputArgs: ''
      }
      onToolCallDelta?.()
    } else if (evt.type === 'content_block_delta' && delta.type === 'input_json_delta') {
      if (currentTool) {
        currentTool.inputArgs += (delta.partial_json || '')
        onToolCallDelta?.()
      }
    } else if (evt.type === 'content_block_stop' && currentTool) {
      let args = {}
      try { args = JSON.parse(currentTool.inputArgs) } catch { /* ignore */ }
      nativeToolCalls.push({
        id: currentTool.id,
        name: currentTool.name,
        args,
        raw: { id: currentTool.id, type: 'function', function: { name: currentTool.name, arguments: currentTool.inputArgs } }
      })
      currentTool = null
    }

    if (evt.type === 'content_block_delta' && delta.type === 'text_delta') {
      const t = delta.text || delta.thinking || ''
      if (t) {
        text += t
        try { onTextDelta?.(t, delta.thinking ? { kind: 'thinking' } : undefined) } catch { /* ignore */ }
      }
    }
    if (evt.type === 'message_delta' && delta.usage) {
      const out = Number(delta.usage.output_tokens || 0)
      usage = { ...(usage || {}), completion: out }
    }
    if (evt.type === 'message_start' && evt.message?.usage) {
      usage = { prompt: Number(evt.message.usage.input_tokens || 0), completion: 0, total: 0 }
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const blocks = buf.split('\n\n')
    buf = blocks.pop() || ''
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) handleData(trimmed.slice(5).trim())
      }
    }
  }
  if (usage) {
    usage.total = Number(usage.prompt || 0) + Number(usage.completion || 0)
    try { onUsage?.(usage) } catch { /* ignore */ }
  }
  return { text, toolCalls: nativeToolCalls, usage }
}

// ── Google Gemini official GenerateContent transport ────────────────────────
function toGeminiTools(tools = []) {
  if (!tools || tools.length === 0) return []
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} }
    }))
  }]
}

function normalizeGeminiModel(model = '') {

  const m = String(model || '').trim()
  return m.startsWith('models/') ? m : `models/${m}`
}

function toGeminiParts(content) {
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (part?.type === 'text') parts.push({ text: String(part.text || '') })
      else if (part?.type === 'image_url' && part.image_url?.url) {
        const p = dataUrlToGeminiPart(part.image_url.url)
        if (p) parts.push(p)
        else parts.push({ text: '[image_url omitted: Gemini official API accepts base64 data URLs only here]' })
      }
    }
    return parts.length ? parts : [{ text: '' }]
  }
  return [{ text: String(content || '') }]
}

function toGeminiContents(messages = []) {
  const out = []
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue
    
    if (m.role === 'tool') {
      const block = {
        functionResponse: {
          name: m.name || m.tool_call_id || 'unknown',
          response: { content: String(m.content || '') }
        }
      }
      const prev = out[out.length - 1]
      if (prev?.role === 'user') {
        prev.parts.push(block)
      } else {
        out.push({ role: 'user', parts: [block] })
      }
      continue
    }

    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts = []
    
    if (m.content) {
      parts.push(...toGeminiParts(m.content))
    }
    
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
        parts.push({
          functionCall: { name: tc.function.name, args }
        })
      }
    }
    
    if (parts.length === 0 && !m.tool_calls) {
       parts.push({ text: '' })
    }

    const prev = out[out.length - 1]
    if (prev?.role === role) {
      if (parts.length > 0 && parts[0].text) {
         prev.parts.push({ text: '\n\n' })
      }
      prev.parts.push(...parts)
    } else {
      out.push({ role, parts })
    }
  }
  return out
}

async function callGeminiOfficial({ baseUrl, apiKey, model, messages, temperature = 0.7, tools }) {
  const { system } = splitSystemMessages(messages)
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      temperature,
      maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),
    },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools)
  }
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools)
  }
  const url = `${joinUrl(baseUrl, normalizeGeminiModel(model) + ':generateContent')}?key=${encodeURIComponent(apiKey)}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const raw = await r.text()
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${raw.slice(0, 500)}`)
  const data = safeJsonParse(raw)
  if (!data) throw new Error(`Gemini returned non-JSON: ${raw.slice(0, 400)}`)
  const text = []
  const nativeToolCalls = []
  if (data?.candidates?.[0]?.content?.parts) {
    for (const p of data.candidates[0].content.parts) {
      if (p.text) text.push(p.text)
      if (p.functionCall) {
        nativeToolCalls.push({
          id: p.functionCall.name + '-' + Math.random().toString(36).slice(2),
          name: p.functionCall.name,
          args: p.functionCall.args,
          raw: { id: p.functionCall.name + '-' + Math.random().toString(36).slice(2), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) } }
        })
      }
    }
  }
  const usage = data?.usageMetadata ? {
    prompt: Number(data.usageMetadata.promptTokenCount || 0),
    completion: Number(data.usageMetadata.candidatesTokenCount || 0),
    total: Number(data.usageMetadata.totalTokenCount || 0),
  } : null
  return { text: text.join(''), toolCalls: nativeToolCalls, usage }
}

async function callGeminiOfficialStream({
  baseUrl, apiKey, model, messages, temperature = 0.7, signal,
  tools, onTextDelta, onToolCallDelta, onUsage,
}) {
  const { system } = splitSystemMessages(messages)
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      temperature,
      maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),
    },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools)
  }
  const url = `${joinUrl(baseUrl, normalizeGeminiModel(model) + ':streamGenerateContent')}?alt=sse&key=${encodeURIComponent(apiKey)}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(180_000),
  })
  if (!r.ok) {
    const raw = await r.text().catch(() => '')
    throw new Error(`Gemini HTTP ${r.status}: ${raw.slice(0, 500)}`)
  }
  if (!r.body) throw new Error('Gemini returned no body for stream')

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  let usage = null
  const nativeToolCalls = []

  function handleData(payload) {
    if (!payload || payload === '[DONE]') return
    const chunk = safeJsonParse(payload)
    if (!chunk) return
    const parts = chunk?.candidates?.[0]?.content?.parts || []
    for (const p of parts) {
      if (p.text) {
        text += p.text
        try { onTextDelta?.(p.text) } catch { /* ignore */ }
      }
      if (p.functionCall) {
        nativeToolCalls.push({
          id: p.functionCall.name + '-' + Math.random().toString(36).slice(2),
          name: p.functionCall.name,
          args: p.functionCall.args,
          raw: { id: p.functionCall.name + '-' + Math.random().toString(36).slice(2), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) } }
        })
        try { onToolCallDelta?.() } catch { /* ignore */ }
      }
    }
    if (chunk.usageMetadata) {
      usage = {
        prompt: Number(chunk.usageMetadata.promptTokenCount || 0),
        completion: Number(chunk.usageMetadata.candidatesTokenCount || 0),
        total: Number(chunk.usageMetadata.totalTokenCount || 0),
      }
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const blocks = buf.split('\n\n')
    buf = blocks.pop() || ''
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) handleData(trimmed.slice(5).trim())
      }
    }
  }
  if (usage) {
    try { onUsage?.(usage) } catch { /* ignore */ }
  }
  return { text, toolCalls: [], usage }
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
  extraHeaders = {}, model, messages: rawMessages, temperature = 0.7,
  tools, toolChoice = 'auto', signal,
  onTextDelta, onToolCallDelta, onUsage,
}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    ...buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders }),
  }
  const body = {
    model, messages: normalizeOpenAIMessages(rawMessages), temperature: /glm/i.test(model) && temperature >= 1 ? 0.99 : temperature,
    stream: true,
    stream_options: { include_usage: true }, // OpenAI: usage in final chunk
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    // ZhipuAI / GLM often reject explicit tool_choice="auto" or crash if it's sent.
    if (!/glm/i.test(model)) {
      body.tool_choice = toolChoice
    }
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
  if (isAnthropicOfficialUrl(opts.baseUrl)) return callAnthropicOfficial(opts)
  if (isGoogleGenerativeNativeUrl(opts.baseUrl)) return callGeminiOfficial(opts)
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
  if (isAnthropicOfficialUrl(opts.baseUrl)) return callAnthropicOfficialStream(opts)
  if (isGoogleGenerativeNativeUrl(opts.baseUrl)) return callGeminiOfficialStream(opts)
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
    u.includes('api.anthropic.com') ||
    u.includes('generativelanguage.googleapis.com')
  )
}

// ── Provider metadata / diagnostics ─────────────────────────────────────────
export function getProviderKind(baseUrl = '') {
  if (isDeepSeekWebUrl(baseUrl)) return 'deepseek-managed-web'
  if (isAnthropicOfficialUrl(baseUrl)) return 'anthropic-official'
  if (isGoogleGenerativeNativeUrl(baseUrl)) return 'google-gemini-official'
  let host
  let pathname
  try {
    const u = new URL(baseUrl)
    host = u.hostname.toLowerCase()
    pathname = u.pathname.toLowerCase()
  } catch { return 'unknown' }
  if (/chatgpt\.com|grok\.com|claude\.ai|perplexity\.ai|tongyi\.aliyun\.com/.test(host)) return 'browser-session'
  if (pathname.includes('/openai') || pathname.includes('/v1') || pathname.includes('/api/v1')) return 'openai-compatible'
  return 'openai-compatible'
}

function modelHasVision(model = '') {
  return /vision|vl|gpt-4o|gemini|claude|sonnet|opus|haiku|pixtral|llava/i.test(String(model || ''))
}

function modelHasReasoning(model = '') {
  return /reason|thinking|deepthink|r1|o1|o3|o4|qwq|grok-3-mini/i.test(String(model || ''))
}

export function getProviderCapabilities(baseUrl = '', model = '') {
  const kind = getProviderKind(baseUrl)
  const openaiCompatible = kind === 'openai-compatible'
  const officialApi = kind === 'anthropic-official' || kind === 'google-gemini-official'
  const nativeTools = supportsNativeTools(baseUrl)
  return {
    schema: 'browserai.provider_capabilities.v1',
    kind,
    baseUrl: String(baseUrl || '').replace(/\?.*$/, ''),
    model: String(model || ''),
    transport: {
      openaiCompatible,
      officialApi,
      browserSession: kind === 'browser-session',
      managed: kind === 'deepseek-managed-web',
    },
    features: {
      streaming: supportsStreaming(baseUrl),
      nativeTools,
      universalTools: true,
      toolFallback: true,
      vision: modelHasVision(model) || kind === 'google-gemini-official' || kind === 'anthropic-official',
      reasoning: modelHasReasoning(model),
      usage: kind !== 'deepseek-managed-web',
      systemPrompt: true,
      multimodalInput: kind !== 'deepseek-managed-web',
    },
    recommendedToolProtocol: nativeTools ? 'native-tools-first' : 'universal-xml',
  }
}

export function normalizeProviderError(error, { baseUrl = '', model = '', phase = 'llm-call' } = {}) {
  const raw = error?.message || String(error || 'unknown provider error')
  const statusMatch = raw.match(/(?:HTTP|status|ответил)\s*(\d{3})/i)
  const status = statusMatch ? Number(statusMatch[1]) : 0
  const lower = raw.toLowerCase()
  const authError = status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|invalid token|токен отклон|ключ отклон/.test(lower)
  const rateLimited = status === 429 || /rate limit|too many requests|quota|лимит|квота/.test(lower)
  const timeout = /timeout|timed out|таймаут|aborted/.test(lower)
  const serverError = status >= 500 || /bad gateway|service unavailable|overloaded/.test(lower)
  const retryable = rateLimited || timeout || serverError

  const networkError = /fetch failed|network error|econnrefused|etimedout|enotfound|socket hang up/i.test(lower)
  
  let hint = 'Провайдер вернул ошибку. Проверь baseUrl, модель и ключ.'
  if (networkError) hint = 'Сетевая ошибка или сбой соединения с провайдером. Возможно, сервер недоступен или блокируется (например, РКН).'
  else if (authError) hint = 'Проблема авторизации: обнови API key/session token или проверь auth type.'
  else if (rateLimited) hint = 'Лимит/квота провайдера. Подожди, смени модель или ключ.'
  else if (timeout) hint = 'Таймаут провайдера. Можно повторить запрос или отключить streaming.'
  else if (serverError) hint = 'Сбой на стороне провайдера/прокси. Обычно помогает retry или fallback provider.'
  else if (status === 400) hint = 'Провайдер отклонил запрос (HTTP 400). Эта модель (например, GLM или старые версии) может не поддерживать вызов инструментов (Tool Calling) или системные промпты в требуемом формате. Попробуй Claude, GPT-4, Gemini или DeepSeek.'
  else if (/model/i.test(raw) && /not|unknown|invalid|не/i.test(raw)) hint = 'Похоже, модель недоступна. Обнови список моделей или выбери другую.'

  return {
    schema: 'browserai.provider_error.v1',
    phase,
    provider: getProviderCapabilities(baseUrl, model),
    status,
    authError,
    rateLimited,
    timeout,
    serverError,
    retryable,
    message: raw.slice(0, 1000),
    hint,
  }
}
