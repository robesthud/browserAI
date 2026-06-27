// Клиент серверного API (Express + SQLite).
// Все методы возвращают данные или бросают ошибку. Доступность проверяется
// через ping(); если бэкенд недоступен — вызывающий код переходит на localStorage.

const BASE = '/api'
const DEFAULT_TIMEOUT_MS = 12000

async function req(path, options = {}) {
  // Если снаружи уже передан signal (например, из validateKey) — используем его,
  // иначе ставим дефолтный таймаут 12 секунд чтобы не зависать при недоступном бэкенде
  const hasExternalSignal = Boolean(options.signal)
  const controller = hasExternalSignal ? null : new AbortController()
  const timer = controller
    ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    : null

  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      signal: hasExternalSignal ? options.signal : controller.signal,
    })
    const contentType = res.headers.get('content-type') || ''

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`API ${res.status}: ${text}`)
    }

    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '')
      throw new Error(`API returned non-JSON response for ${path}: ${text.slice(0, 200)}`)
    }

    return res.json()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function ping(timeoutMs = 5000) {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    // #39 FIX: Use cache: 'no-store' to ensure we are actually hitting the server
    const res = await fetch(`${BASE}/health`, { 
      signal: controller.signal,
      cache: 'no-store'
    })
    clearTimeout(t)
    if (!res.ok) return false
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) return false
    const data = await res.json().catch(() => null)
    return Boolean(data?.ok)
  } catch {
    return false
  }
}

export const backend = {
  authMe: () => req('/auth/me'),
  authRegister: (payload) =>
    req('/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  authLogin: (payload) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  authLogout: () => req('/auth/logout', { method: 'POST' }),
  authForgotPassword: (email) =>
    req('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  authResetPassword: (token, password) =>
    req('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }),
  authSmsSend: (phone) =>
    req('/auth/sms-send', { method: 'POST', body: JSON.stringify({ phone }) }),
  authSmsVerify: (phone, code) =>
    req('/auth/sms-verify', { method: 'POST', body: JSON.stringify({ phone, code }) }),
  updatePhone: (phone) =>
    req('/auth/phone', { method: 'PUT', body: JSON.stringify({ phone }) }),
  getCloud: () => req('/cloud'),
  saveCloud: (payload) =>
    req('/cloud', { method: 'PUT', body: JSON.stringify(payload) }),

  getSettings: () => req('/settings'),
  saveKey: (key) =>
    req('/keys', { method: 'POST', body: JSON.stringify(key) }),
  deleteKey: (id) => req(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  activateKey: (id) =>
    req(`/keys/${encodeURIComponent(id)}/activate`, { method: 'POST' }),
  // Step 10.8 — rotate a key's secret in place (validate new → overwrite old).
  rotateKey: (payload) =>
    req('/keys/rotate', { method: 'POST', body: JSON.stringify(payload) }),
  importKeys: (keys, activeKeyId) =>
    req('/keys/import', {
      method: 'POST',
      body: JSON.stringify({ keys, activeKeyId }),
    }),
  setParams: (params) =>
    req('/params', { method: 'PUT', body: JSON.stringify(params) }),
  // Серверная проверка валидности (без CORS-проблем)
  validate: (key, signal) =>
    req('/validate', { method: 'POST', body: JSON.stringify(key), signal }),

  webSearch: (query, limit = 5) =>
    req(`/web/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`),
  webFetch: (url) =>
    req(`/web/fetch?url=${encodeURIComponent(url)}`),

  // ---- Vault (шифрование мастер-паролем) ----
  vaultStatus: () => req('/vault/status'),
  vaultSetup: (passphrase) =>
    req('/vault/setup', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  vaultUnlock: (passphrase) =>
    req('/vault/unlock', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  vaultLock: () => req('/vault/lock', { method: 'POST' }),
  vaultChange: (passphrase) =>
    req('/vault/change', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  vaultDisable: () => req('/vault/disable', { method: 'POST' }),
  vaultAutolock: (minutes) =>
    req('/vault/autolock', { method: 'POST', body: JSON.stringify({ minutes }) }),
  vaultBackup: () => req('/vault/backup'),
  vaultRestore: (backup) =>
    req('/vault/restore', { method: 'POST', body: JSON.stringify(backup) }),
}
