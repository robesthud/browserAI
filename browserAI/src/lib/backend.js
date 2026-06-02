// Клиент серверного API (Express + SQLite).
// Все методы возвращают данные или бросают ошибку. Доступность проверяется
// через ping(); если бэкенд недоступен — вызывающий код переходит на localStorage.

const BASE = '/api'

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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
}

export async function ping(timeoutMs = 1500) {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`${BASE}/health`, { signal: controller.signal })
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
  getSettings: () => req('/settings'),
  saveKey: (key) =>
    req('/keys', { method: 'POST', body: JSON.stringify(key) }),
  deleteKey: (id) => req(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  activateKey: (id) =>
    req(`/keys/${encodeURIComponent(id)}/activate`, { method: 'POST' }),
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
