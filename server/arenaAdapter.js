/**
 * arenaAdapter.js — встроенный адаптер Arena.ai для BrowserAI.
 *
 * Использует Playwright (headless Chromium) чтобы:
 *  1. Пройти Cloudflare challenge автоматически
 *  2. Получить reCAPTCHA v3 токен для каждого запроса
 *  3. Автоматически обновлять Supabase access_token через refresh_token
 *
 * BrowserAI общается с Arena.ai напрямую, без внешних bridge/userscript.
 *
 * Переменные окружения:
 *   ARENA_REFRESH_TOKEN  — Supabase refresh_token (из cookie arena-auth-prod-v1)
 *   ARENA_ENABLED        — '1' чтобы включить (по умолчанию авто-определение)
 */

import { chromium } from 'playwright-core'

// ── Конфигурация ────────────────────────────────────────────────────────────
const ARENA_ORIGIN = 'https://arena.ai'
const SUPABASE_URL = 'https://huogzoeqzcrdvkwtvodi.supabase.co'
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000 // обновлять за 5 мин до expiry

// ── Состояние (in-memory) ───────────────────────────────────────────────────
let browser = null
let page = null
let arenaSession = {
  accessToken: null,
  refreshToken: process.env.ARENA_REFRESH_TOKEN || null,
  expiresAt: 0,
  cookie: null,    // полная arena-auth-prod-v1 cookie
  userId: null,
  recaptchaSiteKey: null,
}
let starting = false
let startPromise = null
let modelsCache = { models: [], fetchedAt: 0 }

// ── Утилиты ─────────────────────────────────────────────────────────────────

function uuidv7() {
  const ts = Date.now()
  const rand = new Uint8Array(10)
  globalThis.crypto.getRandomValues(rand)
  const buf = new Uint8Array(16)
  // 48 bits timestamp
  buf[0] = (ts / 2 ** 40) & 0xff
  buf[1] = (ts / 2 ** 32) & 0xff
  buf[2] = (ts / 2 ** 24) & 0xff
  buf[3] = (ts / 2 ** 16) & 0xff
  buf[4] = (ts / 2 ** 8) & 0xff
  buf[5] = ts & 0xff
  // version 7
  buf[6] = 0x70 | (rand[0] & 0x0f)
  buf[7] = rand[1]
  // variant 10
  buf[8] = 0x80 | (rand[2] & 0x3f)
  buf[9] = rand[3]
  buf[10] = rand[4]
  buf[11] = rand[5]
  buf[12] = rand[6]
  buf[13] = rand[7]
  buf[14] = rand[8]
  buf[15] = rand[9]
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function log(...args) {
  console.log('[arena-adapter]', ...args)
}

function warn(...args) {
  console.warn('[arena-adapter]', ...args)
}

// ── Supabase Token Refresh ──────────────────────────────────────────────────

async function refreshSupabaseToken() {
  if (!arenaSession.refreshToken) {
    throw new Error('ARENA_REFRESH_TOKEN не задан. Добавьте в переменные окружения.')
  }

  // Нам нужен Supabase anon key. Извлекаем из страницы arena.ai
  // Или используем стандартный публичный endpoint
  const anonKey = await getSupabaseAnonKey()

  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
    },
    body: JSON.stringify({ refresh_token: arenaSession.refreshToken }),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Supabase refresh failed: ${resp.status} ${text.slice(0, 200)}`)
  }

  const data = await resp.json()
  arenaSession.accessToken = data.access_token
  arenaSession.refreshToken = data.refresh_token // Supabase выдаёт новый refresh token
  arenaSession.expiresAt = (data.expires_at || 0) * 1000 // Unix timestamp → ms

  // Формируем cookie как arena.ai ожидает
  const cookiePayload = JSON.stringify(data)
  arenaSession.cookie = 'base64-' + Buffer.from(cookiePayload).toString('base64')

  log(`Token refreshed, expires at ${new Date(arenaSession.expiresAt).toISOString()}`)
  return data
}

let _anonKey = null
async function getSupabaseAnonKey() {
  if (_anonKey) return _anonKey

  // Supabase anon key — публичный, можно извлечь из HTML/JS arena.ai
  // Или из Playwright page context
  if (page) {
    try {
      _anonKey = await page.evaluate(() => {
        // Next.js хранит env в window.__NEXT_DATA__ или в inline scripts
        const scripts = document.querySelectorAll('script')
        for (const s of scripts) {
          const text = s.textContent || ''
          const match = text.match(/SUPABASE_ANON_KEY['":\s]+['"]([^'"]+)['"]/)
            || text.match(/supabaseKey['":\s]+['"]([^'"]+)['"]/)
            || text.match(/(eyJ[A-Za-z0-9_-]{100,}\.[A-Za-z0-9_-]{20,})/)
          if (match) return match[1]
        }
        return null
      })
      if (_anonKey) return _anonKey
    } catch { /* fallback */ }
  }

  // Fallback: извлекаем из JS бандла
  try {
    const html = await fetch(`${ARENA_ORIGIN}/`).then(r => r.text())
    const jsFiles = [...html.matchAll(/\/_next\/static\/[^"]+\.js/g)].map(m => m[0])
    for (const jsFile of jsFiles.slice(0, 10)) {
      const content = await fetch(`${ARENA_ORIGIN}${jsFile}`).then(r => r.text()).catch(() => '')
      // Supabase anon key looks like: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...
      const match = content.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY['":\s]+['"]([^'"]+)['"]/)
        || content.match(/supabaseAnonKey['":\s]+['"]([^'"]+)['"]/)
      if (match) {
        _anonKey = match[1]
        return _anonKey
      }
    }
  } catch { /* ignore */ }

  throw new Error('Не удалось найти Supabase anon key. Задайте ARENA_SUPABASE_ANON_KEY.')
}

async function ensureFreshToken() {
  const now = Date.now()
  if (arenaSession.accessToken && arenaSession.expiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
    return // токен свежий
  }
  await refreshSupabaseToken()
}

// ── Playwright Browser ──────────────────────────────────────────────────────

async function ensureBrowser() {
  if (browser && browser.isConnected()) return

  log('Launching headless Chromium...')
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
    // На Railway Chromium устанавливается системно
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  page = await context.newPage()

  // Загружаем arena.ai чтобы пройти Cloudflare и получить reCAPTCHA site key
  log('Navigating to arena.ai...')
  try {
    await page.goto(`${ARENA_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000) // Ждём Cloudflare challenge

    // Извлекаем reCAPTCHA site key
    arenaSession.recaptchaSiteKey = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[src*="recaptcha"]')
      for (const s of scripts) {
        const match = s.src.match(/render=([^&]+)/)
        if (match) return match[1]
      }
      // Или из window.grecaptcha
      return null
    }).catch(() => null)

    log(`Browser ready. reCAPTCHA key: ${arenaSession.recaptchaSiteKey || 'not found (will try without)'}`)
  } catch (e) {
    warn('Failed to load arena.ai:', e.message)
  }
}

// ── reCAPTCHA v3 Token ──────────────────────────────────────────────────────

async function getRecaptchaToken(action = 'chat_submit') {
  if (!page) return null

  try {
    // Инжектируем reCAPTCHA v3 и получаем токен
    const token = await page.evaluate(async ({ siteKey, action }) => {
      // Если grecaptcha уже загружен
      if (window.grecaptcha && window.grecaptcha.execute) {
        return await window.grecaptcha.execute(siteKey, { action })
      }

      // Загружаем reCAPTCHA v3
      return new Promise((resolve, reject) => {
        if (document.querySelector('script[src*="recaptcha/api.js"]')) {
          // Уже загружается, ждём
          const interval = setInterval(() => {
            if (window.grecaptcha && window.grecaptcha.execute) {
              clearInterval(interval)
              window.grecaptcha.execute(siteKey, { action }).then(resolve).catch(reject)
            }
          }, 200)
          setTimeout(() => { clearInterval(interval); resolve(null) }, 5000)
          return
        }

        const script = document.createElement('script')
        script.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`
        script.onload = () => {
          window.grecaptcha.ready(() => {
            window.grecaptcha.execute(siteKey, { action }).then(resolve).catch(reject)
          })
        }
        script.onerror = () => reject(new Error('Failed to load reCAPTCHA'))
        document.head.appendChild(script)
      })
    }, { siteKey: arenaSession.recaptchaSiteKey, action }).catch(() => null)

    return token
  } catch (e) {
    warn('reCAPTCHA token failed:', e.message)
    return null
  }
}

// ── Arena.ai API ────────────────────────────────────────────────────────────

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': ARENA_ORIGIN,
    'Referer': `${ARENA_ORIGIN}/`,
    'Accept': 'text/event-stream, application/json, */*',
    'Cookie': `arena-auth-prod-v1=${arenaSession.cookie}`,
  }
}

async function arenaFetchModels() {
  const now = Date.now()
  // Кешируем на 10 минут
  if (modelsCache.models.length > 0 && now - modelsCache.fetchedAt < 10 * 60 * 1000) {
    return modelsCache.models
  }

  await ensureFreshToken()

  // Arena.ai не имеет /models endpoint. Модели берутся из HTML/JS.
  // Используем тот же список что bridge, но получим через page.evaluate
  try {
    if (page) {
      const models = await page.evaluate(async (cookie) => {
        const resp = await fetch('/api/me', {
          headers: { 'Cookie': `arena-auth-prod-v1=${cookie}` }
        })
        if (!resp.ok) return []
        // Модели загружаются динамически, попробуем другой способ
        return []
      }, arenaSession.cookie).catch(() => [])

      if (models.length > 0) {
        modelsCache = { models, fetchedAt: now }
        return models
      }
    }
  } catch { /* fallback */ }

  // Fallback: хардкоженный список популярных моделей
  const defaultModels = [
    'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro',
    'gpt-5.5-instant', 'gpt-5.2', 'gpt-5.1', 'gpt-4.1-2025-04-14',
    'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7',
    'grok-4.3', 'grok-4.20-beta-0309-reasoning',
    'o3-2025-04-16',
    'qwen3-max-preview', 'kimi-k2.5-instant',
    'mistral-large-3', 'deepseek-v3-0324',
  ]
  modelsCache = { models: defaultModels, fetchedAt: now }
  return defaultModels
}

// ── Главная функция: отправка сообщения ─────────────────────────────────────

/**
 * Отправляет сообщение через Arena.ai API.
 * Принимает OpenAI-формат, переводит в Arena.ai формат.
 *
 * @param {object} params
 * @param {string} params.model - Имя модели (gemini-2.5-flash, gpt-5.5-instant и т.д.)
 * @param {Array} params.messages - Массив сообщений [{role, content}]
 * @param {boolean} params.stream - Стриминг
 * @param {number} params.temperature - Температура (игнорируется Arena.ai)
 * @param {object} res - Express response (для SSE стриминга)
 */
export async function handleArenaChat({ model, messages, stream = true, temperature }, res) {
  await ensureStarted()
  await ensureFreshToken()

  const evalId = uuidv7()
  const userMsgId = uuidv7()
  const modelMsgId = uuidv7()

  // Собираем текст из всех сообщений
  const userContent = messages
    .filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string' ? m.content : '')
    .pop() || 'Hello'

  // Системный промпт передаём как часть контента (Arena.ai не поддерживает system messages отдельно)
  const systemMessages = messages.filter(m => m.role === 'system')
  const fullContent = systemMessages.length > 0
    ? `${systemMessages.map(m => m.content).join('\n')}\n\n${userContent}`
    : userContent

  // Получаем reCAPTCHA v3 токен
  const recaptchaToken = await getRecaptchaToken('chat_submit')

  const body = {
    id: evalId,
    mode: 'direct',
    modality: 'chat',
    modelAId: model,
    userMessageId: userMsgId,
    modelAMessageId: modelMsgId,
    userMessage: {
      content: fullContent,
      experimental_attachments: [],
      metadata: {},
    },
    recaptchaV3Token: recaptchaToken,
  }

  const headers = buildHeaders()

  log(`Chat request: model=${model}, content=${fullContent.slice(0, 50)}...`)

  const upstream = await fetch(`${ARENA_ORIGIN}/nextjs-api/stream/create-evaluation`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    warn(`Arena.ai responded ${upstream.status}: ${errText.slice(0, 200)}`)

    // Если recaptcha failed — попробуем без токена
    if (errText.includes('recaptcha') && recaptchaToken) {
      warn('reCAPTCHA failed, retrying without token...')
      body.recaptchaV3Token = null
      const retry = await fetch(`${ARENA_ORIGIN}/nextjs-api/stream/create-evaluation`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      })
      if (!retry.ok) {
        const retryErr = await retry.text().catch(() => '')
        return res.status(retry.status).json({
          error: `Arena.ai: ${retryErr.slice(0, 500)}`,
        })
      }
      return streamArenaResponse(retry, res, stream, model)
    }

    return res.status(upstream.status).json({
      error: `Arena.ai: ${errText.slice(0, 500)}`,
    })
  }

  return streamArenaResponse(upstream, res, stream, model)
}

async function streamArenaResponse(upstream, res, stream, model) {
  const contentType = upstream.headers.get('content-type') || ''

  if (stream) {
    // Arena.ai возвращает SSE — пробрасываем, переформатируя в OpenAI формат
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

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === '[DONE]') continue

          try {
            const payload = JSON.parse(raw)
            // Arena.ai SSE формат может отличаться от OpenAI
            // Пробуем извлечь текст и переформатировать
            const text = extractArenaText(payload)
            if (text) {
              const chunk = {
                id: `arena-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                }],
              }
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch (e) {
      if (!res.destroyed) {
        warn('Stream error:', e.message)
      }
    }

    res.write('data: [DONE]\n\n')
    res.end()
  } else {
    // Non-stream: собираем весь ответ
    const text = await upstream.text()
    let fullContent = ''

    // Парсим SSE если Arena.ai всегда стримит
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        fullContent += extractArenaText(JSON.parse(raw))
      } catch { /* skip */ }
    }

    // Если не SSE — может быть обычный JSON
    if (!fullContent) {
      try {
        const json = JSON.parse(text)
        fullContent = extractArenaText(json)
      } catch { /* ignore */ }
    }

    res.json({
      id: `arena-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fullContent || text },
        finish_reason: 'stop',
      }],
    })
  }
}

function extractArenaText(payload) {
  if (!payload || typeof payload !== 'object') return ''

  // OpenAI формат
  const choice = payload.choices?.[0]
  if (choice) {
    return choice.delta?.content || choice.message?.content || ''
  }

  // Arena.ai может использовать свой формат
  // Типичные поля: content, text, message, response
  for (const field of ['content', 'text', 'message', 'response', 'answer']) {
    if (typeof payload[field] === 'string') return payload[field]
  }

  // Вложенный: data.content
  if (payload.data && typeof payload.data === 'object') {
    for (const field of ['content', 'text', 'message']) {
      if (typeof payload.data[field] === 'string') return payload.data[field]
    }
  }

  return ''
}

// ── Публичный API ───────────────────────────────────────────────────────────

/**
 * Проверяет доступен ли Arena.ai адаптер.
 * Включается если задан ARENA_REFRESH_TOKEN.
 */
export function isArenaEnabled() {
  return Boolean(process.env.ARENA_REFRESH_TOKEN || process.env.ARENA_ENABLED === '1')
}

/**
 * Проверяет, является ли baseUrl адресом Arena.ai.
 */
export function isArenaUrl(baseUrl = '') {
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^www\./, '')
    return hostname === 'arena.ai' || hostname === 'lmarena.ai'
  } catch {
    return false
  }
}

/**
 * Инициализирует адаптер (запускает Playwright).
 * Вызывается один раз при старте сервера.
 */
export async function ensureStarted() {
  if (!isArenaEnabled()) {
    throw new Error('Arena.ai адаптер не включён. Задайте ARENA_REFRESH_TOKEN в переменных окружения.')
  }

  if (startPromise) return startPromise
  if (browser && browser.isConnected()) return

  startPromise = (async () => {
    try {
      starting = true
      await ensureBrowser()
      await ensureFreshToken()
      starting = false
    } catch (e) {
      starting = false
      startPromise = null
      throw e
    }
  })()

  return startPromise
}

/**
 * Возвращает список моделей в OpenAI формате.
 */
export async function getArenaModels() {
  const models = await arenaFetchModels()
  return {
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'arena.ai',
    })),
  }
}

/**
 * Проверяет валидность Arena.ai сессии.
 */
export async function validateArenaSession() {
  try {
    await ensureStarted()
    await ensureFreshToken()

    const resp = await fetch(`${ARENA_ORIGIN}/api/me`, {
      headers: buildHeaders(),
    })

    if (!resp.ok) {
      return { ok: false, message: `Arena.ai: ${resp.status}` }
    }

    const data = await resp.json()
    return {
      ok: true,
      message: `Arena.ai подключён · ${data.user?.email || 'unknown'}`,
      userId: data.user?.id,
    }
  } catch (e) {
    return { ok: false, message: `Arena.ai: ${e.message}` }
  }
}

/**
 * Корректно завершает браузер.
 */
export async function shutdownArena() {
  try {
    if (page) await page.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    page = null
    browser = null
    startPromise = null
    log('Shutdown complete')
  } catch (e) {
    warn('Shutdown error:', e.message)
  }
}

// Graceful shutdown
process.on('SIGTERM', shutdownArena)
process.on('SIGINT', shutdownArena)
