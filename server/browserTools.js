import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { safePath } from './workspace.js'

const sessions = new Map()
const SESSION_MAX_AGE_MS = 60 * 60 * 1000  // 1 hour
const SESSION_MAX_COUNT = 10

let browserPromise = null
let seq = 0

function clip(s = '', max = 4000) {
  const str = String(s || '')
  return str.length > max ? str.slice(0, max) + `\n... [truncated ${str.length - max} chars]` : str
}

function sessionId() {
  seq += 1
  return `br-${Date.now()}-${seq}`
}

async function getBrowser() {
  if (!browserPromise) {
    const executablePath = process.env.BROWSER_CHROMIUM_PATH || '/usr/bin/chromium-browser'
    browserPromise = chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
  }
  return browserPromise
}

function attachCollectors(page, state) {
  page.on('console', (msg) => {
    const type = msg.type()
    if (['error', 'warning'].includes(type)) {
      state.console.push({ type, text: msg.text().slice(0, 1000) })
    }
  })
  page.on('pageerror', (err) => {
    state.console.push({ type: 'pageerror', text: String(err?.message || err).slice(0, 1000) })
  })
  page.on('response', (res) => {
    const status = res.status()
    if (status >= 400) state.network.push({ status, url: res.url().slice(0, 500) })
  })
  page.on('requestfailed', (req) => {
    state.network.push({ failed: true, url: req.url().slice(0, 500), error: req.failure()?.errorText || '' })
  })
}

async function pageSummary(page, state, screenshotPath = '') {
  const title = await page.title().catch(() => '')
  const url = page.url()
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
  return {
    sessionId: state.id,
    title,
    url,
    text: clip(text, 2500),
    console: state.console.slice(-30),
    network: state.network.slice(-30),
    screenshotPath,
  }
}

async function saveScreenshot(page, relPath = '') {
  const name = relPath || `browser-screenshots/screenshot-${Date.now()}.jpg`
  const full = safePath(name)
  await fs.mkdir(path.dirname(full), { recursive: true })
  // Use JPEG with 80% quality to reduce size by 10x (making previews load instantly and saving VPS disk space!)
  await page.screenshot({ path: full, fullPage: true, type: 'jpeg', quality: 80 })
  return name
}

export async function browserOpen({ url, waitMs = 1500, screenshot = true } = {}) {
  if (!url || !/^https?:\/\//i.test(String(url))) throw new Error('url must start with http(s)')
  const browser = await getBrowser()
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const id = sessionId()
  const state = { id, context, page, console: [], network: [], createdAt: Date.now() }
  attachCollectors(page, state)
  sessions.set(id, state)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  if (waitMs) await page.waitForTimeout(Math.min(10_000, Math.max(0, Number(waitMs) || 0)))
  const shot = screenshot ? await saveScreenshot(page) : ''
  return pageSummary(page, state, shot)
}

export async function browserScreenshot({ sessionId, path: relPath = '' } = {}) {
  const state = sessions.get(sessionId)
  if (!state) throw new Error('browser session not found')
  const shot = await saveScreenshot(state.page, relPath)
  return pageSummary(state.page, state, shot)
}

async function findTarget(page, { selector = '', text = '' } = {}) {
  if (selector) return page.locator(selector).first()
  if (text) return page.getByText(text, { exact: false }).first()
  throw new Error('selector or text is required')
}

export async function browserClick({ sessionId, selector = '', text = '', waitMs = 1000 } = {}) {
  const state = sessions.get(sessionId)
  if (!state) throw new Error('browser session not found')
  const loc = await findTarget(state.page, { selector, text })
  await loc.click({ timeout: 10_000 })
  if (waitMs) await state.page.waitForTimeout(Math.min(10_000, Math.max(0, Number(waitMs) || 0)))
  const shot = await saveScreenshot(state.page)
  return pageSummary(state.page, state, shot)
}

export async function browserType({ sessionId, selector = '', text = '', pressEnter = false, waitMs = 1000 } = {}) {
  const state = sessions.get(sessionId)
  if (!state) throw new Error('browser session not found')
  if (!selector) throw new Error('selector is required')
  const loc = state.page.locator(selector).first()
  await loc.fill(String(text || ''), { timeout: 10_000 })
  if (pressEnter) await loc.press('Enter')
  if (waitMs) await state.page.waitForTimeout(Math.min(10_000, Math.max(0, Number(waitMs) || 0)))
  const shot = await saveScreenshot(state.page)
  return pageSummary(state.page, state, shot)
}

export async function browserClose({ sessionId } = {}) {
  const state = sessions.get(sessionId)
  if (!state) return { closed: false }
  sessions.delete(sessionId)
  await state.context.close().catch(() => {})
  return { closed: true, sessionId }
}

export async function browserHealth() {
  try {
    const b = await getBrowser()
    return { ok: Boolean(b), sessions: sessions.size }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
// ── Session cleanup (TTL 1h + max 10 sessions) ────────────────────────────
function cleanupOldSessions() {
  const now = Date.now()
  let evicted = 0
  for (const [id, state] of sessions) {
    if (!state.createdAt) { state.createdAt = now; continue }
    if (now - state.createdAt > SESSION_MAX_AGE_MS) {
      try { state.context?.close()?.catch(() => {}) } catch {}
      sessions.delete(id)
      evicted++
    }
  }
  // If still over limit, evict oldest
  if (sessions.size > SESSION_MAX_COUNT) {
    const sorted = [...sessions.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
    const toDelete = sorted.slice(0, sessions.size - SESSION_MAX_COUNT)
    for (const [id, state] of toDelete) {
      try { state.context?.close()?.catch(() => {}) } catch {}
      sessions.delete(id)
      evicted++
    }
  }
  if (evicted) console.warn(`[browserTools] cleaned up ${evicted} stale sessions`)
}
setInterval(cleanupOldSessions, 10 * 60 * 1000).unref?.()
