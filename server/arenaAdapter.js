/**
 * arenaAdapter.js — встроенный адаптер Arena.ai для BrowserAI.
 *
 * Использует Playwright (headless Chromium) чтобы:
 *  1. Загрузить arena.ai с валидной cookie → пройти Cloudflare
 *  2. Получить reCAPTCHA Enterprise токен ВНУТРИ браузерного контекста
 *  3. Отправить запрос через page.evaluate(fetch()) — как настоящий браузер
 *
 * Ключевое отличие от предыдущей версии:
 *  - НЕ используем Node.js fetch() с cookie-заголовком (детектируется)
 *  - ИСПОЛЬЗУЕМ page.evaluate(fetch()) — запрос идёт из браузера, обходя reCAPTCHA Enterprise
 *
 * Переменные окружения:
 *   ARENA_AUTH_COOKIE   — полная cookie arena-auth-prod-v1 (base64-eyJ...)
 *   ARENA_ENABLED       — '1' чтобы включить принудительно
 */

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

chromium.use(StealthPlugin())

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// ── Chromium path detection ──────────────────────────────────────────────────
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    if (existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
      return process.env.PLAYWRIGHT_CHROMIUM_PATH
    }
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  try {
    const result = execSync(
      'which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null',
      { encoding: 'utf8' }
    ).trim()
    if (result) return result
  } catch { /* ignore */ }
  try {
    const result = execSync(
      'find /nix/store -name chromium -type f -executable 2>/dev/null | head -1',
      { encoding: 'utf8' }
    ).trim()
    if (result) return result
  } catch { /* ignore */ }
  warn('Chromium not found! Playwright will try its own binary.')
  return undefined
}

const ARENA_ORIGIN = 'https://arena.ai'

let browser = null
let context = null
let page = null
let currentCookie = process.env.ARENA_AUTH_COOKIE || ''
let supabaseAnonKey = null
let starting = false
let startPromise = null

function log(...a) { console.log('[arena]', ...a) }
function warn(...a) { console.warn('[arena]', ...a) }

// ── UUID v7 ──────────────────────────────────────────────────────────────────
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

// ── Token helpers ────────────────────────────────────────────────────────────
function isTokenExpired() {
  try {
    const cookieValue = currentCookie.startsWith('base64-')
      ? currentCookie.slice(7) : currentCookie
    const padded = cookieValue + '='.repeat((4 - cookieValue.length % 4) % 4)
    const data = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const expiresAt = (data.expires_at || 0) * 1000
    return Date.now() > expiresAt - 5 * 60 * 1000
  } catch {
    return true
  }
}

async function refreshSupabaseToken() {
  if (!supabaseAnonKey) {
    warn('Supabase anon key not intercepted — trying bootstrap...')
    await bootstrapAnonKey()
  }
  if (!supabaseAnonKey) {
    warn('Cannot refresh: Supabase anon key unavailable even after bootstrap')
    return false
  }
  let sessionData
  try {
    const cookieValue = currentCookie.startsWith('base64-')
      ? currentCookie.slice(7) : currentCookie
    const padded = cookieValue + '='.repeat((4 - cookieValue.length % 4) % 4)
    sessionData = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch (e) {
    warn('Cannot decode cookie for refresh:', e.message)
    return false
  }
  const refreshToken = sessionData?.refresh_token
  if (!refreshToken) { warn('No refresh_token in cookie'); return false }

  let supabaseUrl = 'https://huogzoeqzcrdvkwtvodi.supabase.co'
  try {
    const payload = JSON.parse(
      Buffer.from(sessionData.access_token.split('.')[1] + '==', 'base64').toString()
    )
    if (payload.iss) supabaseUrl = payload.iss.replace('/auth/v1', '')
  } catch { /* use default */ }

  log('Refreshing Supabase token...')
  try {
    const resp = await fetch(supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseAnonKey },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!resp.ok) {
      warn('Supabase refresh failed:', resp.status, (await resp.text().catch(() => '')).slice(0, 200))
      return false
    }
    const newSession = await resp.json()
    currentCookie = 'base64-' + Buffer.from(JSON.stringify(newSession)).toString('base64')

    // Обновляем cookie в браузере
    if (page) {
      await page.evaluate((c) => {
        document.cookie = 'arena-auth-prod-v1=' + c + '; path=/; domain=.arena.ai; secure; samesite=lax; max-age=2592000'
      }, currentCookie).catch(() => {})
    }
    const exp = newSession.expires_at
      ? new Date(newSession.expires_at * 1000).toISOString() : 'unknown'
    log('Token refreshed! Expires:', exp)
    return true
  } catch (e) {
    warn('Token refresh error:', e.message)
    return false
  }
}

// Фоновый рефреш токена каждые 50 минут
setInterval(async () => {
  if (!isArenaEnabled() || !supabaseAnonKey) return
  if (isTokenExpired()) {
    log('Token expiring soon — auto-refreshing...')
    await refreshSupabaseToken()
  }
}, 50 * 60 * 1000).unref?.()

// ── Browser launch ───────────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser?.isConnected()) return

  const chromiumPath = findChromium()
  log('Launching headless Chromium...', chromiumPath || 'auto-detect')

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      // Важно: НЕ отключаем WebGL и canvas — reCAPTCHA Enterprise их проверяет
      '--disable-blink-features=AutomationControlled',
    ],
  })

  context = await browser.newContext({
    // Chrome 131 Windows — максимально реалистичный UA
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Включаем JavaScript (нужен для reCAPTCHA)
    javaScriptEnabled: true,
  })

  page = await context.newPage()

  // Скрываем признаки автоматизации через CDP
  try {
    const cdpSession = await context.newCDPSession(page)
    await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Скрываем webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        // Реалистичные плагины
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ]
        })
        // Реалистичные языки
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        // Скрываем chrome.runtime.id (признак extension context)
        if (window.chrome && window.chrome.runtime) {
          Object.defineProperty(window.chrome.runtime, 'id', { get: () => undefined })
        }
      `,
    })
  } catch (e) {
    warn('CDP stealth injection failed (non-fatal):', e.message)
  }

  // ── Перехватываем Supabase anon key ────────────────────────────────────────
  context.on('request', (req) => {
    const url = req.url()
    if ((url.includes('supabase.co') || url.includes('supabase.in')) && !supabaseAnonKey) {
      const apikey = req.headers()['apikey']
      if (apikey) {
        supabaseAnonKey = apikey
        log('Supabase anon key intercepted:', apikey.slice(0, 20) + '...')
      }
    }
  })

  // ── Инжектируем cookie через route interceptor ──────────────────────────────
  // route interceptor гарантированно добавляет cookie ко ВСЕМ запросам на arena.ai
  if (currentCookie) {
    await context.route('**/*', async (route) => {
      const req = route.request()
      const url = req.url()
      const headers = { ...req.headers() }

      if (url.includes('arena.ai')) {
        const existing = headers['cookie'] || ''
        if (!existing.includes('arena-auth-prod-v1=')) {
          headers['cookie'] = existing
            ? existing + '; arena-auth-prod-v1=' + currentCookie
            : 'arena-auth-prod-v1=' + currentCookie
        }
      }

      // Перехватываем Supabase anon key из заголовков
      if ((url.includes('supabase.co') || url.includes('supabase.in')) && !supabaseAnonKey) {
        if (headers['apikey']) {
          supabaseAnonKey = headers['apikey']
          log('Supabase anon key intercepted via route:', supabaseAnonKey.slice(0, 20) + '...')
        }
      }

      await route.continue({ headers })
    })
    log('Cookie route interceptor installed')
  }

  // Перехватываем обновлённые cookies из ответов
  context.on('response', async (response) => {
    try {
      const setCookie = response.headers()['set-cookie'] || ''
      if (setCookie.includes('arena-auth-prod-v1=')) {
        const match = setCookie.match(/arena-auth-prod-v1=([^;]+)/)
        if (match) {
          currentCookie = decodeURIComponent(match[1])
          log('Cookie auto-refreshed by arena.ai response')
        }
      }
    } catch { /* ignore */ }
  })

  // ── Навигация на arena.ai ────────────────────────────────────────────────
  log('Navigating to arena.ai...')
  try {
    await page.goto(ARENA_ORIGIN + '/', {
      waitUntil: 'networkidle',
      timeout: 45000,
    })

    // Ждём загрузки reCAPTCHA Enterprise
    await page.waitForFunction(
      () => window.grecaptcha?.enterprise?.execute != null,
      { timeout: 15000 }
    ).catch(() => {
      warn('reCAPTCHA Enterprise not detected after 15s — will retry on first chat request')
    })

    // Проверяем авторизацию
    const me = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/me', { credentials: 'include' })
        return r.ok ? await r.json() : { status: r.status }
      } catch (e) {
        return { error: e.message }
      }
    }).catch(() => null)

    if (me?.user) {
      log(`✅ Authenticated as: ${me.user.email}`)
    } else {
      warn('⚠️ Not authenticated! me response:', JSON.stringify(me))
      warn('Cookie may be expired. Check ARENA_AUTH_COOKIE.')
    }
  } catch (e) {
    warn('Navigation failed (non-fatal):', e.message)
  }

  log('Arena adapter initialized')
}

// ── reCAPTCHA — получаем токен ВНУТРИ браузерного контекста ─────────────────
async function getRecaptchaToken(action = 'chat_submit') {
  if (!page) { warn('No page for reCAPTCHA'); return null }

  try {
    // Сначала проверяем что grecaptcha.enterprise загружена
    const loaded = await page.evaluate(
      () => window.grecaptcha?.enterprise?.execute != null
    ).catch(() => false)

    if (!loaded) {
      warn('grecaptcha.enterprise not loaded, trying to wait...')
      // Попытка перегрузить страницу чтобы инициализировать reCAPTCHA
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      await page.waitForFunction(
        () => window.grecaptcha?.enterprise?.execute != null,
        { timeout: 10000 }
      ).catch(() => {})
    }

    const token = await page.evaluate(async ({ key, action }) => {
      if (window.grecaptcha?.enterprise?.execute) {
        return await window.grecaptcha.enterprise.execute(key, { action })
      }
      if (window.grecaptcha?.execute) {
        return await window.grecaptcha.execute(key, { action })
      }
      return null
    }, { key: '6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0', action })

    if (token) {
      log('✅ reCAPTCHA token obtained (' + token.length + ' chars)')
    } else {
      warn('⚠️ reCAPTCHA token is null — grecaptcha not available')
    }
    return token
  } catch (e) {
    warn('reCAPTCHA error:', e.message)
    return null
  }
}

// ── ГЛАВНОЕ ИЗМЕНЕНИЕ: Chat через page.evaluate(fetch()) ─────────────────────
// Запрос выполняется ВНУТРИ браузерного контекста Playwright.
// Это означает что:
//   1. reCAPTCHA Enterprise видит реальный браузер, а не Node.js fetch()
//   2. Cookie передаются автоматически браузером (credentials: 'include')
//   3. Cloudflare не блокирует — запрос идёт от "настоящего" Chrome
export async function handleArenaChat({ model, messages, stream = true, temperature }, res) {
  await ensureStarted()

  // Автообновление токена
  if (isTokenExpired() && supabaseAnonKey) {
    const refreshed = await refreshSupabaseToken()
    if (!refreshed) {
      return res.status(401).json({
        error: 'Arena.ai: токен протух и не удалось обновить. Обновите ARENA_AUTH_COOKIE в Railway Variables.',
      })
    }
  }

  const evalId = uuidv7()
  const userMsgId = uuidv7()
  const modelMsgId = uuidv7()

  const userContent = messages.filter(m => m.role === 'user').map(m => m.content).pop() || 'Hello'
  const systemMsgs = messages.filter(m => m.role === 'system')
  const fullContent = systemMsgs.length > 0
    ? systemMsgs.map(m => m.content).join('\n') + '\n\n' + userContent
    : userContent

  // Получаем reCAPTCHA токен из браузерного контекста
  const recaptchaToken = await getRecaptchaToken('chat_submit')

  const requestBody = {
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

  log(`Chat: model=${model} content="${fullContent.slice(0, 60)}..." recaptcha=${!!recaptchaToken}`)

  // ── Отправка через page.evaluate(fetch()) — КЛЮЧЕВОЕ РЕШЕНИЕ ─────────────
  // Запрос идёт изнутри браузера: cookies передаются автоматически,
  // reCAPTCHA видит реальный browser fingerprint, Cloudflare не блокирует
  let rawResponse
  try {
    rawResponse = await page.evaluate(async ({ url, body }) => {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include', // Автоматически передаём cookie из браузера
        })
        const text = await resp.text()
        return { ok: resp.ok, status: resp.status, text }
      } catch (e) {
        return { ok: false, status: 0, error: e.message, text: '' }
      }
    }, {
      url: ARENA_ORIGIN + '/nextjs-api/stream/create-evaluation',
      body: requestBody,
    })
  } catch (e) {
    warn('page.evaluate error:', e.message)
    // Fallback: если page.evaluate упал — пробуем перезапустить браузер и повторить
    try {
      await shutdownArena()
      await launchBrowser()
      return res.status(503).json({
        error: 'Arena.ai: браузер перезапускается. Попробуйте снова через 10-15 секунд.',
      })
    } catch {
      return res.status(502).json({ error: `Arena.ai page error: ${e.message}` })
    }
  }

  if (rawResponse?.error) {
    warn('Fetch error inside browser:', rawResponse.error)
    return res.status(502).json({ error: `Arena.ai fetch error: ${rawResponse.error}` })
  }

  if (!rawResponse?.ok) {
    const snippet = (rawResponse?.text || '').slice(0, 300)
    warn(`Arena.ai HTTP ${rawResponse?.status}: ${snippet}`)

    // 403 / 429 — скорее всего reCAPTCHA или rate-limit
    if (rawResponse?.status === 403) {
      // Перезагружаем страницу чтобы обновить reCAPTCHA сессию
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      return res.status(403).json({
        error: `Arena.ai: запрос отклонён (403). Страница перезагружена — попробуйте ещё раз.`,
      })
    }
    if (rawResponse?.status === 429) {
      return res.status(429).json({
        error: `Arena.ai: слишком много запросов (429). Подождите минуту и попробуйте снова.`,
      })
    }
    if (rawResponse?.status === 401) {
      return res.status(401).json({
        error: `Arena.ai: сессия истекла (401). Обновите ARENA_AUTH_COOKIE в Railway Variables.`,
      })
    }

    return res.status(rawResponse?.status || 502).json({
      error: `Arena.ai: ${snippet || 'Unknown error'}`,
    })
  }

  const rawText = rawResponse.text || ''

  // ── Парсим SSE и отдаём клиенту ────────────────────────────────────────────
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
      } catch { /* skip malformed chunk */ }
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

// ── Extract text from Arena.ai SSE payload ──────────────────────────────────
function extractText(p) {
  if (!p || typeof p !== 'object') return ''
  const c = p.choices?.[0]
  if (c) return c.delta?.content || c.message?.content || ''
  for (const f of ['content', 'text', 'message', 'response']) {
    if (typeof p[f] === 'string') return p[f]
  }
  return ''
}

// ── Public API ───────────────────────────────────────────────────────────────
export function isArenaEnabled() {
  return Boolean(
    process.env.ARENA_AUTH_COOKIE ||
    process.env.ARENA_REFRESH_TOKEN ||
    process.env.ARENA_ENABLED === '1'
  )
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
    'gemini-2.5-flash', 'gemini-2.5-pro',
    'gpt-4.1-2025-04-14', 'gpt-4o',
    'claude-sonnet-4-5', 'claude-opus-4-5',
    'grok-3', 'grok-3-mini',
    'o3-2025-04-16', 'o4-mini',
    'qwen3-235b-a22b', 'qwen3-30b-a3b',
    'deepseek-v3', 'deepseek-r1',
    'mistral-large-3',
    'llama-3.3-70b-instruct',
  ]
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

export async function validateArenaSession() {
  try {
    await ensureStarted()
    if (isTokenExpired() && supabaseAnonKey) {
      await refreshSupabaseToken()
    }
    // Проверяем через page.evaluate — чтобы использовать браузерный контекст
    const me = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/me', { credentials: 'include' })
        return r.ok ? await r.json() : { status: r.status }
      } catch (e) {
        return { error: e.message }
      }
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
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    page = null; context = null; browser = null; startPromise = null
    log('Shutdown complete')
  } catch { /* ignore */ }
}

process.on('SIGTERM', shutdownArena)
process.on('SIGINT', shutdownArena)

// ── Bootstrap: получить Supabase anon key через отдельный браузер ─────────────
// Вызывается когда supabaseAnonKey = null и нужно сделать refresh
export async function bootstrapAnonKey() {
  const chromiumPath = findChromium()
  log('Bootstrapping Supabase anon key...')
  
  let foundKey = null
  let tempBrowser = null
  
  try {
    tempBrowser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
    })
    const ctx = await tempBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })
    const pg = await ctx.newPage()
    
    // Перехватываем ВСЕ запросы — ищем Supabase apikey
    await ctx.route('**/*', async (route) => {
      const req = route.request()
      const url = req.url()
      const headers = req.headers()
      
      // Supabase запросы — перехватываем apikey
      if (url.includes('supabase.co') || url.includes('supabase.in')) {
        const apikey = headers['apikey'] || headers['Apikey'] || headers['APIKEY']
        if (apikey && !foundKey) {
          foundKey = apikey
          log('Bootstrap: Supabase anon key intercepted from', url.split('?')[0])
        }
      }
      
      // Добавляем cookie для авторизации
      if (url.includes('arena.ai') && currentCookie) {
        const existing = headers['cookie'] || ''
        if (!existing.includes('arena-auth-prod-v1=')) {
          headers['cookie'] = existing
            ? existing + '; arena-auth-prod-v1=' + currentCookie
            : 'arena-auth-prod-v1=' + currentCookie
        }
      }
      
      await route.continue({ headers }).catch(() => {})
    })
    
    // Загружаем страницу — arena.ai сделает Supabase запросы автоматически
    await pg.goto('https://arena.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    
    // Ждём до 15 секунд чтобы поймать Supabase запросы
    let waited = 0
    while (!foundKey && waited < 15000) {
      await pg.waitForTimeout(500)
      waited += 500
    }
    
    if (foundKey) {
      supabaseAnonKey = foundKey
      log('Bootstrap: anon key obtained:', foundKey.slice(0, 20) + '...')
    } else {
      warn('Bootstrap: anon key not found in 15s')
    }
  } catch (e) {
    warn('Bootstrap error:', e.message)
  } finally {
    if (tempBrowser) await tempBrowser.close().catch(() => {})
  }
  
  return foundKey
}
