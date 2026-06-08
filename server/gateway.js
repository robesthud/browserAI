/**
 * gateway.js — единая точка маршрутизации «бесплатных» провайдеров.
 *
 * Клиенты (web UI, Telegram-бот, mobile WebView) используют один и тот же
 * виртуальный baseUrl/apiKey:
 *
 *     baseUrl = GATEWAY_BASE_URL ("https://browserai.local/free-gateway")
 *     apiKey  = GATEWAY_API_KEY  ("__gateway__")
 *
 * А сервер по выбранной модели роутит запрос либо в managed DeepSeek
 * (chat.deepseek.com + серверный bearer/cookies), либо в локальный
 * gemini-web-proxy.
 *
 * История: раньше адрес gemini-web-proxy и список моделей были захардкожены,
 * gemini.alive всегда был true, а неизвестная модель тихо роутилась
 * в DeepSeek. Здесь — починка всех этих недочётов:
 *
 *   ✓ адреса/токены читаются из ENV (GEMINI_WEB_PROXY_URL/_TOKEN);
 *   ✓ список DeepSeek-моделей берётся из refresher'а (getCachedModels);
 *   ✓ gemini.alive / deepseek.alive — реальный probe c 15-сек. кэшем;
 *   ✓ resolveGatewayModel() возвращает {ok,error,suggestion} вместо
 *     молчаливого fallback'а на чужого провайдера;
 *   ✓ isGatewayUrl() парсит через new URL() (toleрантно к слешам/регистру/query);
 *   ✓ isGatewayProvider() — строгая связка (baseUrl ∧ apiKey).
 */

import {
  isSessionValid as isDeepSeekValid,
  getCachedModels as getDeepSeekCachedModels,
} from './deepseekTokenRefresher.js'

// ── Public constants ───────────────────────────────────────────────────────
export const GATEWAY_BASE_URL = 'https://browserai.local/free-gateway'
export const GATEWAY_API_KEY  = '__gateway__'

// ── ENV-конфиг внешних провайдеров ─────────────────────────────────────────
const GEMINI_WEB_PROXY_URL =
  (process.env.GEMINI_WEB_PROXY_URL || 'http://host.docker.internal:8080/v1').replace(/\/$/, '')
const GEMINI_WEB_PROXY_TOKEN =
  process.env.GEMINI_WEB_PROXY_TOKEN || 'not-needed'

const DEEPSEEK_WEB_URL = 'https://chat.deepseek.com/api/v0'

// ── Каталог моделей ────────────────────────────────────────────────────────
// Gemini Web Proxy умеет столько, сколько Google отдаёт; список синхронизирован
// с GEMINI_WEB_PROXY_MODELS в index.js.
const GEMINI_MODELS = [
  { id: 'gemini-2.5-pro',   provider: 'gemini', label: 'Gemini 2.5 Pro',   capabilities: ['text', 'imageInput', 'imageOutput', 'reasoning'] },
  { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', capabilities: ['text', 'imageInput', 'imageOutput', 'fast'] },
  { id: 'gemini-2.0-flash', provider: 'gemini', label: 'Gemini 2.0 Flash', capabilities: ['text', 'imageInput', 'imageOutput', 'fast'] },
]

// Фолбэк-каталог DeepSeek (использует ровно тот же FALLBACK, что
// deepseekTokenRefresher.fetchModels — на случай если refresher ещё не
// прогрелся).
const DEEPSEEK_FALLBACK = [
  { id: 'deepseek_chat',      label: 'DeepSeek V3 (Chat)' },
  { id: 'deepseek_reasoner',  label: 'DeepSeek R1 (Reasoner)' },
]

function deepseekModels() {
  const cached = getDeepSeekCachedModels?.() || []
  const list = (Array.isArray(cached) && cached.length) ? cached : DEEPSEEK_FALLBACK
  return list.map((m) => ({
    id: m.id,
    provider: 'deepseek',
    label: m.name || m.label || m.id,
    capabilities: m.id?.includes('reasoner')
      ? ['text', 'reasoning', 'code']
      : ['text', 'chat'],
  }))
}

/** Текущий каталог моделей gateway (DeepSeek сначала, затем Gemini). */
export function getGatewayCatalog() {
  return [...deepseekModels(), ...GEMINI_MODELS]
}

/** Совместимость со старым импортом: массив { id, provider, label, capabilities }. */
export const GATEWAY_MODELS = getGatewayCatalog()

export function getGatewayModels() {
  return getGatewayCatalog().map((m) => m.id)
}

// ── URL / provider matchers ────────────────────────────────────────────────
/**
 * Совпадает ли baseUrl с виртуальным gateway-URL. Тоlerантно к слешам,
 * регистру, query-string.
 */
export function isGatewayUrl(baseUrl = '') {
  const raw = String(baseUrl || '').trim()
  if (!raw) return false
  let u
  try { u = new URL(raw) } catch { return false }
  try {
    const ref = new URL(GATEWAY_BASE_URL)
    const sameHost = u.hostname.toLowerCase() === ref.hostname.toLowerCase()
    const norm = (p) => String(p || '').toLowerCase().replace(/\/+$/, '')
    return sameHost && norm(u.pathname) === norm(ref.pathname)
  } catch {
    return false
  }
}

/** Строгая проверка: запрос точно идёт через gateway (URL И apiKey). */
export function isGatewayProvider(baseUrl = '', apiKey = '') {
  return isGatewayUrl(baseUrl) && String(apiKey || '') === GATEWAY_API_KEY
}

// ── Health / status с кэшем ────────────────────────────────────────────────
const HEALTH_TTL_MS = 15_000
let healthCache = { at: 0, value: null, inflight: null }

async function probeGeminiProxy() {
  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort('timeout'), 3000)
    const headers = { Accept: 'application/json' }
    if (GEMINI_WEB_PROXY_TOKEN && GEMINI_WEB_PROXY_TOKEN !== 'not-needed') {
      headers.Authorization = `Bearer ${GEMINI_WEB_PROXY_TOKEN}`
    }
    const r = await fetch(`${GEMINI_WEB_PROXY_URL}/models`, { method: 'GET', headers, signal: ctrl.signal })
    clearTimeout(timer)
    return {
      alive: r.ok,
      status: r.status,
      latencyMs: Date.now() - t0,
      error: r.ok ? '' : `HTTP ${r.status}`,
    }
  } catch (e) {
    return {
      alive: false,
      status: 0,
      latencyMs: Date.now() - t0,
      error: String(e?.message || e || 'fetch failed'),
    }
  }
}

function deepseekHealth() {
  const alive = Boolean(isDeepSeekValid?.())
  return { alive, status: alive ? 200 : 503, latencyMs: 0, error: alive ? '' : 'session not configured / expired' }
}

/**
 * Полный статус gateway с реальным end-to-end пингом (с TTL-кэшем).
 * Принимает `{ force: true }` чтобы сбросить кэш (например, для
 * /api/gateway/health admin-эндпоинта).
 */
export async function getGatewayStatus({ force = false } = {}) {
  const now = Date.now()
  if (!force && healthCache.value && now - healthCache.at < HEALTH_TTL_MS) {
    return healthCache.value
  }
  // Coalesce concurrent callers.
  if (healthCache.inflight) return healthCache.inflight
  healthCache.inflight = (async () => {
    const [gem, ds] = await Promise.all([probeGeminiProxy(), Promise.resolve(deepseekHealth())])
    const catalog = getGatewayCatalog()
    const value = {
      enabled: true,
      checkedAt: new Date().toISOString(),
      deepseek: {
        alive: ds.alive,
        status: ds.status,
        latencyMs: ds.latencyMs,
        error: ds.error,
        models: catalog.filter((m) => m.provider === 'deepseek').map((m) => m.id),
      },
      gemini: {
        alive: gem.alive,
        status: gem.status,
        latencyMs: gem.latencyMs,
        error: gem.error,
        endpoint: GEMINI_WEB_PROXY_URL,
        models: GEMINI_MODELS.map((m) => m.id),
      },
      models: catalog,
    }
    healthCache = { at: Date.now(), value, inflight: null }
    return value
  })()
  try {
    return await healthCache.inflight
  } finally {
    healthCache.inflight = null
  }
}

// Синхронный «лёгкий» снимок (без сетевых пингов) — для совместимости со
// старым кодом, который вызывал getGatewayStatus() как sync-функцию.
export function getGatewayStatusSync() {
  const cached = healthCache.value
  if (cached) return cached
  const catalog = getGatewayCatalog()
  return {
    enabled: true,
    checkedAt: null,
    deepseek: { ...deepseekHealth(), models: catalog.filter((m) => m.provider === 'deepseek').map((m) => m.id) },
    gemini:   { alive: null, status: 0, latencyMs: 0, error: 'not probed yet', endpoint: GEMINI_WEB_PROXY_URL, models: GEMINI_MODELS.map((m) => m.id) },
    models: catalog,
  }
}

// ── Routing ────────────────────────────────────────────────────────────────
/**
 * Преобразовать виртуальную модель gateway в реальный (baseUrl, apiKey,
 * extraHeaders, model). Возвращает:
 *
 *   {
 *     ok: true,
 *     provider, baseUrl, apiKey, authType, model, extraHeaders,
 *   }
 *
 * либо при ошибке:
 *
 *   {
 *     ok: false,
 *     error: 'unknown_model' | 'deepseek_unavailable',
 *     message: '...',
 *     suggestion: 'gemini-2.5-flash',
 *   }
 *
 * Никакого «молчаливого» fallback на другого провайдера — это слишком
 * легко скрывает баги.
 */
export function resolveGatewayModel(model = '') {
  const id = String(model || '').trim()
  const catalog = getGatewayCatalog()
  const found = catalog.find((m) => m.id === id)

  if (!found) {
    const suggestion =
      catalog.find((m) => m.provider === 'gemini')?.id
      || catalog[0]?.id
      || 'gemini-2.5-flash'
    return {
      ok: false,
      error: 'unknown_model',
      message: `Unknown gateway model "${id}". Available: ${catalog.map((m) => m.id).join(', ')}`,
      suggestion,
    }
  }

  if (found.provider === 'deepseek') {
    if (!isDeepSeekValid?.()) {
      const suggestion = GEMINI_MODELS[1]?.id || GEMINI_MODELS[0]?.id
      return {
        ok: false,
        error: 'deepseek_unavailable',
        message: 'DeepSeek managed session is not configured or expired. Ask an admin to provide a userToken via /admin/deepseek.',
        suggestion,
      }
    }
    return {
      ok: true,
      provider: 'deepseek',
      baseUrl: DEEPSEEK_WEB_URL,
      apiKey: '__managed__',
      authType: 'bearer',
      model: found.id,
      extraHeaders: {
        Referer: 'https://chat.deepseek.com/',
        Origin:  'https://chat.deepseek.com',
      },
    }
  }

  // Gemini Web Proxy.
  const extraHeaders = {}
  if (GEMINI_WEB_PROXY_TOKEN && GEMINI_WEB_PROXY_TOKEN !== 'not-needed') {
    extraHeaders['X-Proxy-Token'] = GEMINI_WEB_PROXY_TOKEN
  }
  return {
    ok: true,
    provider: 'gemini',
    baseUrl: GEMINI_WEB_PROXY_URL,
    apiKey: GEMINI_WEB_PROXY_TOKEN || 'not-needed',
    authType: 'bearer',
    model: found.id,
    extraHeaders,
  }
}
