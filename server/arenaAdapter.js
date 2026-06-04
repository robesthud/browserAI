/**
 * arenaAdapter.js — встроенный адаптер Arena.ai для BrowserAI.
 *
 * Режим: PURE TOKEN/COOKIE MODE — БЕЗ АВТОЛОГИНА И СИМУЛЯЦИИ ЧЕЛОВЕКА.
 *
 * Возможности:
 *  1. Использует готовую cookie (ARENA_AUTH_COOKIE) если задана — полная base64-...
 *  2. Или bootstrap из ARENA_REFRESH_TOKEN + ARENA_ANON_KEY
 *  3. Автообновление Supabase access_token через refresh_token (без логина)
 *  4. Отправка чатов через page.evaluate(fetch()) — как настоящий браузер (с stealth)
 *  5. Авто-обновление cookie из set-cookie и рефреш токена
 *
 * НИКОГДА не использует ARENA_EMAIL / ARENA_PASSWORD и не запускает loginWithCredentials.
 * Нет human simulation, mouse, type, scroll для логина.
 *
 * Переменные окружения:
 *   ARENA_AUTH_COOKIE    — полная готовая cookie `base64-...` (с access+refresh) — ПРИОРИТЕТ
 *   ARENA_REFRESH_TOKEN  — refresh_token (для bootstrap без полной куки)
 *   ARENA_ANON_KEY       — Supabase anon key (huogzoeqzcrdvkwtvodi.supabase.co)
 *   ARENA_ENABLED        — '1' принудительно включить
 *   PLAYWRIGHT_CHROMIUM_PATH — путь к Chromium
 */

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
chromium.use(StealthPlugin())

import { execSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Путь для сохранения сессии между перезапусками ──────────────────────────
const SESSION_FILE = process.env.ARENA_SESSION_FILE
  || (existsSync('/data') ? '/data/arena_session.json' : path.join(__dirname, 'arena_session.json'))

const ARENA_ORIGIN = 'https://arena.ai'
const SUPABASE_URL = 'https://huogzoeqzcrdvkwtvodi.supabase.co'

let browser = null
let context = null
let page = null
let currentCookie = process.env.ARENA_AUTH_COOKIE || ''
let supabaseAnonKey = process.env.ARENA_ANON_KEY || null
let arenaRefreshToken = process.env.ARENA_REFRESH_TOKEN || null
let startPromise = null
let isLoggedIn = false

function log(...a) { console.log('[arena]', ...a) }
function warn(...a) { console.warn('[arena]', ...a) }

// ── Chromium path ────────────────────────────────────────────────────────────
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH
  }
  const candidates = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  ]
  for (const p of candidates) { if (existsSync(p)) return p }
  try {
    const r = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null', { encoding: 'utf8' }).trim()
    if (r) return r
  } catch { /* ignore */ }
  try {
    const r = execSync('find /nix/store -name chromium -type f -executable 2>/dev/null | head -1', { encoding: 'utf8' }).trim()
    if (r) return r
  } catch { /* ignore */ }
  warn('Chromium not found, using auto-detect')
  return undefined
}

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

// ── Случайные задержки (минимальные, только для стабильности, без human sim) ─
function randomDelay(min = 100, max = 400) {
  return Math.floor(Math.random() * (max - min) + min)
}

async function shortDelay(ms = 200) {
  await new Promise(r => setTimeout(r, ms))
}

// ── Сохранение/загрузка сессии ───────────────────────────────────────────────
function saveSession(sessionData) {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify({
      cookie: currentCookie,
      supabaseAnonKey,
      savedAt: Date.now(),
      sessionData,
    }, null, 2))
    log('Session saved to', SESSION_FILE)
  } catch (e) {
    warn('Cannot save session:', e.message)
  }
}

function loadSession() {
  try {
    if (!existsSync(SESSION_FILE)) return null
    const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
    // Сессия валидна 23 часа
    if (Date.now() - data.savedAt > 23 * 60 * 60 * 1000) {
      log('Saved session expired')
      return null
    }
    log('Loaded session from file')
    return data
  } catch {
    return null
  }
}

// ── Декодирование cookie ─────────────────────────────────────────────────────
function decodeCookie(cookie) {
  try {
    const val = cookie.startsWith('base64-') ? cookie.slice(7) : cookie
    const padded = val + '='.repeat((4 - val.length % 4) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch { return null }
}

function isTokenExpired(cookie = currentCookie) {
  if (!cookie && arenaRefreshToken) {
    return false // can bootstrap/refresh using provided refresh_token
  }
  const data = decodeCookie(cookie)
  if (!data) return true
  const expiresAt = (data.expires_at || 0) * 1000
  return Date.now() > expiresAt - 5 * 60 * 1000
}

// ── Обновление Supabase токена (pure token mode) ─────────────────────────────
async function refreshSupabaseToken() {
  // Поддержка ручного ввода anon key
  if (!supabaseAnonKey) {
    if (process.env.ARENA_ANON_KEY) {
      supabaseAnonKey = process.env.ARENA_ANON_KEY
      log('Используем ARENA_ANON_KEY из env')
    } else {
      warn('Supabase anon key not available — will try capture from browser')
      return false
    }
  }

  // Приоритет: предоставленный refresh_token > из текущей куки
  let refreshToken = arenaRefreshToken
  if (!refreshToken) {
    const data = decodeCookie(currentCookie)
    refreshToken = data?.refresh_token
  }
  if (!refreshToken) { 
    warn('No refresh_token (neither ARENA_REFRESH_TOKEN nor in cookie)')
    return false 
  }

  log('Refreshing Supabase token (PURE COOKIE/TOKEN MODE)...')
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
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

    // Обновляем refresh_token если пришёл новый
    if (newSession.refresh_token) {
      arenaRefreshToken = newSession.refresh_token
    }

    // Обновляем cookie в браузере
    if (page) {
      await page.evaluate((c) => {
        document.cookie = `arena-auth-prod-v1=${c}; path=/; domain=.arena.ai; secure; samesite=lax; max-age=2592000`
      }, currentCookie).catch(() => {})
    }

    saveSession(newSession)
    log('✅ Token refreshed! Expires:', new Date((newSession.expires_at || 0) * 1000).toISOString())
    return true
  } catch (e) {
    warn('Token refresh error:', e.message)
    return false
  }
}

// ── ЗАПУСК БРАУЗЕРА (pure cookie/token, NO LOGIN, NO HUMAN SIM) ──────────────
async function launchBrowser() {
  if (browser?.isConnected()) return

  const chromiumPath = findChromium()
  log('Запуск Chromium (PURE TOKEN/COOKIE MODE)...', chromiumPath || 'auto')

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1280,800',
    ],
  })

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    deviceScaleFactor: 1,
    hasTouch: false,
    javaScriptEnabled: true,
    colorScheme: 'dark',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
  })

  page = await context.newPage()

  // ── Скрываем автоматизацию через CDP (stealth) ─────────────────────────────
  try {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const arr = [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
            ]
            arr.item = i => arr[i]
            arr.namedItem = name => arr.find(p => p.name === name)
            arr.refresh = () => {}
            return arr
          }
        })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] })
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })
        window.chrome = {
          app: { isInstalled: false, InstallState: {}, RunningState: {} },
          runtime: { OnMessageEvent: {}, connect: () => {}, sendMessage: () => {} },
          loadTimes: () => ({ requestTime: Date.now() / 1000 - Math.random() * 2, startLoadTime: Date.now() / 1000 - Math.random() * 2, commitLoadTime: Date.now() / 1000 - Math.random(), finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: false, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }),
          csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 3000, tran: 15 }),
        }
        const originalQuery = window.navigator.permissions.query
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)
        const getParameter = WebGLRenderingContext.prototype.getParameter
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Inc.'
          if (parameter === 37446) return 'Intel Iris OpenGL Engine'
          return getParameter.call(this, parameter)
        }
        Object.defineProperty(screen, 'width', { get: () => 1920 })
        Object.defineProperty(screen, 'height', { get: () => 1080 })
        Object.defineProperty(screen, 'availWidth', { get: () => 1920 })
        Object.defineProperty(screen, 'availHeight', { get: () => 1040 })
      `,
    })
    log('CDP stealth injected')
  } catch (e) {
    warn('CDP stealth failed (non-fatal):', e.message)
  }

  // ── Перехват Supabase anon key ────────────────────────────────────────────
  context.on('request', (req) => {
    const url = req.url()
    if ((url.includes('supabase.co') || url.includes('supabase.in')) && !supabaseAnonKey) {
      const apikey = req.headers()['apikey']
      if (apikey) {
        supabaseAnonKey = apikey
        log('✅ Supabase anon key:', apikey.slice(0, 20) + '...')
      }
    }
  })

  // ── Route interceptor: cookie + anon key ─────────────────────────────────
  await context.route('**/*', async (route) => {
    const req = route.request()
    const url = req.url()
    const headers = { ...req.headers() }

    // Добавляем cookie ко всем запросам на arena.ai
    if (url.includes('arena.ai') && currentCookie) {
      const existing = headers['cookie'] || ''
      if (!existing.includes('arena-auth-prod-v1=')) {
        headers['cookie'] = existing
          ? existing + '; arena-auth-prod-v1=' + currentCookie
          : 'arena-auth-prod-v1=' + currentCookie
      }
    }

    // Перехватываем Supabase anon key
    if ((url.includes('supabase.co') || url.includes('supabase.in')) && !supabaseAnonKey) {
      const apikey = headers['apikey']
      if (apikey) {
        supabaseAnonKey = apikey
        log('✅ Supabase anon key intercepted:', apikey.slice(0, 20) + '...')
      }
    }

    await route.continue({ headers }).catch(() => {})
  })

  // ── Перехват обновлённых cookie из ответов ───────────────────────────────
  context.on('response', async (response) => {
    try {
      const setCookie = response.headers()['set-cookie'] || ''
      if (setCookie.includes('arena-auth-prod-v1=')) {
        const match = setCookie.match(/arena-auth-prod-v1=([^;]+)/)
        if (match) {
          currentCookie = decodeURIComponent(match[1])
          log('Cookie auto-refreshed from response')
          saveSession(decodeCookie(currentCookie))
        }
      }
    } catch { /* ignore */ }
  })

  // ── Загрузка сохранённой сессии или bootstrap из токенов ─────────────────
  log('Навигация на arena.ai (PURE TOKEN/COOKIE MODE)...')

  const saved = loadSession()
  if (saved?.cookie) {
    currentCookie = saved.cookie
    if (saved.supabaseAnonKey) supabaseAnonKey = saved.supabaseAnonKey
    log('Используем сохранённую сессию')
  }

  // Bootstrap из ARENA_REFRESH_TOKEN + ARENA_ANON_KEY (если нет полной куки)
  if (!currentCookie && arenaRefreshToken && supabaseAnonKey) {
    log('Bootstrapping full session from ARENA_REFRESH_TOKEN + ARENA_ANON_KEY (no login)...')
    const ok = await refreshSupabaseToken()
    if (ok) {
      log('✅ Session bootstrapped from provided refresh_token + anon key')
    } else {
      warn('Bootstrap from refresh_token failed — will try with provided cookie or browser state')
    }
  }

  // Если есть полная кука из env — используем сразу
  if (currentCookie && !saved?.cookie) {
    log('Используем ARENA_AUTH_COOKIE из env (pure mode)')
  }

  // Загружаем страницу
  await page.goto(`${ARENA_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    .catch(e => warn('Navigation error (non-fatal):', e.message))

  await shortDelay(1500)

  // Проверяем авторизацию
  let me = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/me', { credentials: 'include' })
      return r.ok ? await r.json() : { status: r.status }
    } catch (e) { return { error: e.message } }
  }).catch(() => null)

  if (me?.user) {
    log(`✅ Авторизован как: ${me.user.email} (via cookie/token, no login)`)
    isLoggedIn = true
    if (supabaseAnonKey) saveSession(decodeCookie(currentCookie))
  } else {
    log('Не авторизован по /api/me — но cookie/token может работать для чатов (проверь статус)')
    // Не падаем, даём шанс чату (cookie может быть свежей)
    isLoggedIn = !!currentCookie
  }

  // Ждём загрузки reCAPTCHA Enterprise (нужна для чатов)
  await page.waitForFunction(
    () => window.grecaptcha?.enterprise?.execute != null,
    { timeout: 15000 }
  ).catch(() => warn('reCAPTCHA Enterprise не загружена — запросы могут блокироваться'))

  log('Arena adapter готов (PURE TOKEN/COOKIE MODE — no auto-login)')
}

// ── reCAPTCHA токен из браузерного контекста ─────────────────────────────────
async function getRecaptchaToken(action = 'chat_submit') {
  if (!page) { warn('No page for reCAPTCHA'); return null }
  try {
    const loaded = await page.evaluate(() =>
      window.grecaptcha?.enterprise?.execute != null
    ).catch(() => false)

    if (!loaded) {
      warn('grecaptcha не загружена, перезагружаем...')
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

    if (token) log('✅ reCAPTCHA token (' + token.length + ' chars)')
    else warn('⚠️ reCAPTCHA token null')
    return token
  } catch (e) {
    warn('reCAPTCHA error:', e.message)
    return null
  }
}

// ── Фоновые задачи: рефреш токена + keep-alive ──────────────────────────────

// Рефреш каждые 50 минут (только token refresh, БЕЗ логина)
setInterval(async () => {
  if (!isArenaEnabled() || !supabaseAnonKey) return
  if (isTokenExpired()) {
    log('Токен истекает — автообновление (pure token mode)...')
    await refreshSupabaseToken()
    // НИКОГДА не fallback на логин
  }
}, 50 * 60 * 1000).unref?.()

// Keep-alive каждые 20 минут — лёгкая проверка без human sim
setInterval(async () => {
  if (!isArenaEnabled() || !page || !isLoggedIn) return
  try {
    log('Keep-alive: /api/me check (no human sim)')
    await page.evaluate(async () => {
      try {
        const r = await fetch('/api/me', { credentials: 'include' })
        return r.ok
      } catch { return false }
    }).catch(() => {})
  } catch { /* ignore */ }
}, 20 * 60 * 1000).unref?.()

// ── Основная функция чата ─────────────────────────────────────────────────────
export async function handleArenaChat({ model, messages, stream = true }, res) {
  await ensureStarted()

  // Автообновление токена
  if (isTokenExpired()) {
    const ok = await refreshSupabaseToken()
    if (!ok) {
      // Только refresh, без логина
      if (arenaRefreshToken && supabaseAnonKey) {
        log('Токен протух, пробуем рефреш из ARENA_REFRESH_TOKEN...')
        await refreshSupabaseToken()
      } else {
        return res.status(401).json({
          error: 'Arena.ai: сессия истекла. Обновите ARENA_AUTH_COOKIE или ARENA_REFRESH_TOKEN + ARENA_ANON_KEY (pure token mode, no email/pass).',
        })
      }
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

  const recaptchaToken = await getRecaptchaToken('chat_submit')

  const requestBody = {
    id: evalId,
    mode: 'direct',
    modality: 'chat',
    modelAId: model,
    userMessageId: userMsgId,
    modelAMessageId: modelMsgId,
    userMessage: { content: fullContent, experimental_attachments: [], metadata: {} },
    recaptchaV3Token: recaptchaToken,
  }

  log(`Chat: model=${model} content=\"${fullContent.slice(0, 60)}...\" recaptcha=${!!recaptchaToken}`)

  // Небольшая пауза (минимальная)
  await shortDelay(300)

  // Отправляем через page.evaluate(fetch()) — из контекста браузера
  let rawResponse
  try {
    rawResponse = await page.evaluate(async ({ url, body }) => {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
        })
        return { ok: resp.ok, status: resp.status, text: await resp.text() }
      } catch (e) {
        return { ok: false, status: 0, error: e.message, text: '' }
      }
    }, {
      url: `${ARENA_ORIGIN}/nextjs-api/stream/create-evaluation`,
      body: requestBody,
    })
  } catch (e) {
    warn('page.evaluate error:', e.message)
    // Перезапускаем браузер
    try {
      await shutdownArena()
      await launchBrowser()
    } catch { /* ignore */ }
    return res.status(503).json({
      error: 'Arena.ai: браузер перезапускается. Попробуйте через 15 секунд.',
    })
  }

  if (rawResponse?.error) {
    return res.status(502).json({ error: `Arena.ai fetch: ${rawResponse.error}` })
  }

  if (!rawResponse?.ok) {
    const snippet = (rawResponse?.text || '').slice(0, 300)
    warn(`Arena.ai HTTP ${rawResponse?.status}:`, snippet)

    if (rawResponse?.status === 403) {
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      return res.status(403).json({ error: 'Arena.ai: 403, страница перезагружена — попробуйте ещё раз.' })
    }
    if (rawResponse?.status === 429) {
      return res.status(429).json({ error: 'Arena.ai: rate limit (429). Подождите минуту.' })
    }
    if (rawResponse?.status === 401) {
      // Пробуем только refresh, БЕЗ логина
      if (arenaRefreshToken && supabaseAnonKey) {
        await refreshSupabaseToken()
      }
      return res.status(401).json({ error: 'Arena.ai: 401 — сессия истекла, обновили токен (pure mode).' })
    }
    return res.status(rawResponse?.status || 502).json({ error: `Arena.ai: ${snippet || 'Unknown error'}` })
  }

  const rawText = rawResponse.text || ''

  // Парсим SSE → OpenAI формат
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

// ── Public API ───────────────────────────────────────────────────────────────
export function isArenaEnabled() {
  // PURE TOKEN/COOKIE MODE ONLY — email/pass полностью удалены и не используются
  return Boolean(
    process.env.ARENA_AUTH_COOKIE ||
    process.env.ARENA_REFRESH_TOKEN ||
    process.env.ARENA_ANON_KEY ||
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
  if (!isArenaEnabled()) throw new Error('Arena.ai не настроен (pure token/cookie mode).')
  if (browser?.isConnected() && page) return
  if (startPromise) {
    try { await startPromise } catch { startPromise = null }
    if (browser?.isConnected() && page) return
  }
  startPromise = (async () => {
    try {
      await launchBrowser()
      if (!page) throw new Error('Page not created')
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
    'mistral-large-3', 'llama-3.3-70b-instruct',
  ]
  return {
    object: 'list',
    data: models.map(id => ({
      id, object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'arena.ai',
    })),
  }
}

export async function validateArenaSession() {
  try {
    await ensureStarted()
    if (isTokenExpired() && supabaseAnonKey) await refreshSupabaseToken()

    const me = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/me', { credentials: 'include' })
        return r.ok ? await r.json() : { status: r.status }
      } catch (e) { return { error: e.message } }
    }).catch(() => null)

    if (me?.user) return { ok: true, message: `Arena.ai подключён · ${me.user.email}` }
    return { ok: false, message: 'Arena.ai: не авторизован (но cookie может работать для чатов)' }
  } catch (e) {
    return { ok: false, message: `Arena.ai: ${e.message}` }
  }
}

export async function shutdownArena() {
  try {
    if (page) await page.close().catch(() => {})
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    page = null; context = null; browser = null; startPromise = null; isLoggedIn = false
    log('Shutdown')
  } catch { /* ignore */ }
}

process.on('SIGTERM', shutdownArena)
process.on('SIGINT', shutdownArena)
