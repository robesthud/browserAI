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

async function postViaOptionalProxy({ url, headers, body, proxyUrl = '', proxySecret = '', timeoutMs = 30000, signal = null }) {
  // `signal` (if given) replaces the flat AbortSignal.timeout. IMPORTANT for
  // streaming: AbortSignal.timeout counts TOTAL time — it keeps ticking while
  // the body is being consumed and kills long SSE streams mid-flight.
  const effSignal = signal || AbortSignal.timeout(timeoutMs)
  const cleanHeaders = normalizeHeaders(headers)
  if (proxyUrl) {
    return fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(proxySecret ? { 'X-Proxy-Key': proxySecret } : {}),
      },
      body: JSON.stringify({ targetUrl: url, headers: cleanHeaders, body }),
      signal: effSignal,
    })
  }

  return fetch(url, {
    method: 'POST',
    headers: cleanHeaders,
    body: JSON.stringify(body),
    signal: effSignal,
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
    
    if (!content.trim() && !m?.reasoning_content && !m?.reasoning) continue
    
    // #24 FIX: Include previous reasoning content in the prompt for DeepSeek.
    // This maintains the chain of thought across turns.
    const reasoning = m?.reasoning_content || m?.reasoning || ''
    const block = reasoning 
      ? `<thinking>\n${reasoning}\n</thinking>\n\n${content.trim()}`
      : content.trim()
      
    lines.push(`${role}:\n${block}`)
  }
  return lines.join('\n\n---\n\n').trim() || 'Привет'
}

function extractDelta(payload) {
  // DeepSeek Web minified streaming format (2024+)
  const path = typeof payload?.p === 'string' ? payload.p : ''
  if (typeof payload?.v === 'string') {
    if (!path || path === 'response/content' || path.endsWith('/content')) {
      return { content: payload.v }
    }
    if (path === 'response/reasoning_content' || path.endsWith('/reasoning_content')) {
      return { reasoning: payload.v }
    }
    return {}
  }

  // Snapshot object: {"v":{"response":{...,"content":"391","thinking_content":null}}}
  // DeepSeek often ships the FIRST chunk of the answer inside this full
  // response snapshot (short answers may arrive here entirely). Dropping it
  // truncated replies («Тест» → «ст») and 502'd when nothing else followed.
  if (payload?.v && typeof payload.v === 'object' && !Array.isArray(payload.v)) {
    const r = payload.v.response || payload.v
    const content = typeof r?.content === 'string' ? r.content : ''
    const reasoning = typeof r?.thinking_content === 'string' ? r.thinking_content : ''
    if (content || reasoning) return { content, reasoning }
    return {}
  }

  // OpenAI-style fallback

  const choice = payload?.choices?.[0]
  const delta = choice?.delta || {}
  const content = delta.content || choice?.message?.content || ''
  const reasoning = delta.reasoning_content || delta.reasoning || ''
  
  if (content || reasoning) return { content, reasoning }
  return {}
}

function parseDeepSeekText(rawText = '') {
  const text = String(rawText || '')
  let acc = ''
  let accReasoning = ''
  let sawSse = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    sawSse = true
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      const payload = JSON.parse(raw)
      const d = extractDelta(payload)
      if (d.content) acc += d.content
      if (d.reasoning) accReasoning += d.reasoning
    } catch { /* ignore malformed stream line */ }
  }
  if (acc || accReasoning) return { content: acc, reasoning: accReasoning }

  try {
    const payload = JSON.parse(text)
    const d = extractDelta(payload)
    if (d.content || d.reasoning) return d
    const msg = payload?.message || payload?.msg || payload?.error?.message || payload?.error
    if (msg) throw new Error(String(msg))
    if (sawSse) return { content: '', reasoning: '' }
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

  // Keep-alive comments every 15s so mobile networks / VPNs don't drop the
  // connection during silent thinking phases, plus an idle watchdog: if the
  // PROVIDER sends nothing for 5 minutes we cancel instead of hanging forever.
  let lastData = Date.now()
  const ka = setInterval(() => {
    try { res.write(': keep-alive\n\n') } catch { /* client gone */ }
    if (Date.now() - lastData > 300_000) { try { reader.cancel() } catch { /* ignore */ } }
  }, 15_000)

  const decoder = new TextDecoder()
  let buffer = ''
  let sentAny = false
  const emit = (d) => {
    if (!d.content && !d.reasoning) return
    sentAny = true
    const delta = {}
    if (d.content) delta.content = d.content
    if (d.reasoning) delta.reasoning_content = d.reasoning
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lastData = Date.now()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const payload = JSON.parse(raw)
          emit(extractDelta(payload))
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
  } catch (e) {
    // Upstream cut mid-stream: tell the client instead of silently ending.
    try { res.write(`data: ${JSON.stringify({ error: 'Поток DeepSeek оборвался: ' + (e?.message || 'connection lost') })}\n\n`) } catch { /* ignore */ }
  } finally {
    clearInterval(ka)
    try { res.write('data: [DONE]\n\n') } catch { /* ignore */ }
    res.end()
  }
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

  // Connect-only timeout: abort if DeepSeek doesn't ANSWER in 45s, but once
  // the SSE stream starts it may run for many minutes (reasoner thinking).
  // The old flat 120s AbortSignal.timeout killed long streams mid-flight,
  // which the UI showed as «Сетевая ошибка или временный сбой».
  const connectCtl = new AbortController()
  const connectTimer = setTimeout(() => connectCtl.abort(new Error('DeepSeek connect timeout (45s)')), 45_000)
  let upstream
  try {
    upstream = await postViaOptionalProxy({
      url: `${rootUrl(baseUrl)}/chat/completion`,
      headers: completionHeaders,
      body,
      proxyUrl,
      proxySecret,
      signal: connectCtl.signal,
    })
  } finally {
    clearTimeout(connectTimer)
  }

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
    const { content, reasoning } = parseDeepSeekText(rawText)
    return res.json({
      id: `deepseek-web-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: reasoning }, finish_reason: 'stop' }],
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
