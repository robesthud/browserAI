import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyBodyDefaults,
  buildSessionHeaders,
} from './stealthHeaders.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WASM_PATH = path.join(__dirname, 'wasm', 'sha3_wasm_bg.7b9ca65ddd.wasm')

let wasmExportsPromise = null
const sessionCache = new Map()

export function isDeepSeekWebUrl(baseUrl = '') {
  try {
    const u = new URL(baseUrl)
    return u.hostname.replace(/^www\./, '') === 'chat.deepseek.com' && u.pathname.startsWith('/api/v0')
  } catch {
    return false
  }
}

function rootUrl(baseUrl = '') {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}/api/v0`
  } catch {
    return 'https://chat.deepseek.com/api/v0'
  }
}

function normalizeHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (v == null) continue
    out[String(k)] = String(v)
  }
  // DeepSeek Web чувствителен к этим заголовкам. Пользовательские extraHeaders
  // всё ещё могут переопределить их через buildSessionHeaders.
  out['Accept'] = out['Accept'] || '*/*'
  out['x-app-version'] = out['x-app-version'] || '20241129.1'
  out['x-client-locale'] = out['x-client-locale'] || 'ru_RU'
  out['x-client-platform'] = out['x-client-platform'] || 'web'
  out['x-client-version'] = out['x-client-version'] || '1.0.0-always'
  return out
}

function hasBearer(headers = {}) {
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')
  return Boolean(entry && /^Bearer\s+\S+/i.test(String(entry[1] || '')))
}

function safeSnippet(text = '', n = 500) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer <redacted>')
    .replace(/((?:aws-waf-token|ds_session_id|smidV2|cf_clearance|\.thumbcache_[A-Za-z0-9_]+)=)[^;\s"\\]+/gi, '$1<redacted>')
    .slice(0, n)
}

async function loadWasmExports() {
  if (!wasmExportsPromise) {
    wasmExportsPromise = (async () => {
      const bytes = await fs.promises.readFile(WASM_PATH)
      const module = await WebAssembly.instantiate(bytes, {})
      return module.instance.exports
    })()
  }
  return wasmExportsPromise
}

function writeString(exports, text) {
  const encoded = new TextEncoder().encode(String(text || ''))
  const ptr = exports.__wbindgen_export_0(encoded.length, 1)
  const mem = new Uint8Array(exports.memory.buffer)
  mem.set(encoded, ptr)
  return { ptr, len: encoded.length }
}

async function solvePowChallenge(challengeConfig) {
  if (!challengeConfig || typeof challengeConfig !== 'object') return ''
  const exports = await loadWasmExports()
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16)
  try {
    const challenge = writeString(exports, challengeConfig.challenge)
    const prefix = writeString(exports, `${challengeConfig.salt}_${challengeConfig.expire_at}_`)
    exports.wasm_solve(
      retptr,
      challenge.ptr,
      challenge.len,
      prefix.ptr,
      prefix.len,
      Number(challengeConfig.difficulty || 0),
    )
    const view = new DataView(exports.memory.buffer)
    const status = view.getInt32(retptr, true)
    if (status === 0) return ''
    const answer = Math.trunc(view.getFloat64(retptr + 8, true))
    const result = {
      algorithm: challengeConfig.algorithm,
      challenge: challengeConfig.challenge,
      salt: challengeConfig.salt,
      answer,
      signature: challengeConfig.signature,
      target_path: challengeConfig.target_path,
    }
    return Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16)
  }
}

async function postViaOptionalProxy({ url, headers, body, proxyUrl = '', proxySecret = '', timeoutMs = 30000 }) {
  const cleanHeaders = normalizeHeaders(headers)
  if (proxyUrl) {
    return fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(proxySecret ? { 'X-Proxy-Key': proxySecret } : {}),
      },
      body: JSON.stringify({ targetUrl: url, headers: cleanHeaders, body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  return fetch(url, {
    method: 'POST',
    headers: cleanHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

async function readJsonOrThrow(response, label) {
  const text = await response.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* ignore */ }
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}${text ? ' · ' + safeSnippet(text) : ''}`)
  }
  if (!json || typeof json !== 'object') {
    throw new Error(`${label}: DeepSeek вернул не JSON${text ? ' · ' + safeSnippet(text) : ''}`)
  }
  return json
}

function extractBizData(json) {
  return json?.data?.biz_data || json?.biz_data || json?.data || null
}

async function createChatSession({ baseUrl, headers, proxyUrl, proxySecret }) {
  const root = rootUrl(baseUrl)
  const attempts = [
    { character_id: null },
    { agent: 'chat' },
  ]
  let lastErr = null
  for (const body of attempts) {
    try {
      const r = await postViaOptionalProxy({
        url: `${root}/chat_session/create`,
        headers,
        body,
        proxyUrl,
        proxySecret,
        timeoutMs: 30000,
      })
      const json = await readJsonOrThrow(r, 'create chat session')
      const biz = extractBizData(json)
      const id = biz?.id || json?.id
      if (id) return id
      lastErr = new Error('create chat session: в ответе нет id · ' + safeSnippet(JSON.stringify(json)))
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Не удалось создать DeepSeek chat session')
}

async function getPowResponse({ baseUrl, headers, proxyUrl, proxySecret }) {
  // Если пользователь уже добавил свежий x-ds-pow-response в extraHeaders — используем его.
  const existing = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-ds-pow-response')
  if (existing?.[1]) return String(existing[1])

  const root = rootUrl(baseUrl)
  const r = await postViaOptionalProxy({
    url: `${root}/chat/create_pow_challenge`,
    headers,
    body: { target_path: '/api/v0/chat/completion' },
    proxyUrl,
    proxySecret,
    timeoutMs: 30000,
  })
  const json = await readJsonOrThrow(r, 'pow challenge')
  const challenge = extractBizData(json)?.challenge || json?.challenge
  if (!challenge) throw new Error('pow challenge: в ответе нет challenge · ' + safeSnippet(JSON.stringify(json)))
  return solvePowChallenge(challenge)
}

function messagesToPrompt(messages = []) {
  const items = Array.isArray(messages) ? messages : []
  const lines = []
  for (const m of items) {
    const role = m?.role === 'assistant'
      ? 'Ассистент'
      : m?.role === 'system'
        ? 'Системная инструкция'
        : 'Пользователь'
    const content = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((p) => typeof p === 'string' ? p : (p?.text || '')).filter(Boolean).join('\n')
        : ''
    if (!content.trim()) continue
    lines.push(`${role}:\n${content.trim()}`)
  }
  return lines.join('\n\n---\n\n').trim() || 'Привет'
}

function extractDeltaText(payload) {
  // DeepSeek Web minified streaming format (2024+) — the production
  // format we hit from chat.deepseek.com today:
  //
  //   data: {"v":{"response":{...,"content":""}}}                       — bootstrap frame (object, ignore)
  //   data: {"p":"response/content","o":"APPEND","v":"Hello"}           — first chunk for content path
  //   data: {"v":" world"}                                              — subsequent chunks (implicit path)
  //   data: {"p":"response/status","v":"FINISHED"}                      — status update for status path
  //   data: {"p":"response/accumulated_token_usage","o":"SET","v":52}   — metric for usage path
  //
  // The "v" field is *the* delta value; "p" tells us which path it
  // targets. Without "p" the delta implicitly continues the most
  // recent path the model wrote to (typically response/content).
  // Earlier we also accepted root-level "content"/"text" as a fallback,
  // but that mis-fired on the trailing `event: title  data: {"content":
  // "Greeting response"}` named-event frame DeepSeek emits to set the
  // chat title — the SSE line-based parser fed the title's data line
  // here and we treated 'Greeting response' as the entire model output.
  //
  // So: only forward "v" when it is a string AND the path (if any) is
  // the actual content channel. We let unknown paths through too, but
  // strictly never touch root .content/.text/.choices anymore.
  const path = typeof payload?.p === 'string' ? payload.p : ''
  if (typeof payload?.v === 'string') {
    if (!path || path === 'response/content' || path.endsWith('/content')) {
      return payload.v
    }
    // Other paths (status, accumulated_token_usage, ...) — ignore.
    return ''
  }

  // OpenAI-style fallback for proxies that wrap DeepSeek's stream in
  // a classic {choices:[{delta:{content}}]} envelope.
  const choice = payload?.choices?.[0]
  const delta = choice?.delta
  if (typeof delta?.content === 'string') return delta.content
  if (typeof choice?.message?.content === 'string') return choice.message.content

  return ''
}

function parseDeepSeekText(rawText = '') {
  const text = String(rawText || '')
  let acc = ''
  let sawSse = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    sawSse = true
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      const payload = JSON.parse(raw)
      acc += extractDeltaText(payload)
    } catch { /* ignore malformed stream line */ }
  }
  if (acc) return acc

  try {
    const payload = JSON.parse(text)
    const direct = extractDeltaText(payload)
    if (direct) return direct
    const msg = payload?.message || payload?.msg || payload?.error?.message || payload?.error
    if (msg) throw new Error(String(msg))
    if (sawSse) return ''
    throw new Error(safeSnippet(JSON.stringify(payload)))
  } catch (e) {
    if (e?.message && e.message !== text) throw e
    throw new Error(safeSnippet(text || 'Пустой ответ DeepSeek'), { cause: e })
  }
}

async function streamDeepSeekToOpenAI(upstream, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const reader = upstream.body?.getReader()
  if (!reader) {
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let sentAny = false
  const emit = (content) => {
    if (!content) return
    sentAny = true
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        const payload = JSON.parse(raw)
        emit(extractDeltaText(payload))
        if (payload?.choices?.[0]?.finish_reason === 'stop') {
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
      } catch { /* ignore malformed chunks */ }
    }
  }

  // Иногда CF/DeepSeek возвращает весь ответ одним JSON, без SSE.
  if (!sentAny && buffer.trim()) {
    try { emit(parseDeepSeekText(buffer)) } catch { /* ignore */ }
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

export async function handleDeepSeekWebChat({ reqBody, res }) {
  const {
    baseUrl,
    apiKey,
    authType = 'bearer',
    authHeader = '',
    extraHeaders = {},
    model = 'deepseek_chat',
    messages = [],
    stream = false,
  } = reqBody || {}

  const headers = normalizeHeaders(buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders }))

  if (!hasBearer(headers)) {
    return res.status(400).json({
      error: 'DeepSeek Web Experimental требует Bearer token из localStorage userToken. Cookie можно добавить дополнительно в «Дополнительные заголовки» как Cookie: ...',
    })
  }

  const cacheKey = `${String(headers.Authorization || headers.authorization || '').slice(-32)}:${model}`
  const proxyUrl = process.env.CF_PROXY_URL || ''
  const proxySecret = process.env.CF_PROXY_SECRET || ''

  let chatSessionId = sessionCache.get(cacheKey)?.chatSessionId
  if (!chatSessionId) {
    chatSessionId = await createChatSession({ baseUrl, headers, proxyUrl, proxySecret })
    sessionCache.set(cacheKey, { chatSessionId, createdAt: Date.now() })
    if (sessionCache.size > 100) {
      const oldest = [...sessionCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (oldest) sessionCache.delete(oldest[0])
    }
  }

  let powResponse = ''
  try {
    powResponse = await getPowResponse({ baseUrl, headers, proxyUrl, proxySecret })
  } catch (e) {
    // У некоторых аккаунтов/периодов POW не обязателен. Пробуем без него,
    // но оставляем понятный лог для диагностики.
    console.warn('[deepseek-web] POW skipped:', safeSnippet(e.message, 180))
  }

  const prompt = messagesToPrompt(messages)
  const body = applyBodyDefaults({
    chat_session_id: chatSessionId,
    parent_message_id: null,
    prompt,
    ref_file_ids: [],
    thinking_enabled: /think|reason|r1|deepthink/i.test(String(model || '')),
    search_enabled: false,
    challenge_response: null,
  }, baseUrl)
  // applyBodyDefaults добавляет stream/temperature для обычных OpenAI API; DeepSeek Web
  // эти поля не ждёт, поэтому удаляем лишнее.
  delete body.model
  delete body.messages
  delete body.temperature
  delete body.max_tokens
  delete body.stream

  const completionHeaders = {
    ...headers,
    ...(powResponse ? { 'x-ds-pow-response': powResponse } : {}),
  }

  const upstream = await postViaOptionalProxy({
    url: `${rootUrl(baseUrl)}/chat/completion`,
    headers: completionHeaders,
    body,
    proxyUrl,
    proxySecret,
    timeoutMs: 120000,
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    sessionCache.delete(cacheKey)
    return res.status(upstream.status).json({
      error: `DeepSeek Web ответил ${upstream.status}: ${safeSnippet(errText)}`,
    })
  }

  if (stream) {
    await streamDeepSeekToOpenAI(upstream, res)
    return
  }

  const rawText = await upstream.text().catch(() => '')
  try {
    const content = parseDeepSeekText(rawText)
    return res.json({
      id: `deepseek-web-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    })
  } catch (e) {
    return res.status(502).json({
      error: `DeepSeek Web вернул ответ без текста: ${safeSnippet(e.message || rawText)}`,
    })
  }
}

export async function validateDeepSeekWebKey({ baseUrl, apiKey, authType = 'bearer', authHeader = '', extraHeaders = {}, model = 'deepseek_chat' }) {
  const headers = normalizeHeaders(buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders }))
  if (!hasBearer(headers)) {
    return {
      ok: false,
      message: 'Для DeepSeek Web нужен Bearer token из localStorage userToken, не только Cookie',
      models: [],
      preferredModel: '',
    }
  }

  const proxyUrl = process.env.CF_PROXY_URL || ''
  const proxySecret = process.env.CF_PROXY_SECRET || ''
  try {
    const chatSessionId = await createChatSession({ baseUrl, headers, proxyUrl, proxySecret })
    return {
      ok: true,
      message: 'DeepSeek Web токен принят · experimental adapter',
      models: ['deepseek_chat', 'deepseek-reasoner', 'DeepThink'],
      preferredModel: model || 'deepseek_chat',
      chatSessionId,
    }
  } catch (e) {
    return {
      ok: false,
      message: 'DeepSeek Web не принял токен: ' + safeSnippet(e.message, 220),
      models: [],
      preferredModel: '',
    }
  }
}
