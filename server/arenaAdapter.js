/**
 * arenaAdapter.js — встроенный адаптер Arena.ai для BrowserAI.
 *
 * Возможности:
 *  1. Авторизация через логин/пароль (ARENA_EMAIL + ARENA_PASSWORD)
 *     - Полная симуляция человека: движения мыши, задержки, скролл
 *     - Автоматически проходит Cloudflare и Google reCAPTCHA Enterprise
 *     - Перехватывает Supabase anon key и session cookie
 *  2. Или — использует готовую cookie (ARENA_AUTH_COOKIE) если задана
 *  3. Автообновление Supabase access_token через refresh_token
 *  4. Отправка чатов через page.evaluate(fetch()) — как настоящий браузер
 *  5. Полная симуляция человеческого поведения (anti-bot защита)
 *
 * Переменные окружения:
 *   ARENA_EMAIL          — email для авторизации на arena.ai
 *   ARENA_PASSWORD       — пароль для авторизации на arena.ai
 *   ARENA_AUTH_COOKIE    — готовая cookie (если нет email/password)
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
let supabaseAnonKey = null
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

// ── Случайные задержки для симуляции человека ────────────────────────────────
function randomDelay(min = 500, max = 1500) {
  return Math.floor(Math.random() * (max - min) + min)
}

async function humanDelay(min = 300, max = 900) {
  await new Promise(r => setTimeout(r, randomDelay(min, max)))
}

// ── Симуляция движений мыши по кривой Безье ─────────────────────────────────
async function humanMouseMove(page, toX, toY) {
  try {
    const { x: fromX, y: fromY } = await page.evaluate(() => ({
      x: window._lastMouseX || Math.floor(Math.random() * 800 + 200),
      y: window._lastMouseY || Math.floor(Math.random() * 400 + 100),
    })).catch(() => ({ x: 400, y: 300 }))

    // Кривая Безье: точки контроля — случайные отклонения
    const steps = Math.floor(randomDelay(8, 20))
    const cp1x = fromX + (toX - fromX) * 0.3 + randomDelay(-80, 80) - 80
    const cp1y = fromY + (toY - fromY) * 0.3 + randomDelay(-80, 80) - 80
    const cp2x = fromX + (toX - fromX) * 0.7 + randomDelay(-80, 80) - 80
    const cp2y = fromY + (toY - fromY) * 0.7 + randomDelay(-80, 80) - 80

    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = Math.round(
        (1-t)**3 * fromX + 3*(1-t)**2*t * cp1x + 3*(1-t)*t**2 * cp2x + t**3 * toX
      )
      const y = Math.round(
        (1-t)**3 * fromY + 3*(1-t)**2*t * cp1y + 3*(1-t)*t**2 * cp2y + t**3 * toY
      )
      await page.mouse.move(x, y)
      await new Promise(r => setTimeout(r, randomDelay(5, 25)))
    }

    // Сохраняем последнюю позицию
    await page.evaluate((x, y) => {
      window._lastMouseX = x; window._lastMouseY = y
    }, toX, toY).catch(() => {})
  } catch { /* ignore mouse errors */ }
}

// ── Симуляция человеческого клика ────────────────────────────────────────────
async function humanClick(page, selector) {
  const el = await page.waitForSelector(selector, { timeout: 10000 })
  const box = await el.boundingBox()
  if (!box) { await el.click(); return }

  // Кликаем в случайную точку внутри элемента (не по центру)
  const x = box.x + box.width * (0.3 + Math.random() * 0.4)
  const y = box.y + box.height * (0.2 + Math.random() * 0.6)

  await humanMouseMove(page, x, y)
  await humanDelay(80, 200)
  await page.mouse.down()
  await humanDelay(50, 120)
  await page.mouse.up()
  await humanDelay(100, 300)
}

// ── Симуляция человеческого ввода текста ─────────────────────────────────────
async function humanType(page, selector, text) {
  await humanClick(page, selector)
  await humanDelay(200, 500)

  // Очищаем поле по-человечески (Ctrl+A, Delete)
  await page.keyboard.down('Control')
  await page.keyboard.press('a')
  await page.keyboard.up('Control')
  await humanDelay(50, 150)
  await page.keyboard.press('Delete')
  await humanDelay(100, 300)

  // Печатаем посимвольно с случайными задержками
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomDelay(40, 140) })
    // Иногда делаем паузу как живой человек
    if (Math.random() < 0.05) {
      await humanDelay(300, 800)
    }
  }
  await humanDelay(200, 500)
}

// ── Симуляция скролла ────────────────────────────────────────────────────────
async function humanScroll(page, distance = null) {
  const d = distance || randomDelay(200, 600)
  const steps = Math.floor(randomDelay(3, 8))
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, d / steps)
    await humanDelay(30, 80)
  }
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
  const data = decodeCookie(cookie)
  if (!data) return true
  const expiresAt = (data.expires_at || 0) * 1000
  return Date.now() > expiresAt - 5 * 60 * 1000
}

// ── Обновление Supabase токена ───────────────────────────────────────────────
async function refreshSupabaseToken() {
  if (!supabaseAnonKey) {
    warn('Supabase anon key not available — will try login')
    return false
  }

  const data = decodeCookie(currentCookie)
  const refreshToken = data?.refresh_token
  if (!refreshToken) { warn('No refresh_token'); return false }

  log('Refreshing Supabase token...')
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

// ── АВТОРИЗАЦИЯ через логин/пароль ───────────────────────────────────────────
async function loginWithCredentials(pg) {
  const email = process.env.ARENA_EMAIL
  const password = process.env.ARENA_PASSWORD
  if (!email || !password) {
    warn('ARENA_EMAIL / ARENA_PASSWORD не заданы')
    return false
  }

  log(`Авторизация на arena.ai как ${email}...`)

  try {
    // 1. Идём на страницу входа
    await pg.goto(`${ARENA_ORIGIN}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await humanDelay(1500, 3000)

    // 2. Случайный скролл — имитируем изучение страницы
    await humanScroll(pg, randomDelay(100, 300))
    await humanDelay(500, 1200)

    // 3. Двигаем мышь по странице — поведение живого человека
    await humanMouseMove(pg, randomDelay(300, 700), randomDelay(200, 400))
    await humanDelay(300, 800)
    await humanMouseMove(pg, randomDelay(400, 800), randomDelay(300, 500))
    await humanDelay(500, 1000)

    // 4. Находим и заполняем поле email
    log('Заполняем email...')
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="Email" i]',
      '#email',
    ]
    let emailFilled = false
    for (const sel of emailSelectors) {
      try {
        await pg.waitForSelector(sel, { timeout: 3000 })
        await humanType(pg, sel, email)
        emailFilled = true
        log('Email введён через', sel)
        break
      } catch { /* попробуем следующий */ }
    }
    if (!emailFilled) {
      warn('Поле email не найдено')
      return false
    }

    // 5. Переходим к паролю с задержкой
    await humanDelay(400, 900)
    await pg.keyboard.press('Tab')
    await humanDelay(200, 500)

    // 6. Заполняем пароль
    log('Заполняем пароль...')
    const passSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password',
    ]
    let passFilled = false
    for (const sel of passSelectors) {
      try {
        await pg.waitForSelector(sel, { timeout: 3000 })
        await humanType(pg, sel, password)
        passFilled = true
        log('Пароль введён через', sel)
        break
      } catch { /* skip */ }
    }
    if (!passFilled) {
      warn('Поле пароля не найдено')
      return false
    }

    // 7. Пауза перед отправкой — человек "проверяет" данные
    await humanDelay(800, 2000)
    await humanMouseMove(pg, randomDelay(300, 600), randomDelay(400, 600))
    await humanDelay(300, 700)

    // 8. Нажимаем кнопку входа
    log('Нажимаем войти...')
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Continue")',
      'input[type="submit"]',
    ]
    let submitted = false
    for (const sel of submitSelectors) {
      try {
        await humanClick(pg, sel)
        submitted = true
        log('Форма отправлена через', sel)
        break
      } catch { /* skip */ }
    }
    if (!submitted) {
      // Fallback: Enter
      await pg.keyboard.press('Enter')
    }

    // 9. Ждём навигации после входа
    await humanDelay(2000, 4000)
    await pg.waitForURL(url => !url.includes('/sign-in') && !url.includes('/login'), {
      timeout: 20000,
    }).catch(() => { warn('URL не изменился после входа') })

    await humanDelay(1500, 3000)

    // 10. Проверяем успешность входа
    const me = await pg.evaluate(async () => {
      try {
        const r = await fetch('/api/me', { credentials: 'include' })
        return r.ok ? await r.json() : { status: r.status }
      } catch (e) { return { error: e.message } }
    }).catch(() => null)

    if (me?.user) {
      log(`✅ Авторизован как: ${me.user.email}`)
      isLoggedIn = true
      return true
    }

    warn('⚠️ Вход не удался. me:', JSON.stringify(me))
    return false

  } catch (e) {
    warn('Login error:', e.message)
    return false
  }
}

// ── Запуск браузера ──────────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser?.isConnected()) return

  const chromiumPath = findChromium()
  log('Запуск Chromium...', chromiumPath || 'auto')

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
      // Реалистичный размер окна
      '--window-size=1280,800',
    ],
  })

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Реалистичные параметры устройства
    deviceScaleFactor: 1,
    hasTouch: false,
    javaScriptEnabled: true,
    // Реалистичные разрешения
    colorScheme: 'dark',
    // Геолокация — Нью-Йорк (можно любой)
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
  })

  page = await context.newPage()

  // ── Скрываем автоматизацию через CDP ──────────────────────────────────────
  try {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Скрываем webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

        // Реалистичные плагины Chrome
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

        // Языки
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] })

        // Платформа
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })

        // Скрываем headless
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })

        // Chrome object — чтобы сайты не детектили отсутствие
        window.chrome = {
          app: { isInstalled: false, InstallState: {}, RunningState: {} },
          runtime: {
            OnMessageEvent: {},
            connect: () => {},
            sendMessage: () => {},
          },
          loadTimes: () => ({
            requestTime: Date.now() / 1000 - Math.random() * 2,
            startLoadTime: Date.now() / 1000 - Math.random() * 2,
            commitLoadTime: Date.now() / 1000 - Math.random(),
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: false,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2',
          }),
          csi: () => ({
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Math.random() * 3000,
            tran: 15,
          }),
        }

        // Permissions — как у реального пользователя
        const originalQuery = window.navigator.permissions.query
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)

        // WebGL fingerprint — скрываем headless маркеры
        const getParameter = WebGLRenderingContext.prototype.getParameter
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Inc.'
          if (parameter === 37446) return 'Intel Iris OpenGL Engine'
          return getParameter.call(this, parameter)
        }

        // Реалистичное разрешение экрана
        Object.defineProperty(screen, 'width', { get: () => 1920 })
        Object.defineProperty(screen, 'height', { get: () => 1080 })
        Object.defineProperty(screen, 'availWidth', { get: () => 1920 })
        Object.defineProperty(screen, 'availHeight', { get: () => 1040 })

        // Отслеживаем мышь (нужно для human mouse)
        document.addEventListener('mousemove', e => {
          window._lastMouseX = e.clientX
          window._lastMouseY = e.clientY
        }, { passive: true })
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

  // ── Загрузка сохранённой сессии или авторизация ───────────────────────────
  log('Навигация на arena.ai...')

  // Пробуем загрузить сохранённую сессию
  const saved = loadSession()
  if (saved?.cookie) {
    currentCookie = saved.cookie
    if (saved.supabaseAnonKey) supabaseAnonKey = saved.supabaseAnonKey
    log('Используем сохранённую сессию')
  }

  // Загружаем страницу
  await page.goto(`${ARENA_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    .catch(e => warn('Navigation error (non-fatal):', e.message))

  await humanDelay(2000, 4000)

  // Проверяем авторизацию
  let me = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/me', { credentials: 'include' })
      return r.ok ? await r.json() : { status: r.status }
    } catch (e) { return { error: e.message } }
  }).catch(() => null)

  if (me?.user) {
    log(`✅ Авторизован как: ${me.user.email}`)
    isLoggedIn = true
    if (supabaseAnonKey) saveSession(decodeCookie(currentCookie))
  } else {
    log('Не авторизован, пробуем войти...')

    // Попытка 1: обновить токен если есть anon key
    if (supabaseAnonKey && !isTokenExpired()) {
      log('Токен ещё валиден, пропускаем login')
    }
    // Попытка 2: логин через email/password
    else if (process.env.ARENA_EMAIL && process.env.ARENA_PASSWORD) {
      const loginOk = await loginWithCredentials(page)
      if (loginOk) {
        // После успешного входа — ждём и перехватываем anon key
        await humanDelay(2000, 4000)
        // Делаем лёгкие действия чтобы страница сделала Supabase запросы
        await humanScroll(page, 200)
        await humanDelay(1000, 2000)
        await humanScroll(page, -200)
        await humanDelay(1000, 2000)

        // Ждём anon key
        let waited = 0
        while (!supabaseAnonKey && waited < 10000) {
          await humanDelay(500, 500)
          waited += 500
        }

        if (supabaseAnonKey) {
          log('✅ Supabase anon key получен после входа')
          saveSession(decodeCookie(currentCookie))
        }
      }
    } else {
      warn('⚠️ Нет ARENA_EMAIL/ARENA_PASSWORD и cookie устарела')
      warn('Задайте ARENA_EMAIL и ARENA_PASSWORD в Railway Variables')
    }
  }

  // Ждём загрузки reCAPTCHA Enterprise
  await page.waitForFunction(
    () => window.grecaptcha?.enterprise?.execute != null,
    { timeout: 15000 }
  ).catch(() => warn('reCAPTCHA Enterprise не загружена — запросы могут блокироваться'))

  log('Arena adapter готов')
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

// ── Фоновые задачи: рефреш токена + симуляция активности ────────────────────

// Рефреш каждые 50 минут
setInterval(async () => {
  if (!isArenaEnabled() || !supabaseAnonKey) return
  if (isTokenExpired()) {
    log('Токен истекает — автообновление...')
    const ok = await refreshSupabaseToken()
    if (!ok && process.env.ARENA_EMAIL && process.env.ARENA_PASSWORD) {
      log('Refresh не удался, переавторизуемся...')
      if (page) await loginWithCredentials(page)
    }
  }
}, 50 * 60 * 1000).unref?.()

// Симуляция активности каждые 20 минут — чтобы Cloudflare не "засыпал"
setInterval(async () => {
  if (!isArenaEnabled() || !page || !isLoggedIn) return
  try {
    log('Симуляция активности (keep-alive)...')
    // Лёгкие движения мыши
    await humanMouseMove(page, randomDelay(300, 900), randomDelay(200, 500))
    await humanDelay(500, 1000)
    await humanScroll(page, randomDelay(50, 150))
    await humanDelay(300, 600)
    await humanScroll(page, -randomDelay(50, 150))
  } catch { /* ignore */ }
}, 20 * 60 * 1000).unref?.()

// ── Основная функция чата ─────────────────────────────────────────────────────
export async function handleArenaChat({ model, messages, stream = true }, res) {
  await ensureStarted()

  // Автообновление токена
  if (isTokenExpired()) {
    const ok = await refreshSupabaseToken()
    if (!ok) {
      // Пробуем переавторизоваться
      if (process.env.ARENA_EMAIL && process.env.ARENA_PASSWORD && page) {
        log('Токен протух, переавторизуемся...')
        await loginWithCredentials(page)
      } else {
        return res.status(401).json({
          error: 'Arena.ai: сессия истекла. Задайте ARENA_EMAIL + ARENA_PASSWORD или обновите ARENA_AUTH_COOKIE.',
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

  log(`Chat: model=${model} content="${fullContent.slice(0, 60)}..." recaptcha=${!!recaptchaToken}`)

  // Небольшая пауза перед запросом — как человек
  await humanDelay(200, 600)

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
      // Пробуем переавторизоваться
      if (process.env.ARENA_EMAIL && process.env.ARENA_PASSWORD && page) {
        await loginWithCredentials(page)
      }
      return res.status(401).json({ error: 'Arena.ai: 401 — сессия истекла, переавторизуемся.' })
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
  return Boolean(
    process.env.ARENA_EMAIL ||
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
  if (!isArenaEnabled()) throw new Error('Arena.ai не настроен.')
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
    return { ok: false, message: 'Arena.ai: не авторизован' }
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
