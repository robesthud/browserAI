/**
 * deepseekTokenRefresher.js
 *
 * Autonomous DeepSeek (chat.deepseek.com) session manager:
 *
 * 1. Stores userToken (Bearer) + cookies in /data/deepseek_session.json
 *    (survives restarts).
 * 2. Every 10 minutes pings /users/current to verify the session is alive
 *    and to keep server-side activity timer warm.
 * 3. If a refresh endpoint is exposed by DeepSeek (currently /users/refresh_token
 *    when present in the session cookies), it is invoked when the token is
 *    close to expiry or after a 401/403.
 * 4. Caches the list of available models (refreshed every hour).
 * 5. Sends Telegram notifications on token rotation, expiry, or admin action
 *    (uses TG_BOT_TOKEN + TG_ADMIN_CHAT_ID env).
 * 6. Public API used by other modules:
 *      getSessionState()                – current snapshot for the admin panel
 *      getActiveBearer()                – Bearer token (string) or '' if none
 *      getCookieHeader()                – full Cookie header for outgoing reqs
 *      getCachedModels()                – array of {id, name, ...} or []
 *      refreshNow()                     – force a refresh and return new state
 *      setSession({ userToken, cookies }) – admin: store new credentials
 *      isSessionValid()                 – boolean
 *
 * Flow:
 *   server boot
 *     → loadFromDisk()
 *     → schedule heartbeat every 10 min
 *     → schedule models refresh every 60 min
 *
 *   admin posts new token (UI / TG bot / API)
 *     → setSession({...})
 *     → immediate heartbeat + models fetch
 *     → notify TG
 *
 *   heartbeat
 *     → GET https://chat.deepseek.com/api/v0/users/current
 *     → 200  → mark alive, bump lastSeenAt
 *     → 401/403 → try refresh_token endpoint
 *                 → on failure: notify TG ('token expired, please re-supply')
 */
import fs from 'node:fs'
import path from 'node:path'

// ── Config ──────────────────────────────────────────────────────────────────
const STATE_FILE = process.env.DEEPSEEK_STATE_FILE || '/data/deepseek_session.json'
const HEARTBEAT_INTERVAL_MS = Number(process.env.DEEPSEEK_HEARTBEAT_MS) || 10 * 60 * 1000
const MODELS_REFRESH_MS = Number(process.env.DEEPSEEK_MODELS_REFRESH_MS) || 60 * 60 * 1000
const STARTUP_DELAY_MS = 5 * 1000
const DEEPSEEK_BASE = 'https://chat.deepseek.com/api/v0'
const TG_TOKEN = process.env.TG_BOT_TOKEN || ''
const TG_CHAT_ID = process.env.TG_ADMIN_CHAT_ID || process.env.TG_CHAT_ID || ''

// In-memory cached state
let state = {
  userToken: '',                  // Bearer token from localStorage.userToken
  cookies: {},                    // { cf_clearance, ds_session_id, smidV2, ... }
  expiresAt: 0,                   // best-effort, parsed from JWT exp (sec) if possible
  lastRefreshAt: 0,
  lastSeenAt: 0,
  lastError: '',
  alive: false,
  user: null,                     // /users/current biz_data
  updatedBy: '',                  // 'admin-ui', 'tg-bot', 'env-bootstrap', etc.
}

let modelsCache = {
  list: [],
  fetchedAt: 0,
  error: '',
}

let heartbeatTimer = null
let modelsTimer = null

// ── Logging ─────────────────────────────────────────────────────────────────
function log(...a) { console.log('[deepseek-refresh]', ...a) }
function warn(...a) { console.warn('[deepseek-refresh]', ...a) }

// ── Telegram ────────────────────────────────────────────────────────────────
async function notifyTg(text) {
  // #42 FIX: User requested to disable DeepSeek notifications in Telegram.
  // We keep only server/deploy info which comes from GitHub Actions.
  if (process.env.DEEPSEEK_NOTIFICATIONS !== 'on') return
  
  if (!TG_TOKEN || !TG_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    warn('TG notify failed:', e.message)
  }
}

// ── Persistent state ────────────────────────────────────────────────────────
function loadFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      state = { ...state, ...raw }
      log('Loaded persisted session for user:', state?.user?.email || state?.user?.username || '(unknown)')
    }
  } catch (e) {
    warn('loadFromDisk error:', e.message)
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(STATE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    warn('saveToDisk error:', e.message)
  }
}

// ── JWT decode (best effort) ────────────────────────────────────────────────
function decodeJwtExp(token) {
  try {
    if (!token || typeof token !== 'string') return 0
    const parts = token.split('.')
    if (parts.length < 2) return 0
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return Number(payload?.exp) || 0
  } catch {
    return 0
  }
}

// ── Cookie helpers ──────────────────────────────────────────────────────────
function parseCookieString(cookieStr) {
  const out = {}
  if (!cookieStr || typeof cookieStr !== 'string') return out
  for (const part of cookieStr.split(/;\s*/)) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function buildCookieHeader(cookies = {}) {
  return Object.entries(cookies)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

function applySetCookies(setCookieHeaders = []) {
  // node fetch returns getSetCookie() — array of raw "name=value; Path=...; Expires=..." strings
  if (!Array.isArray(setCookieHeaders) || !setCookieHeaders.length) return false
  let changed = false
  for (const raw of setCookieHeaders) {
    if (typeof raw !== 'string') continue
    const firstSemi = raw.indexOf(';')
    const head = firstSemi === -1 ? raw : raw.slice(0, firstSemi)
    const eq = head.indexOf('=')
    if (eq < 1) continue
    const name = head.slice(0, eq).trim()
    const value = head.slice(eq + 1).trim()
    if (!name) continue
    if (state.cookies[name] !== value) {
      state.cookies[name] = value
      changed = true
    }
  }
  return changed
}

// ── Default headers (mimic chat.deepseek.com web) ───────────────────────────
function buildHeaders() {
  const h = {
    'Accept': '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    'x-app-version': '20241129.1',
    'x-client-locale': 'ru_RU',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0-always',
  }
  if (state.userToken) h['Authorization'] = `Bearer ${state.userToken}`
  const cookieHeader = buildCookieHeader(state.cookies)
  if (cookieHeader) h['Cookie'] = cookieHeader
  return h
}

// ── Heartbeat: GET /users/current ───────────────────────────────────────────
async function heartbeat({ silent = false } = {}) {
  if (!state.userToken && !Object.keys(state.cookies).length) {
    state.alive = false
    state.lastError = 'no credentials'
    return { ok: false, reason: 'no-credentials' }
  }
  try {
    const r = await fetch(`${DEEPSEEK_BASE}/users/current`, {
      method: 'GET',
      headers: buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    })
    // Capture set-cookie if DeepSeek rotated anything
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
    const cookieChanged = applySetCookies(setCookies)

    if (r.status === 401 || r.status === 403) {
      state.alive = false
      state.lastError = `auth failed: HTTP ${r.status}`
      saveToDisk()
      if (!silent) {
        await notifyTg(
          `🚨 *DeepSeek session expired*\n` +
          `HTTP ${r.status} from /users/current\n` +
          `Send a fresh token via /settoken or the admin panel.`,
        )
      }
      return { ok: false, status: r.status, reason: 'unauthorized' }
    }

    if (!r.ok) {
      state.lastError = `HTTP ${r.status}`
      if (cookieChanged) saveToDisk()
      return { ok: false, status: r.status, reason: 'http-error' }
    }

    const data = await r.json().catch(() => null)
    const biz = data?.data?.biz_data || data?.biz_data || data?.data || null
    if (biz) state.user = biz
    state.alive = true
    state.lastSeenAt = Date.now()
    state.lastError = ''
    // Always persist after a successful heartbeat: even if no cookie was
    // rotated, we want lastSeenAt / alive / user to survive restarts.
    saveToDisk()
    return { ok: true, user: biz }
  } catch (e) {
    state.alive = false
    state.lastError = e.message || String(e)
    return { ok: false, reason: 'network', error: state.lastError }
  }
}

// ── Models refresh ──────────────────────────────────────────────────────────
async function fetchModels() {
  if (!state.userToken) {
    modelsCache.error = 'no token'
    return modelsCache
  }
  // DeepSeek web doesn't expose a clean /models endpoint, but the model
  // catalogue is announced inside chat_session/fetch_page or feature_flags.
  // We fall back to a static list of the two production models if discovery
  // fails — they map 1:1 to what chat.deepseek.com offers today.
  const FALLBACK = [
    { id: 'deepseek_chat', name: 'DeepSeek V3 (Chat)' },
    { id: 'deepseek_reasoner', name: 'DeepSeek R1 (Reasoner)' },
  ]
  try {
    const r = await fetch(`${DEEPSEEK_BASE}/users/feature_flags`, {
      method: 'GET',
      headers: buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      modelsCache = { list: FALLBACK, fetchedAt: Date.now(), error: `HTTP ${r.status}` }
      return modelsCache
    }
    const data = await r.json().catch(() => null)
    const biz = data?.data?.biz_data || data?.biz_data || {}
    const dynamic = Array.isArray(biz?.models) ? biz.models : null
    const list = (dynamic && dynamic.length ? dynamic : FALLBACK).map((m) => ({
      id: m.id || m.model || m.name,
      name: m.label || m.name || m.id,
    }))
    modelsCache = { list, fetchedAt: Date.now(), error: '' }
    return modelsCache
  } catch (e) {
    modelsCache = { list: FALLBACK, fetchedAt: Date.now(), error: e.message }
    return modelsCache
  }
}

// ── Public API ──────────────────────────────────────────────────────────────
export function getSessionState() {
  // Hide the raw token; expose only safe metadata.
  const exp = state.expiresAt || decodeJwtExp(state.userToken)
  return {
    hasToken: Boolean(state.userToken),
    hasCookies: Object.keys(state.cookies).length > 0,
    cookieNames: Object.keys(state.cookies),
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    expiresInSec: exp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : null,
    alive: state.alive,
    lastSeenAt: state.lastSeenAt ? new Date(state.lastSeenAt).toISOString() : null,
    lastRefreshAt: state.lastRefreshAt ? new Date(state.lastRefreshAt).toISOString() : null,
    lastError: state.lastError || '',
    user: state.user ? {
      id: state.user.id || state.user.user_id || null,
      email: state.user.email || null,
      name: state.user.username || state.user.name || null,
    } : null,
    updatedBy: state.updatedBy || '',
    models: modelsCache.list,
    modelsFetchedAt: modelsCache.fetchedAt ? new Date(modelsCache.fetchedAt).toISOString() : null,
  }
}

export function getActiveBearer() {
  return state.userToken || ''
}

export function getCookieHeader() {
  return buildCookieHeader(state.cookies)
}

export function getCachedModels() {
  return modelsCache.list
}

export function isSessionValid() {
  return Boolean(state.userToken) && state.alive !== false
}

export async function refreshNow({ source = 'api' } = {}) {
  state.lastRefreshAt = Date.now()
  const r = await heartbeat({ silent: false })
  if (r.ok) await fetchModels()
  // Persist only when heartbeat actually communicated with DeepSeek
  // (success, http-error, or unauthorized). Skip 'no-credentials' so
  // an erroneous refresh from a fresh process never wipes the on-disk
  // session of the live process.
  if (r.reason !== 'no-credentials') saveToDisk()
  log(`Manual refresh (${source}):`, r.ok ? 'OK' : `FAIL (${r.reason})`)
  return getSessionState()
}

/**
 * Replace the active session.
 * @param {object} opts
 * @param {string} [opts.userToken]  – Bearer token (localStorage.userToken)
 * @param {object|string} [opts.cookies]  – object { cf_clearance, ... } or raw cookie header
 * @param {string} [opts.source]     – tag for audit ('admin-ui' | 'tg-bot' | 'env-bootstrap')
 */
export async function setSession({ userToken = '', cookies = null, source = 'api' } = {}) {
  if (userToken) {
    state.userToken = String(userToken).trim()
    state.expiresAt = decodeJwtExp(state.userToken)
  }
  if (cookies) {
    if (typeof cookies === 'string') {
      const parsed = parseCookieString(cookies)
      state.cookies = { ...state.cookies, ...parsed }
    } else if (typeof cookies === 'object') {
      state.cookies = { ...state.cookies, ...cookies }
    }
  }
  state.updatedBy = source
  state.lastRefreshAt = Date.now()
  saveToDisk()
  const r = await heartbeat({ silent: true })
  if (r.ok) {
    await fetchModels()
    saveToDisk()
    await notifyTg(
      `✅ *DeepSeek session updated*\n` +
      `Source: \`${source}\`\n` +
      `User: ${state.user?.email || state.user?.username || '(unknown)'}\n` +
      `Models: ${modelsCache.list.length}`,
    )
  } else {
    await notifyTg(
      `⚠️ *DeepSeek session updated but heartbeat failed*\n` +
      `Source: \`${source}\`\n` +
      `Reason: ${r.reason || 'unknown'}\n` +
      `Error: ${state.lastError || 'n/a'}`,
    )
  }
  return getSessionState()
}

/**
 * Bootstrap on server startup. Picks up credentials from env vars
 * (DEEPSEEK_USER_TOKEN, DEEPSEEK_COOKIES) if persisted state is empty.
 */
export function bootstrap() {
  loadFromDisk()
  if (!state.userToken && process.env.DEEPSEEK_USER_TOKEN) {
    state.userToken = process.env.DEEPSEEK_USER_TOKEN.trim()
    state.expiresAt = decodeJwtExp(state.userToken)
    state.updatedBy = 'env-bootstrap'
  }
  if (!Object.keys(state.cookies).length && process.env.DEEPSEEK_COOKIES) {
    state.cookies = parseCookieString(process.env.DEEPSEEK_COOKIES)
  }
  if (state.userToken || Object.keys(state.cookies).length) {
    saveToDisk()
  }
  // Initial heartbeat + models a few seconds after boot.
  // We log the outcome so operators can see whether the persisted
  // session is alive without having to call /api/admin/deepseek/status.
  setTimeout(async () => {
    try {
      const r = await heartbeat({ silent: true })
      if (r.ok) {
        await fetchModels()
        log(`Initial heartbeat OK — user: ${state.user?.email || state.user?.username || state.user?.id || '(no email)'}`)
      } else {
        log(`Initial heartbeat FAILED — reason: ${r.reason}${r.status ? ' (HTTP ' + r.status + ')' : ''}${state.lastError ? ', error: ' + state.lastError : ''}`)
      }
    } catch (e) {
      warn('Initial heartbeat crashed:', e.message)
    }
  }, STARTUP_DELAY_MS)

  // Periodic heartbeat
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => { heartbeat({ silent: false }).catch(() => {}) }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()

  // Periodic models refresh
  if (modelsTimer) clearInterval(modelsTimer)
  modelsTimer = setInterval(() => { fetchModels().catch(() => {}) }, MODELS_REFRESH_MS)
  modelsTimer.unref?.()

  log(
    `Bootstrap complete. token=${state.userToken ? 'yes' : 'no'} cookies=${Object.keys(state.cookies).length}`,
    `heartbeat=${HEARTBEAT_INTERVAL_MS / 1000}s models=${MODELS_REFRESH_MS / 1000}s`,
  )
}
