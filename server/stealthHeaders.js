/**
 * stealthHeaders.js — набор браузерных заголовков для имитации реального браузера
 * при запросах к сессионным токенам (DeepSeek Web, Grok Web, Claude Web и т.д.)
 *
 * Без этих заголовков Node.js fetch легко детектируется как бот:
 * - нет User-Agent → Cloudflare блокирует
 * - нет Origin/Referer → сайт видит внешний клиент
 * - нет Accept-* → аномальный HTTP-профиль
 */

// Реалистичные User-Agent строки (актуальные браузеры)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
]

// Возвращает случайный User-Agent (чтобы не было одного fingerprint)
export function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

/**
 * Базовые браузерные заголовки — общие для всех сессионных запросов.
 * Добавляем их ко всем запросам через сессионный токен.
 */
export function baseBrowserHeaders(origin = '') {
  const ua = randomUserAgent()
  return {
    'User-Agent': ua,
    'Accept': 'application/json, text/event-stream, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    ...(origin ? { 'Origin': origin, 'Referer': origin + '/' } : {}),
    'Sec-Fetch-Site': origin ? 'same-origin' : 'cross-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Connection': 'keep-alive',
  }
}

/**
 * Профили конкретных сайтов — точные заголовки как у реального браузера на этом сайте.
 * Определяем по hostname из baseUrl.
 */
const SITE_PROFILES = {
  'chat.deepseek.com': {
    origin: 'https://chat.deepseek.com',
    extra: {
      'x-app-version': '20241129',
      'x-client-locale': 'ru_RU',
    },
    // DeepSeek ожидает эти значения в body
    bodyDefaults: {
      temperature: 1.0,
      stream: true,
    },
    // Не нужно проверять через /models — сразу probe chat
    skipModelsProbe: true,
  },
  'grok.com': {
    origin: 'https://grok.com',
    extra: {
      'x-requested-with': 'XMLHttpRequest',
    },
    bodyDefaults: {
      temperature: 0.7,
      stream: true,
    },
    skipModelsProbe: true,
  },
  'claude.ai': {
    origin: 'https://claude.ai',
    extra: {
      'anthropic-client-version': '0.10.0',
    },
    bodyDefaults: {
      stream: true,
    },
    skipModelsProbe: true,
  },
  // Дефолтный профиль для неизвестных сайтов
  _default: {
    origin: '',
    extra: {},
    bodyDefaults: {},
    skipModelsProbe: true,
  },
}

/**
 * Возвращает профиль сайта по baseUrl.
 * @param {string} baseUrl
 * @returns {{ origin, extra, bodyDefaults, skipModelsProbe }}
 */
export function getSiteProfile(baseUrl) {
  let hostname = ''
  try {
    hostname = new URL(baseUrl).hostname.replace(/^www\./, '')
  } catch {
    return SITE_PROFILES._default
  }

  // Точное совпадение
  if (SITE_PROFILES[hostname]) return SITE_PROFILES[hostname]

  // Совпадение по суффиксу домена (deepseek.com → chat.deepseek.com)
  for (const key of Object.keys(SITE_PROFILES)) {
    if (key !== '_default' && hostname.endsWith(key)) return SITE_PROFILES[key]
  }

  return SITE_PROFILES._default
}

/**
 * Собирает полный набор заголовков для сессионного запроса:
 * - базовые браузерные
 * - специфичные для сайта
 * - заголовок авторизации пользователя
 * - кастомные заголовки пользователя (extraHeaders)
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.apiKey
 * @param {string} params.authType   'bearer' | 'cookie' | 'custom'
 * @param {string} params.authHeader  название заголовка для custom
 * @param {object} params.extraHeaders  доп. заголовки от пользователя
 */
export function buildSessionHeaders({
  baseUrl,
  apiKey,
  authType = 'bearer',
  authHeader = '',
  extraHeaders = {},
}) {
  const profile = getSiteProfile(baseUrl)
  const base = baseBrowserHeaders(profile.origin)

  // Заголовок авторизации
  let authH = {}
  const key = String(apiKey || '').trim()
  if (key) {
    switch (authType) {
      case 'cookie':
        authH = { 'Cookie': key }
        break
      case 'custom':
        if (authHeader.trim()) {
          authH = { [authHeader.trim()]: key }
        } else {
          authH = { 'Authorization': key }
        }
        break
      case 'bearer':
      default:
        // Если токен уже начинается с 'Bearer ' — не дублируем
        authH = { 'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}` }
        break
    }
  }

  // Итоговые заголовки (приоритет: extraHeaders > auth > site-specific > base)
  return {
    'Content-Type': 'application/json',
    ...base,
    ...profile.extra,
    ...authH,
    ...sanitizeExtraHeaders(extraHeaders),
  }
}

/**
 * Очищает пользовательские extraHeaders:
 * - убирает опасные (Host, Content-Length, Transfer-Encoding)
 * - ограничивает длину
 */
export function sanitizeExtraHeaders(raw = {}) {
  if (!raw || typeof raw !== 'object') return {}
  const FORBIDDEN = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])
  const result = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim()
    if (!key || key.length > 100) continue
    if (FORBIDDEN.has(key.toLowerCase())) continue
    const val = String(v || '').trim()
    if (val.length > 2000) continue
    result[key] = val
  }
  return result
}

/**
 * Применяет дефолты из профиля сайта к body запроса.
 * Пользовательские значения имеют приоритет над дефолтами сайта.
 */
export function applyBodyDefaults(body = {}, baseUrl = '') {
  const profile = getSiteProfile(baseUrl)
  return {
    ...profile.bodyDefaults,
    ...body,
  }
}
