/**
 * stealthHeaders.js — браузерная маскировка для сессионных запросов.
 *
 * Без этих заголовков Node.js fetch детектируется как бот:
 *  - нет User-Agent → Cloudflare/WAF блокирует
 *  - нет Origin/Referer → сайт видит внешний клиент
 *  - нет Accept-* → аномальный HTTP-профиль
 *  - нет x-app-version → «чужой» клиент для DeepSeek/Grok
 */

// ─── User-Agent pool ────────────────────────────────────────────────────────
// Актуальные Chrome 131 / Firefox 132 / Safari 17 на Win/Mac/Linux
const USER_AGENTS = [
  // Chrome 131 Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Chrome 131 Mac
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Chrome 130 Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  // Chrome 131 Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Safari 17.6 Mac
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  // Firefox 132 Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  // Chrome 131 Android (для мобильных сессий)
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
]

// Кешируем UA на весь процесс — один UA как у настоящего браузера
// Меняется только при рестарте сервера (приемлемо для anti-bot эвристик)
const _PROCESS_UA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

/** Случайный User-Agent из пула (стабильный на процесс) */
export function randomUserAgent() {
  return _PROCESS_UA
}

// ─── Базовые браузерные заголовки ───────────────────────────────────────────
export function baseBrowserHeaders(origin = '') {
  return {
    'User-Agent':      randomUserAgent(),
    'Accept':          'application/json, text/event-stream, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    ...(origin ? { 'Origin': origin, 'Referer': origin + '/' } : {}),
    'Sec-Fetch-Site':  origin ? 'same-origin' : 'cross-site',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Dest':  'empty',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
  }
}

// ─── Профили сайтов ──────────────────────────────────────────────────────────
// Каждый профиль описывает:
//  origin       — домен, с которого браузер делает запрос
//  extra        — кастомные заголовки конкретного сайта
//  bodyDefaults — дефолты тела запроса (temperature, stream)
//  isBearerSession — это сессионный bearer-токен (не API-ключ)
//                    → validate должен идти напрямую в /chat, минуя /models
const SITE_PROFILES = {
  // ── Zhipu AI (BigModel) ──────────────────────────────────────────────────
  'bigmodel.cn': {
    origin: '',
    extra: {},
    bodyDefaults: { stream: true, temperature: 0.7 },
    // ZhipuAI rejects temperature outside [0,1] with HTTP 400 code 1210
    // («temperature参数非法») — the OpenAI-style 0..2 range is NOT accepted.
    temperatureMax: 1,
    isBearerSession: false,
    skipModelsProbe: false,
    modelCandidates: [], // GLM removed - does not support Tool Calling in Agent Mode
  },


  // ── DeepSeek Chat ──────────────────────────────────────────────────────────
  'chat.deepseek.com': {
    origin: 'https://chat.deepseek.com',
    extra: {
      'x-app-version':    '20241129',
      'x-client-locale':  'ru_RU',
      'x-requested-with': 'XMLHttpRequest',
    },
    bodyDefaults:     { temperature: 1.0, stream: true },
    isBearerSession:  true,
    skipModelsProbe:  true,
    // DeepSeek Chat использует /chat/completion (без 's') вместо стандартного /chat/completions
    chatEndpoint:     '/chat/completion',
    // Модели-кандидаты для перебора при validate
    modelCandidates:  ['deepseek_chat', 'deepseek-chat', 'DeepThink', 'deepseek-reasoner'],
  },

  // ── Grok (xAI) ─────────────────────────────────────────────────────────────
  'grok.com': {
    origin: 'https://grok.com',
    extra: {
      'x-requested-with': 'XMLHttpRequest',
    },
    bodyDefaults:     { temperature: 0.7, stream: true },
    isBearerSession:  true,
    skipModelsProbe:  true,
    modelCandidates:  ['grok-3', 'grok-2', 'grok-3-mini', 'grok-2-mini'],
  },

  // ── Claude (Anthropic) ─────────────────────────────────────────────────────
  'claude.ai': {
    origin: 'https://claude.ai',
    extra: {
      'anthropic-client-version': '0.10.0',
      'anthropic-client-platform': 'web',
    },
    bodyDefaults:     { stream: true },
    isBearerSession:  false,
    skipModelsProbe:  true,
    modelCandidates:  ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'claude-3-opus-20240229'],
  },

  // ── Gemini AI (Google AI Studio / gemini.google.com) ──────────────────────
  'gemini.google.com': {
    origin: 'https://gemini.google.com',
    extra: {
      'x-goog-api-client': 'gl-js/ fire/0.0.0',
      'x-user-agent':      'grpc-web-javascript/0.1',
    },
    bodyDefaults:     { stream: true },
    isBearerSession:  false,  // Cookie-based
    skipModelsProbe:  true,
  },

  // ── Google AI Studio ───────────────────────────────────────────────────────
  'aistudio.google.com': {
    origin: 'https://aistudio.google.com',
    extra: {
      'x-goog-api-client': 'gl-js/ fire/0.0.0',
    },
    bodyDefaults:     { stream: true },
    isBearerSession:  false,
    skipModelsProbe:  true,
  },

  // ── ChatGPT Web (openai.com) ───────────────────────────────────────────────
  'chatgpt.com': {
    origin: 'https://chatgpt.com',
    extra: {
      'openai-sentinel-chat-requirements-token': '',
      'openai-conversation-id': '',
    },
    bodyDefaults:     { stream: true },
    isBearerSession:  true,
    skipModelsProbe:  true,
    modelCandidates:  ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo', 'o3-mini'],
  },

  // ── Mistral AI ─────────────────────────────────────────────────────────────
  'chat.mistral.ai': {
    origin: 'https://chat.mistral.ai',
    extra: {
      'x-requested-with': 'XMLHttpRequest',
    },
    bodyDefaults:     { stream: true },
    isBearerSession:  true,
    skipModelsProbe:  true,
    modelCandidates:  ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  },

  // ── Qwen (Alibaba) ─────────────────────────────────────────────────────────
  'tongyi.aliyun.com': {
    origin: 'https://tongyi.aliyun.com',
    extra: {
      'bx-v': '2.2.3',
    },
    bodyDefaults:     { stream: true },
    isBearerSession:  false,
    skipModelsProbe:  true,
  },

  // ── Perplexity AI ──────────────────────────────────────────────────────────
  'www.perplexity.ai': {
    origin: 'https://www.perplexity.ai',
    extra: {
      'x-requested-with': 'XMLHttpRequest',
    },
    bodyDefaults:     { stream: true },
    isBearerSession:  true,
    skipModelsProbe:  true,
  },

  // ── Дефолтный профиль ─────────────────────────────────────────────────────
  _default: {
    origin:          '',
    extra:           {},
    bodyDefaults:    { stream: true },
    isBearerSession: false,
    skipModelsProbe: true,
  },
}

/** Возвращает профиль сайта по baseUrl */
export function getSiteProfile(baseUrl) {
  let hostname
  try {
    hostname = new URL(baseUrl).hostname.replace(/^www\./, '')
  } catch {
    return SITE_PROFILES._default
  }

  if (SITE_PROFILES[hostname]) return SITE_PROFILES[hostname]

  // Совпадение по суффиксу (api.deepseek.com → не сессионный, chat.deepseek.com → да)
  for (const key of Object.keys(SITE_PROFILES)) {
    if (key !== '_default' && (hostname === key || hostname.endsWith('.' + key))) {
      return SITE_PROFILES[key]
    }
  }

  return SITE_PROFILES._default
}

/**
 * Проверяет, является ли baseUrl сессионным (не API-ключ, а веб-токен).
 * Используется в validate чтобы пропустить probe /models.
 */
export function isSessionUrl(baseUrl) {
  return getSiteProfile(baseUrl).skipModelsProbe === true
}

/**
 * Собирает полный набор заголовков для запроса:
 * base → site-extra → auth → extraHeaders пользователя
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
      case 'custom': {
        const customHeader = String(authHeader || '').trim()
        // Блокируем опасные заголовки — та же защита что в sanitizeExtraHeaders
        const FORBIDDEN_CUSTOM = new Set([
          'host', 'content-length', 'transfer-encoding', 'connection',
          'upgrade', 'http2-settings', 'x-forwarded-for', 'x-real-ip',
          'x-forwarded-host', 'x-forwarded-proto',
        ])
        const safeHeader = (customHeader && !FORBIDDEN_CUSTOM.has(customHeader.toLowerCase()))
          ? customHeader
          : 'Authorization'
        authH = { [safeHeader]: key }
        break
      }
      case 'bearer':
      default:
        // Не дублируем «Bearer » если токен уже начинается с него
        authH = { 'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}` }
        break
    }
  }

  return {
    'Content-Type': 'application/json',
    ...base,
    ...profile.extra,
    ...authH,
    ...sanitizeExtraHeaders(extraHeaders),
  }
}

/**
 * Фильтрует пользовательские extraHeaders:
 * удаляет технически опасные, ограничивает длину.
 */
export function sanitizeExtraHeaders(raw = {}) {
  if (!raw || typeof raw !== 'object') return {}
  const FORBIDDEN = new Set([
    'host', 'content-length', 'transfer-encoding',
    'connection', 'upgrade', 'http2-settings',
    'content-type', // устанавливается явно в buildSessionHeaders
  ])
  const result = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim()
    if (!key || key.length > 100) continue
    if (FORBIDDEN.has(key.toLowerCase())) continue
    const val = String(v || '').trim().replace(/[\r\n]/g, '')
    if (!val || val.length > 4096) continue
    result[key] = val
  }
  return result
}

/**
 * Применяет дефолты тела запроса из профиля сайта.
 * Значения пользователя имеют приоритет.
 */
export function applyBodyDefaults(body = {}, baseUrl = '') {
  const profile = getSiteProfile(baseUrl)
  const merged = { ...profile.bodyDefaults, ...body }
  // Per-provider temperature clamp (e.g. ZhipuAI only accepts [0,1] and
  // responds 400/1210 to the common OpenAI default of up to 2.0).
  if (profile.temperatureMax != null && typeof merged.temperature === 'number' && merged.temperature > profile.temperatureMax) {
    merged.temperature = profile.temperatureMax
  }
  if (typeof merged.temperature === 'number') {
    if (merged.temperature < 0) merged.temperature = 0
    // Общий верхний лимит 2.0 — стандарт OpenAI; провайдеры с меньшим лимитом clamp выше
    if (profile.temperatureMax == null && merged.temperature > 2.0) merged.temperature = 2.0
  }
  return merged
}

/**
 * Возвращает URL для chat endpoint, учитывая особенности провайдера.
 * DeepSeek использует /chat/completion вместо /chat/completions.
 */
export function getChatUrl(baseUrl) {
  const profile = getSiteProfile(baseUrl)
  const root = String(baseUrl || '').replace(/\/$/, '')
  const endpoint = profile.chatEndpoint || '/chat/completions'
  return `${root}${endpoint}`
}

/**
 * Формирует probe-тело для validate — реалистичное, не «ping».
 * Короткий но натуральный запрос.
 */
export function buildProbeBody(baseUrl, model) {
  return applyBodyDefaults({
    model:    model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 5,
    stream:   false, // probe всегда non-stream для простоты парсинга ответа
  }, baseUrl)
}

