// Настройки подключения к OpenAI-совместимому API.
// Поддержка нескольких сохранённых ключей, списка доступных моделей
// и выбранной модели для каждого ключа. Хранится в localStorage.

import { uid } from './uid.js'

export { uid }

const KEY = 'browserai.settings.v2'
const OLD_KEY = 'browserai.settings.v1'

// Общие параметры генерации (не зависят от конкретного ключа)
const DEFAULT_PARAMS = {
  systemPrompt: 'Ты — полезный ассистент. Отвечай ясно и по делу.',
  temperature: 0.7,
  stream: true,
  useWebAI: false,
}

function cleanModels(models) {
  if (!Array.isArray(models)) return []
  return [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))]
}

export function normalizeKey(key = {}) {
  key = key || {}
  const availableModels = cleanModels(key.availableModels)
  const fallbackModel = String(key.model || '').trim()
  const model =
    availableModels.find((m) => m === fallbackModel) ||
    fallbackModel ||
    availableModels[0] ||
    ''

  return {
    id: key.id || uid(),
    name: key.name || '',
    baseUrl: key.baseUrl || 'https://api.openai.com/v1',
    apiKey: key.apiKey || '',
    model,
    availableModels:
      availableModels.length > 0
        ? availableModels
        : model
          ? [model]
          : [],
    authType: key.authType || 'bearer',     // 'bearer' | 'cookie' | 'custom'
    authHeader: key.authHeader || '',       // кастомный заголовок, напр. "X-Auth-Token"
    responsePath: key.responsePath || '',   // путь к тексту в JSON ответе, напр. "choices.0.message.content"
    extraHeaders: (key.extraHeaders && typeof key.extraHeaders === 'object' && !Array.isArray(key.extraHeaders))
      ? key.extraHeaders : {},              // доп. заголовки: { Referer: '...', 'x-app-version': '...' }
    createdAt: key.createdAt || Date.now(),
    updatedAt: key.updatedAt || Date.now(),
    active: Boolean(key.active),
    encrypted: Boolean(key.encrypted),
    locked: Boolean(key.locked),
  }
}

// Пустой ключ-шаблон
export function emptyKey() {
  return normalizeKey({
    id: uid(),
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    availableModels: [],
    authType: 'bearer', // 'bearer' | 'cookie' | 'custom'
    authHeader: '',     // кастомное имя заголовка
    extraHeaders: {},   // доп. заголовки { Referer, Origin, 'x-app-version'... }
  })
}

export const DEFAULT_SETTINGS = {
  keys: [],
  activeKeyId: null,
  ...DEFAULT_PARAMS,
}

function migrateFromV1() {
  try {
    const raw = localStorage.getItem(OLD_KEY)
    if (!raw) return null
    const old = JSON.parse(raw)
    const keys = []
    let activeKeyId = null
    if (old.apiKey) {
      const k = normalizeKey({
        id: uid(),
        name: 'Ключ 1',
        baseUrl: old.baseUrl || 'https://api.openai.com/v1',
        apiKey: old.apiKey,
        model: old.model || 'gpt-4o-mini',
        availableModels: old.model ? [old.model] : [],
      })
      keys.push(k)
      activeKeyId = k.id
    }
    return {
      keys,
      activeKeyId,
      systemPrompt: old.systemPrompt ?? DEFAULT_PARAMS.systemPrompt,
      temperature: old.temperature ?? DEFAULT_PARAMS.temperature,
      stream: old.stream ?? DEFAULT_PARAMS.stream,
    }
  } catch {
    return null
  }
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    keys: Array.isArray(settings.keys)
      ? settings.keys.map(normalizeKey)
      : DEFAULT_SETTINGS.keys,
  }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return normalizeSettings(parsed)
    }
    // миграция со старого формата
    const migrated = migrateFromV1()
    if (migrated) {
      const merged = normalizeSettings(migrated)
      saveSettings(merged)
      return merged
    }
    return normalizeSettings()
  } catch {
    return normalizeSettings()
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeSettings(settings)))
  } catch {
    // ignore quota errors
  }
}

// Активный ключ (объект) или null
export function getActiveKey(settings) {
  if (!settings?.keys?.length) return null
  return (
    settings.keys.find((k) => k.id === settings.activeKeyId) ||
    settings.keys[0] ||
    null
  )
}

export function getSelectedModel(key) {
  const k = normalizeKey(key)
  return k.model || k.availableModels[0] || ''
}

export function getAvailableModels(key) {
  return normalizeKey(key).availableModels
}

// «Плоский» вид настроек для api.js / useChats: подставляет поля активного ключа
export function resolveActive(settings) {
  const k = getActiveKey(settings)
  return {
    baseUrl: k?.baseUrl || '',
    apiKey: k?.apiKey || '',
    model: getSelectedModel(k),
    authType: k?.authType || 'bearer',
    authHeader: k?.authHeader || '',
    responsePath: k?.responsePath || '',
    extraHeaders: (k?.extraHeaders && typeof k.extraHeaders === 'object') ? k.extraHeaders : {},
    systemPrompt: settings?.systemPrompt ?? DEFAULT_PARAMS.systemPrompt,
    temperature: settings?.temperature ?? DEFAULT_PARAMS.temperature,
    stream: settings?.stream ?? DEFAULT_PARAMS.stream,
    useWebAI: settings?.useWebAI ?? DEFAULT_PARAMS.useWebAI,
  }
}

export function isConfigured(settings) {
  const a = resolveActive(settings)
  return Boolean(a.apiKey && a.baseUrl && a.model)
}
