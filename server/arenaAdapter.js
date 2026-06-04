/**
 * arenaAdapter.js — встроенный адаптер Arena.ai для BrowserAI.
 *
 * Использует Playwright (headless Chromium) чтобы:
 *  1. Загрузить arena.ai с валидной cookie → пройти Cloudflare
 *  2. Получить reCAPTCHA v3 токен для каждого запроса
 *  3. Cookie обновляется автоматически через arena.ai JS (Supabase refresh)
 *
 * Переменные окружения:
 *   ARENA_AUTH_COOKIE     — полная cookie arena-auth-prod-v1 (base64-eyJ...)
 *   ARENA_REFRESH_TOKEN   — альтернатива: только refresh_token (если есть anon key)
 *   ARENA_ENABLED         — '1' чтобы включить
 */

import { chromium } from 'playwright-core'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

function findChromium() {
  // Явно заданный путь
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    if (existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
      return process.env.PLAYWRIGHT_CHROMIUM_PATH
    }
  }

  // Стандартные пути
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]

  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  // Поиск через which (nixpacks добавляет в PATH)
  try {
    const result = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null', { encoding: 'utf8' }).trim()
    if (result) return result
  } catch { /* ignore */ }

  // Поиск в /nix/store
  try {
    const result = execSync('find /nix/store -name chromium -type f -executable 2>/dev/null | head -1', { encoding: 'utf8' }).trim()
    if (result) return result
  } catch { /* ignore */ }

  warn('Chromium not found! Playwright will try its own binary.')
  return undefined
}


const ARENA_ORIGIN = 'https://arena.ai'

let browser = null
let page = null
let currentCookie = process.env.ARENA_AUTH_COOKIE || ''
let recaptchaSiteKey = null
let supabaseAnonKey = null
let starting = false
let startPromise = null

// ── UUID v7 ─────────────────────────────────────────────────────────────────
function uuidv7() {
  const ts = Date.now()
  const r = new Uint8Array(10)
  globalThis.crypto.getRandomValues(r)
  const buf = new Uint8Array(16)
  buf[0] = (ts / 2**40) & 0xff; buf[1] = (ts / 2**32) & 0xff
  buf[2] = (ts / 2**24) & 0xff; buf[3] = (ts / 2**16) & 0xff
  buf[4] = (ts / 2**8)  & 0xff; buf[5] = ts & 0xff
  buf[6] = 0x70 | (r[0] & 0x0f); buf[7] = r[1]
  buf[8] = 0x80 | (r[2] & 0x3f)
  for (let i = 3; i < 10; i++) buf[i + 6] = r[i]
  const h = [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
}

function log(...a) { console.log('[arena]', ...a) }
function warn(...a) { console.warn('[arena]', ...a) }

// ── Browser ─────────────────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser?.isConnected()) return
  const chromiumPath = findChromium()
  log('Launching headless Chromium...', chromiumPath ? `path: ${chromiumPath}` : 'auto-detect')
  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  // Устанавливаем arena cookie
  if (currentCookie) {
    log('Cookie will be set via JavaScript after navigation')
  }

  page = await context.newPage()

  // Инжектируем cookie через route interceptor — 100% надёжно
  // CDP/document.cookie не работают с длинными base64 cookies
  if (currentCookie) {
    await page.route('**/*', async (route) => {
      const request = route.request()
      const url = request.url()
      const headers = { ...request.headers() }
      
      // Добавляем cookie ко всем запросам на arena.ai
      if (url.includes('arena.ai')) {
        const existing = headers['cookie'] || ''
        if (!existing.includes('arena-auth-prod-v1=')) {
          headers['cookie'] = existing 
            ? existing + '; arena-auth-prod-v1=' + currentCookie
            : 'arena-auth-prod-v1=' + currentCookie
        }
      }
      
      // Перехватываем Supabase anon key
      if ((url.includes('supabase.co') || url.includes('supabase.in')) && !supabaseAnonKey) {
        if (headers['apikey']) {
          supabaseAnonKey = headers['apikey']
          log('Supabase anon key intercepted:', supabaseAnonKey.slice(0, 20) + '...')
        }
      }
      
      await route.continue({ headers })
    })
    log('Cookie route interceptor installed')
  }

  // Перехватываем обновлённые cookies и Supabase anon key
  context.on('response', async (response) => {
    try {
      const url = response.url()
      const hdrs = response.headers()
      
      // Перехват обновлённых cookies
      const setCookie = hdrs['set-cookie'] || ''
      if (setCookie.includes('arena-auth-prod-v1=')) {
        const match = setCookie.match(/arena-auth-prod-v1=([^;]+)/)
        if (match) {
          currentCookie = decodeURIComponent(match[1])
          log('Cookie auto-refreshed by arena.ai')
        }
      }
    } catch { /* ignore */ }
  })

  // Перехватываем Supabase anon key из outgoing requests
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = request.url()
    
    // Supabase запросы содержат apikey в header
    if (url.includes('supabase.co') || url.includes('supabase.in')) {
      const headers = request.headers()
      if (headers['apikey'] && !supabaseAnonKey) {
        supabaseAnonKey = headers['apikey']
        log('Supabase anon key intercepted:', supabaseAnonKey.slice(0, 20) + '...')
      }
    }
    
    await route.continue()
  })

  log('Browser launched, creating page...')
  if (!page) {
    throw new Error('Page creation failed — browser context may have crashed')
  }

  log('Navigating to arena.ai...')
  try {
    await page.goto(ARENA_ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000) // Wait for Cloudflare + page init

    // Извлекаем reCAPTCHA site key
    recaptchaSiteKey = await page.evaluate(() => {
      for (const s of document.querySelectorAll('script[src*="recaptcha"]')) {
        const m = s.src.match(/render=([^&]+)/)
        if (m) return m[1]
      }
      // Или из grecaptcha._config
      try { return window.grecaptcha?.enterprise?.execute ? null : null } catch { return null }
      return null
    }).catch(() => null)

    // Также попробуем через page content
    if (!recaptchaSiteKey) {
      const html = await page.content()
      const m = html.match(/recaptcha[^"]*render=([A-Za-z0-9_-]+)/)
      if (m) recaptchaSiteKey = m[1]
    }

    log(`Browser ready. reCAPTCHA key: ${recaptchaSiteKey || 'not found'}`)

    // Проверяем auth
    const me = await page.evaluate(async () => {
      const r = await fetch('/api/me')
      return r.ok ? await r.json() : null
    }).catch(() => null)

    if (me?.user) {
      log(`Authenticated as: ${me.user.email}`)
    } else {
      warn('Not authenticated! Cookie may be expired.')
    }
  } catch (e) {
    warn('Failed to load arena.ai:', e.message)
    // Не фатально — page уже создана, просто навигация не удалась
    // Можем попробовать без навигации (прямые fetch запросы)
  }

  if (!page) throw new Error('Browser page is null after launch')
  log('Arena adapter fully initialized')
}

// ── reCAPTCHA ───────────────────────────────────────────────────────────────
async function getRecaptchaToken(action = 'chat_submit') {
  if (!page || !recaptchaSiteKey) return null
  try {
    return await page.evaluate(async ({ key, action }) => {
      if (!window.grecaptcha?.execute) return null
      return await window.grecaptcha.execute(key, { action })
    }, { key: recaptchaSiteKey, action }).catch(() => null)
  } catch { return null }
}

// ── Headers ─────────────────────────────────────────────────────────────────
function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': ARENA_ORIGIN,
    'Referer': ARENA_ORIGIN + '/',
    'Accept': 'text/event-stream, application/json, */*',
    'Cookie': `arena-auth-prod-v1=${currentCookie}`,
  }
}

// ── Chat ────────────────────────────────────────────────────────────────────

// ── Supabase Token Auto-Refresh ─────────────────────────────────────────────
async function refreshSupabaseToken() {
  if (!supabaseAnonKey) {
    warn('Cannot refresh: Supabase anon key not yet intercepted')
    return false
  }
  
  // Декодируем текущую cookie чтобы получить refresh_token
  let sessionData
  try {
    const cookieValue = currentCookie.startsWith('base64-') ? currentCookie.slice(7) : currentCookie
    // Добавляем padding если нужно
    const padded = cookieValue + '='.repeat((4 - cookieValue.length % 4) % 4)
    sessionData = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch (e) {
    warn('Cannot decode cookie for refresh:', e.message)
    return false
  }
  
  const refreshToken = sessionData?.refresh_token
  if (!refreshToken) {
    warn('No refresh_token in cookie')
    return false
  }
  
  // Supabase URL из JWT issuer
  let supabaseUrl = 'https://huogzoeqzcrdvkwtvodi.supabase.co'
  try {
    const payload = JSON.parse(Buffer.from(sessionData.access_token.split('.')[1] + '==', 'base64').toString())
    if (payload.iss) supabaseUrl = payload.iss.replace('/auth/v1', '')
  } catch { /* use default */ }
  
  log('Refreshing Supabase token...')
  
  try {
    const resp = await fetch(supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      warn('Supabase refresh failed:', resp.status, text.slice(0, 200))
      return false
    }
    
    const newSession = await resp.json()
    
    // Обновляем cookie
    const newCookiePayload = JSON.stringify(newSession)
    currentCookie = 'base64-' + Buffer.from(newCookiePayload).toString('base64')
    
    // Обновляем cookie в браузере
    if (page) {
      try {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Network.setCookie', {
          name: 'arena-auth-prod-v1',
          value: currentCookie,
          domain: '.arena.ai',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'Lax',
        })
      } catch {
        // Fallback
        await page.evaluate((c) => {
          document.cookie = 'arena-auth-prod-v1=' + c + '; path=/; secure; samesite=lax; max-age=2592000'
        }, currentCookie)
      }
    }
    
    const exp = newSession.expires_at ? new Date(newSession.expires_at * 1000).toISOString() : 'unknown'
    log('Token refreshed! Expires:', exp, 'New refresh_token:', newSession.refresh_token?.slice(0, 8) + '...')
    return true
  } catch (e) {
    warn('Token refresh error:', e.message)
    return false
  }
}

// Проверяем не протух ли access_token
function isTokenExpired() {
  try {
    const cookieValue = currentCookie.startsWith('base64-') ? currentCookie.slice(7) : currentCookie
    const padded = cookieValue + '='.repeat((4 - cookieValue.length % 4) % 4)
    const data = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const expiresAt = (data.expires_at || 0) * 1000
    // Обновляем за 5 минут до expiry
    return Date.now() > expiresAt - 5 * 60 * 1000
  } catch {
    return true // если не можем декодировать — считаем протухшим
  }
}

// Фоновое автообновление токена каждые 50 минут
setInterval(async () => {
  if (!isArenaEnabled() || !supabaseAnonKey) return
  if (isTokenExpired()) {
    log('Token expired or expiring soon — auto-refreshing...')
    await refreshSupabaseToken()
  }
}, 50 * 60 * 1000).unref?.()

export async function handleArenaChat({ model, messages, stream = true, temperature }, res) {
  await ensureStarted()
  
  // Автообновление токена если протух
  if (isTokenExpired() && supabaseAnonKey) {
    const refreshed = await refreshSupabaseToken()
    if (!refreshed) {
      return res.status(401).json({ error: 'Arena.ai: токен протух и не удалось обновить. Обновите ARENA_AUTH_COOKIE.' })
    }
  }

  const evalId = uuidv7()
  const userMsgId = uuidv7()
  const modelMsgId = uuidv7()

  // Последнее сообщение пользователя
  const userContent = messages.filter(m => m.role === 'user').map(m => m.content).pop() || 'Hello'
  const systemMsgs = messages.filter(m => m.role === 'system')
  const fullContent = systemMsgs.length > 0
    ? systemMsgs.map(m => m.content).join('\n') + '\n\n' + userContent
    : userContent

  const recaptchaToken = await getRecaptchaToken()

  const body = {
    id: evalId,
    mode: 'direct',
    modality: 'chat',
    modelAId: model,
    userMessageId: userMsgId,
    modelAMessageId: modelMsgId,
    userMessage: { content: fullContent, experimental_attachments: [], metadata: {} },
    recaptchaV3Token: recaptchaToken,
  }

  log(`Chat: model=${model} content="${fullContent.slice(0, 50)}..." recaptcha=${!!recaptchaToken}`)

  // Отправляем через Playwright page context (обходит CORS/CF)
  let response
  try {
    response = await page.evaluate(async ({ url, body, headers }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        return { error: true, status: r.status, text }
      }
      // Для non-stream — читаем весь ответ
      const text = await r.text()
      return { error: false, status: r.status, text, contentType: r.headers.get('content-type') || '' }
    }, {
      url: `${ARENA_ORIGIN}/nextjs-api/stream/create-evaluation`,
      body,
      headers: {},
    })
  } catch (e) {
    return res.status(502).json({ error: `Arena.ai Playwright error: ${e.message}` })
  }

  if (response.error) {
    warn(`Arena.ai ${response.status}: ${response.text?.slice(0, 200)}`)
    return res.status(response.status || 502).json({
      error: `Arena.ai: ${response.text?.slice(0, 500) || 'Unknown error'}`,
    })
  }

  // Парсим SSE ответ и конвертируем в OpenAI формат
  const rawText = response.text || ''

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    for (const line of rawText.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        const payload = JSON.parse(raw)
        const text = extractText(payload)
        if (text) {
          res.write(`data: ${JSON.stringify({
            id: `arena-${Date.now()}`,
            object: 'chat.completion.chunk',
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          })}\n\n`)
        }
      } catch { /* skip */ }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } else {
    let fullText = ''
    for (const line of rawText.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      try { fullText += extractText(JSON.parse(raw)) } catch { /* skip */ }
    }
    if (!fullText) {
      try { fullText = extractText(JSON.parse(rawText)) } catch { fullText = rawText }
    }
    res.json({
      id: `arena-${Date.now()}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
    })
  }
}

function extractText(p) {
  if (!p || typeof p !== 'object') return ''
  const c = p.choices?.[0]
  if (c) return c.delta?.content || c.message?.content || ''
  for (const f of ['content', 'text', 'message', 'response']) {
    if (typeof p[f] === 'string') return p[f]
  }
  return ''
}

// ── Public API ──────────────────────────────────────────────────────────────
export function isArenaEnabled() {
  return Boolean(process.env.ARENA_AUTH_COOKIE || process.env.ARENA_REFRESH_TOKEN || process.env.ARENA_ENABLED === '1')
}

export function isArenaUrl(baseUrl = '') {
  try {
    const h = new URL(baseUrl).hostname.replace(/^www\./, '')
    return h === 'arena.ai' || h === 'lmarena.ai'
  } catch { return false }
}

export async function ensureStarted() {
  if (!isArenaEnabled()) throw new Error('Arena.ai не настроен. Задайте ARENA_AUTH_COOKIE.')
  if (browser?.isConnected() && page) return
  // Reset stale promise
  if (startPromise) {
    try { await startPromise } catch { startPromise = null }
    if (browser?.isConnected() && page) return
  }
  startPromise = (async () => {
    try {
      await launchBrowser()
      if (!page) throw new Error('Playwright page not created')
    } catch (e) {
      startPromise = null
      throw e
    }
  })()
  return startPromise
}

export async function getArenaModels() {
  const models = [
    'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro',
    'gpt-5.5-instant', 'gpt-5.2', 'gpt-5.1', 'gpt-4.1-2025-04-14',
    'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7',
    'grok-4.3', 'grok-4.20-beta-0309-reasoning',
    'o3-2025-04-16',
    'qwen3-max-preview', 'kimi-k2.5-instant',
    'mistral-large-3',
  ]
  return {
    object: 'list',
    data: models.map(id => ({ id, object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'arena.ai' })),
  }
}

export async function validateArenaSession() {
  try {
    await ensureStarted()
    
    // Пробуем обновить если протух
    if (isTokenExpired() && supabaseAnonKey) {
      await refreshSupabaseToken()
    }
    const me = await page.evaluate(async () => {
      const r = await fetch('/api/me')
      return r.ok ? await r.json() : null
    }).catch(() => null)

    if (me?.user) {
      return { ok: true, message: `Arena.ai подключён · ${me.user.email}` }
    }
    return { ok: false, message: 'Arena.ai: cookie протухла или невалидна' }
  } catch (e) {
    return { ok: false, message: `Arena.ai: ${e.message}` }
  }
}

export async function shutdownArena() {
  try {
    if (page) await page.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    page = null; browser = null; startPromise = null
    log('Shutdown')
  } catch { /* ignore */ }
}

process.on('SIGTERM', shutdownArena)
process.on('SIGINT', shutdownArena)
