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
// Mutex для WASM — singleton экземпляр не потокобезопасен для concurrent calls
let wasmMutexQueue = Promise.resolve()
function withWasmMutex(fn) {
  const next = wasmMutexQueue.then(fn)
  wasmMutexQueue = next.catch(() => {})
  return next
}
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
    })().catch(e => {
      wasmExportsPromise = null // сброс при ошибке — следующий вызов попробует снова
      throw e
    })
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
  // Запускаем через mutex — WASM stack не thread-safe для параллельных вызовов
  return withWasmMutex(() => _solvePowChallengeInner(challengeConfig))
}
async function _solvePowChallengeInner(challengeConfig) {
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
  const effSignal = signal || AbortSignal.timeout(timeoutMs)
  const cleanHeaders = normalizeHeaders(headers)
  
  const isBinary = Buffer.isBuffer(body)
  
  if (proxyUrl) {
    const proxyBody = { 
      targetUrl: url, 
      headers: cleanHeaders, 
      method: 'POST'
    }
    
    if (isBinary) {
      proxyBody.body = body.toString('base64')
      proxyBody.isBase64 = true
    } else {
      proxyBody.body = body
    }

    return fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(proxySecret ? { 'X-Proxy-Key': proxySecret } : {}),
      },
      body: JSON.stringify(proxyBody),
      signal: effSignal,
    })
  }

  return fetch(url, {
    method: 'POST',
    headers: cleanHeaders,
    body: isBinary ? body : JSON.stringify(body),
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

async function uploadFileToDeepSeek({ dataUrl, headers, proxyUrl, proxySecret, baseUrl }) {
  const root = rootUrl(baseUrl)
  const match = String(dataUrl || '').match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s)
  if (!match) return null

  const mimeType = (match[1] || 'image/png').split(';')[0].trim() // убираем параметры после ';'
  const b64Data = match[2]
  const buffer = Buffer.from(b64Data, 'base64')
  // Санируем расширение — только alphanumeric, защита от Content-Disposition injection
  const rawExt = (mimeType.split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'png'
  const fileName = `image-${Date.now()}.${rawExt}`
  const boundary = `----BrowserAI${Math.random().toString(36).slice(2)}`
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  const footer = `\r\n--${boundary}--\r\n`
  const body = Buffer.concat([Buffer.from(header, 'utf8'), buffer, Buffer.from(footer, 'utf8')])
  const uploadHeaders = { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` }

  const r = await postViaOptionalProxy({
    url: `${root}/file/upload`,
    headers: uploadHeaders,
    body,
    proxyUrl,
    proxySecret,
    timeoutMs: 60000
  })

  const json = await readJsonOrThrow(r, 'file upload')
  const biz = extractBizData(json)
  return biz?.id || json?.id || null
}

async function createChatSession({ baseUrl, headers, proxyUrl, proxySecret }) {
  const root = rootUrl(baseUrl)
  const attempts = [{ character_id: null }, { agent: 'chat' }]
  let lastErr = null
  for (const body of attempts) {
    try {
      const r = await postViaOptionalProxy({ url: `${root}/chat_session/create`, headers, body, proxyUrl, proxySecret, timeoutMs: 30000 })
      const json = await readJsonOrThrow(r, 'create chat session')
      const biz = extractBizData(json)
      const id = biz?.id || json?.id
      if (id) return id
      lastErr = new Error('create chat session: в ответе нет id · ' + safeSnippet(JSON.stringify(json)))
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('Не удалось создать DeepSeek chat session')
}

async function getPowResponse({ baseUrl, headers, proxyUrl, proxySecret }) {
  const existing = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-ds-pow-response')
  if (existing?.[1]) return String(existing[1])
  const root = rootUrl(baseUrl)
  const r = await postViaOptionalProxy({ url: `${root}/chat/create_pow_challenge`, headers, body: { target_path: '/api/v0/chat/completion' }, proxyUrl, proxySecret, timeoutMs: 30000 })
  const json = await readJsonOrThrow(r, 'pow challenge')
  const challenge = extractBizData(json)?.challenge || json?.challenge
  if (!challenge) throw new Error('pow challenge: в ответе нет challenge · ' + safeSnippet(JSON.stringify(json)))
  return solvePowChallenge(challenge)
}

function messagesToPrompt(messages = []) {
  const items = Array.isArray(messages) ? messages : []
  const lines = []
  for (const m of items) {
    const role = m?.role === 'assistant' ? 'Ассистент' : m?.role === 'system' ? 'Системная инструкция' : 'Пользователь'
    const content = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => typeof p === 'string' ? p : (p?.text || '')).filter(Boolean).join('\n') : ''
    if (!content.trim() && !m?.reasoning_content && !m?.reasoning) continue
    const reasoning = m?.reasoning_content || m?.reasoning || ''
    const block = reasoning ? `<thinking>\n${reasoning}\n</thinking>\n\n${content.trim()}` : content.trim()
    lines.push(`${role}:\n${block}`)
  }
  return lines.join('\n\n---\n\n').trim() || 'Привет'
}

function isDeepSeekStreamDone(payload) {
  try {
    const choice = payload?.choices?.[0] || {}
    const finish = String(choice?.finish_reason || payload?.finish_reason || payload?.v?.response?.finish_reason || '').toLowerCase()
    if (finish && finish !== 'null') return true
    const status = String(payload?.status || payload?.v?.response?.status || '').toLowerCase()
    if (status === 'finished' || status === 'done' || status === 'completed' || status === 'stop') return true
    return false
  } catch {
    return false
  }
}

function extractDelta(payload) {
  const path = typeof payload?.p === 'string' ? payload.p : ''
  if (typeof payload?.v === 'string') {
    if (!path || path === 'response/content' || path.endsWith('/content')) return { content: payload.v }
    if (path === 'response/reasoning_content' || path.endsWith('/reasoning_content')) return { reasoning: payload.v }
    return {}
  }
  if (payload?.v && typeof payload.v === 'object' && !Array.isArray(payload.v)) {
    const r = payload.v.response || payload.v
    const content = typeof r?.content === 'string' ? r.content : ''
    const reasoning = typeof r?.thinking_content === 'string' ? r.thinking_content : ''
    if (content || reasoning) return { content, reasoning }
    return {}
  }
  const choice = payload?.choices?.[0]
  const delta = choice?.delta || {}
  const content = delta.content || choice?.message?.content || ''
  const reasoning = delta.reasoning_content || delta.reasoning || ''
  if (content || reasoning) return { content, reasoning }
  return {}
}

function parseDeepSeekText(rawText = '') {
  const text = String(rawText || '')
  let acc = '', accReasoning = '', sawSse = false
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
    } catch { }
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
  if (!reader) { res.write('data: [DONE]\n\n'); res.end(); return }
  let lastData = Date.now()
  const ka = setInterval(() => {
    try { res.write(': keep-alive\n\n') } catch { }
    if (Date.now() - lastData > 300_000) { try { reader.cancel() } catch { } }
  }, 15_000)
  const decoder = new TextDecoder()
  let buffer = '', sentAny = false
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
          if (payload?.choices?.[0]?.finish_reason === 'stop') { res.write('data: [DONE]\n\n'); res.end(); return }
        } catch { }
      }
    }
    if (!sentAny && buffer.trim()) { try { emit(parseDeepSeekText(buffer)) } catch { } }
  } catch (e) {
    // If DeepSeek dropped the stream AFTER we already emitted some content,
    // don't surface a scary UI error: the user already has a usable answer.
    // Just finish the SSE stream cleanly. Emit an error only when nothing was delivered.
    if (!sentAny) {
      try { res.write(`data: ${JSON.stringify({ error: 'Поток DeepSeek оборвался: ' + (e?.message || 'connection lost') })}\n\n`) } catch { }
    } else {
      try { console.warn('[deepseek-web] stream ended after partial content:', e?.message || e) } catch { }
    }
  } finally { clearInterval(ka); try { res.write('data: [DONE]\n\n') } catch { }; res.end() }
}

export async function handleDeepSeekWebChat({ reqBody, res, onTextDelta }) {
  const { baseUrl, apiKey, authType = 'bearer', authHeader = '', extraHeaders = {}, model = 'deepseek_chat', messages = [], stream = false } = reqBody || {}
  const headers = normalizeHeaders(buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders }))
  if (!hasBearer(headers)) {
    const errorMsg = 'DeepSeek Web Experimental требует Bearer token.'
    if (res && res.status) return res.status(400).json({ error: errorMsg })
    throw new Error(errorMsg)
  }
  // sha256 от полного токена — не только последние 32 символа (collision risk)
  const _rawAuth = String(headers.Authorization || headers.authorization || '')
  const _crypto = await import('node:crypto')
  const cacheKey = `${_crypto.default.createHash('sha256').update(_rawAuth).digest('hex').slice(0,16)}:${model}`
  const proxyUrl = process.env.CF_PROXY_URL || '', proxySecret = process.env.CF_PROXY_SECRET || ''
  let chatSessionId = sessionCache.get(cacheKey)?.chatSessionId
  if (!chatSessionId) {
    chatSessionId = await createChatSession({ baseUrl, headers, proxyUrl, proxySecret })
    sessionCache.set(cacheKey, { chatSessionId, createdAt: Date.now() })
    // TTL cleanup — удаляем записи старше 2 часов
    const _now = Date.now(), _TTL = 2 * 60 * 60 * 1000
    for (const [k, v] of sessionCache) {
      if (_now - v.createdAt > _TTL) sessionCache.delete(k)
    }
  }
  let powResponse = ''
  try { powResponse = await getPowResponse({ baseUrl, headers, proxyUrl, proxySecret }) }
  catch (e) { console.warn('[deepseek-web] PoW challenge failed (proceeding without):', e.message) }

  const refFileIds = []
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === 'image_url' && part.image_url?.url) {
          try {
            const fileId = await uploadFileToDeepSeek({ dataUrl: part.image_url.url, headers, proxyUrl, proxySecret, baseUrl })
            if (fileId) refFileIds.push(fileId)
          } catch (e) { console.warn('[deepseek-web] File upload failed:', e.message) }
        }
      }
    }
  }

  const prompt = messagesToPrompt(messages)
  const body = applyBodyDefaults({ chat_session_id: chatSessionId, parent_message_id: null, prompt, ref_file_ids: refFileIds, thinking_enabled: /think|reason|r1|deepthink/i.test(String(model || '')), search_enabled: false, challenge_response: null }, baseUrl)
  delete body.model; delete body.messages; delete body.temperature; delete body.max_tokens
  const completionHeaders = { ...headers, ...(powResponse ? { 'x-ds-pow-response': powResponse } : {}) }
  const connectCtl = new AbortController(), connectTimer = setTimeout(() => connectCtl.abort(new Error('DeepSeek connect timeout')), 45_000)
  let upstream
  try { upstream = await postViaOptionalProxy({ url: `${rootUrl(baseUrl)}/chat/completion`, headers: completionHeaders, body, proxyUrl, proxySecret, signal: connectCtl.signal }) } finally { clearTimeout(connectTimer) }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    sessionCache.delete(cacheKey)
    if (res && res.status) return res.status(upstream.status).json({ error: errText })
    throw new Error(errText)
  }

  if (stream) {
    if (res && res.status) { await streamDeepSeekToOpenAI(upstream, res); return }
    const reader = upstream.body?.getReader(), decoder = new TextDecoder()
    let buffer = '', fullText = '', fullReasoning = '', finished = false
    try {
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          if (raw === '[DONE]') { finished = true; break }
          try {
            const payload = JSON.parse(raw)
            const d = extractDelta(payload)
            if (d.content) { fullText += d.content; onTextDelta?.(d.content) }
            if (d.reasoning) { fullReasoning += d.reasoning; onTextDelta?.(d.reasoning, { kind: 'thinking' }) }
            if (isDeepSeekStreamDone(payload)) { finished = true; break }
          } catch { }
        }
      }
    } finally { reader?.releaseLock?.() }
    return { text: fullText, reasoning: fullReasoning, toolCalls: [], usage: null }
  }
  const reader = upstream.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = '', fullText = '', fullReasoning = '', finished = false
  if (reader) {
    try {
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          if (raw === '[DONE]') { finished = true; break }
          try {
            const payload = JSON.parse(raw)
            const d = extractDelta(payload)
            if (d.content) fullText += d.content
            if (d.reasoning) fullReasoning += d.reasoning
            if (isDeepSeekStreamDone(payload)) { finished = true; break }
          } catch { }
        }
      }
    } finally { reader?.releaseLock?.() }
    if (fullText || fullReasoning) {
      const result = { id: `deepseek-web-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: fullText, reasoning_content: fullReasoning }, finish_reason: 'stop' }] }
      if (res && res.json) return res.json(result)
      return { text: fullText, reasoning: fullReasoning, toolCalls: [], usage: null }
    }
  }
  const rawText = await upstream.text().catch(() => '')
  const { content, reasoning } = parseDeepSeekText(rawText)
  const result = { id: `deepseek-web-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: reasoning }, finish_reason: 'stop' }] }
  if (res && res.json) return res.json(result)
  return { text: content, reasoning, toolCalls: [], usage: null }
}

export async function validateDeepSeekWebKey({ baseUrl, apiKey, authType = 'bearer', authHeader = '', extraHeaders = {}, model = 'deepseek_chat' }) {
  const headers = normalizeHeaders(buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders }))
  if (!hasBearer(headers)) return { ok: false, message: 'Need Bearer token.', models: [], preferredModel: '' }
  const proxyUrl = process.env.CF_PROXY_URL || '', proxySecret = process.env.CF_PROXY_SECRET || ''
  try {
    const chatSessionId = await createChatSession({ baseUrl, headers, proxyUrl, proxySecret })
    return { ok: true, message: 'Accepted.', models: ['deepseek_chat', 'deepseek-reasoner', 'DeepThink'], preferredModel: model || 'deepseek_chat', chatSessionId }
  } catch (e) { return { ok: false, message: e.message, models: [], preferredModel: '' } }
}
