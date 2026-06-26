// SQLite-хранилище ключей и настроек генерации.
// Файл БД: server/browserai.db (создаётся автоматически).
// Поддержка шифрования api_key парольной фразой (см. crypto.js).

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { encrypt, decrypt } from './crypto.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = '/data'
const _rawDbPath = process.env.BROWSERAI_DB
  || (existsSync(DEFAULT_DATA_DIR) ? join(DEFAULT_DATA_DIR, 'browserai.db') : join(__dirname, 'browserai.db'))
if (process.env.BROWSERAI_DB && !process.env.BROWSERAI_DB.startsWith('/')) {
  console.warn('[db] WARNING: BROWSERAI_DB is not an absolute path — possible misconfiguration.')
}
const DB_PATH = _rawDbPath

let db
try {
  db = new Database(DB_PATH)
} catch (e) {
  console.error(`[db] FATAL: cannot open database at ${DB_PATH}:`, e.message)
  console.error('[db] Check file permissions, disk space, and BROWSERAI_DB env var.')
  process.exit(1)
}
// busy_timeout BEFORE journal_mode: parallel vitest workers (CI) open this
// same file simultaneously; without a timeout the second connection fails
// instantly with SQLITE_BUSY during the WAL switch / migrations below.
db.pragma('busy_timeout = 5000')
db.pragma('journal_mode = WAL')

// Таблица ключей (enc = 1 → api_key хранится в зашифрованном виде)
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT '',
    base_url         TEXT NOT NULL DEFAULT '',
    api_key          TEXT NOT NULL DEFAULT '',
    model            TEXT NOT NULL DEFAULT '',
    available_models TEXT NOT NULL DEFAULT '[]',
    is_active        INTEGER NOT NULL DEFAULT 0,
    enc              INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
`)

const _keyCount = db.prepare('SELECT count(*) as c FROM keys').get()
if (_keyCount && _keyCount.c === 0) {
  const now = Date.now()
  const glmModels = ['glm-4.5-flash', 'GLM-4.7-Flash', 'glm-4-flash', 'glm-z1-flash', 'glm-4v-flash', 'glm-4.1v-thinking-flash', 'glm-4.6v-flash', 'glm-4.7', 'glm-5.1', 'glm-5.2']
  const dsModels = ['deepseek_chat', 'deepseek-reasoner', 'DeepThink']
  db.prepare(`INSERT INTO keys (id, name, base_url, api_key, model, available_models, is_active, enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'glm-default', 'Zhipu AI (GLM)', 'https://open.bigmodel.cn/api/paas/v4', process.env.BIGMODEL_API_KEY || '', 'glm-4.5-flash', JSON.stringify(glmModels), 1, 0, now, now
  )
  db.prepare(`INSERT INTO keys (id, name, base_url, api_key, model, available_models, is_active, enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'deepseek-default', 'DeepSeek Managed', 'https://chat.deepseek.com/api/v0', '__managed__', 'deepseek_chat', JSON.stringify(dsModels), 0, 0, now, now
  )
}

// Миграции старых БД — добавляем недостающие колонки без пересоздания таблицы
try {
  const cols = db.prepare(`PRAGMA table_info(keys)`).all().map((c) => c.name)

  if (!cols.includes('enc')) {
    db.exec(`ALTER TABLE keys ADD COLUMN enc INTEGER NOT NULL DEFAULT 0`)
  }
  if (!cols.includes('available_models')) {
    db.exec(`ALTER TABLE keys ADD COLUMN available_models TEXT NOT NULL DEFAULT '[]'`)
  }
  // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: добавляем колонки для типа авторизации
  if (!cols.includes('auth_type')) {
    db.exec(`ALTER TABLE keys ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'bearer'`)
  }
  if (!cols.includes('auth_header')) {
    db.exec(`ALTER TABLE keys ADD COLUMN auth_header TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.includes('response_path')) {
    db.exec(`ALTER TABLE keys ADD COLUMN response_path TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.includes('extra_headers')) {
    db.exec(`ALTER TABLE keys ADD COLUMN extra_headers TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!cols.includes('only_free')) {
    db.exec(`ALTER TABLE keys ADD COLUMN only_free INTEGER NOT NULL DEFAULT 0`)
  }
} catch (e) {
  console.error('[db] keys migration warning:', e.message)
}

try {
  const cols = db.prepare(`PRAGMA table_info(params)`).all().map((c) => c.name)
  if (!cols.includes('use_web_ai')) {
    db.exec(`ALTER TABLE params ADD COLUMN use_web_ai INTEGER NOT NULL DEFAULT 0`)
  }
  if (!cols.includes('max_steps')) {
    db.exec(`ALTER TABLE params ADD COLUMN max_steps INTEGER NOT NULL DEFAULT 0`)
  }
} catch (e) {
  console.error('[db] params migration warning:', e.message)
}

// Параметры генерации (один ряд)
db.exec(`
  CREATE TABLE IF NOT EXISTS params (
    id           TEXT PRIMARY KEY,
    system_prompt TEXT NOT NULL DEFAULT '',
    temperature  REAL NOT NULL DEFAULT 0.7,
    stream       INTEGER NOT NULL DEFAULT 1,
    use_web_ai   INTEGER NOT NULL DEFAULT 0
  );
`)
db.prepare(
  `INSERT OR IGNORE INTO params (id, system_prompt, temperature, stream, use_web_ai)
   VALUES ('singleton', ?, 0.7, 1, 0)`,
).run('Ты — полезный ассистент. Отвечай ясно и по делу.')

// Метаданные хранилища (vault): salt, verifier, enabled
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`)

function normalizeModels(models = []) {
  if (!Array.isArray(models)) return []
  return [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))]
}

function parseModels(raw, fallbackModel = '') {
  try {
    const parsed = normalizeModels(JSON.parse(raw || '[]'))
    if (parsed.length > 0) return parsed
  } catch {
    /* ignore */
  }
  const model = String(fallbackModel || '').trim()
  return model ? [model] : []
}

function stringifyModels(models = [], fallbackModel = '') {
  const clean = normalizeModels(models)
  if (clean.length > 0) return JSON.stringify(clean)
  const model = String(fallbackModel || '').trim()
  return JSON.stringify(model ? [model] : [])
}

// ---- vault meta ----
export function getMeta(key) {
  const r = _stmtGetMeta.get(key)
  return r ? r.value : null
}
export function setMeta(key, value) {
  const strValue = value == null ? null : String(value)
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, strValue)
}
export function delMeta(key) {
  db.prepare('DELETE FROM meta WHERE key=?').run(key)
}

export function vaultEnabled() {
  return getMeta('vault_enabled') === '1'
}
export function getVault() {
  return {
    enabled: vaultEnabled(),
    salt: getMeta('vault_salt'),
    verifier: getMeta('vault_verifier'),
  }
}

// ---- keys ----
function parseExtraHeaders(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* ignore */ }
  return {}
}

function rowToKey(r, encKey) {
  let apiKey = r.api_key || ''
  let locked = false
  if (r.enc) {
    if (encKey) {
      try {
        apiKey = decrypt(r.api_key, encKey)
      } catch {
        apiKey = ''
        locked = true
      }
    } else {
      apiKey = ''
      locked = true
    }
  }

  const availableModels = parseModels(r.available_models, r.model)
  const model = availableModels.includes(r.model)
    ? r.model
    : r.model || availableModels[0] || ''

  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKey,
    model,
    availableModels,
    // Поля авторизации — теперь сохраняются и возвращаются
    authType: r.auth_type || 'bearer',
    authHeader: r.auth_header || '',
    responsePath: r.response_path || '',
    extraHeaders: parseExtraHeaders(r.extra_headers),
    onlyFree: Boolean(r.only_free),
    active: Boolean(r.is_active),
    encrypted: Boolean(r.enc),
    locked,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function maskSecret(secret = '') {
  const s = String(secret || '')
  if (!s) return ''
  if (s.startsWith('__') && s.endsWith('__')) return s
  if (s.length <= 8) return '••••••••'
  return `${s.slice(0, 4)}...${s.slice(-4)}`
}

function toSafeKeyView(row) {
  const full = rowToKey(row, null)
  const hasStoredSecret = Boolean(String(row.api_key || '').trim())
  return {
    ...full,
    apiKey: '',
    hasSecret: hasStoredSecret,
    maskedApiKey: hasStoredSecret ? (row.enc ? 'encrypted' : maskSecret(row.api_key)) : '',
    useStoredSecret: hasStoredSecret,
  }
}

// encKey (Buffer|null) — если задан И хранилище включено, api_key шифруется/расшифровывается
export function listKeys(encKey = null) {
  const rows = db.prepare('SELECT * FROM keys ORDER BY created_at ASC').all()
  return rows.map((r) => rowToKey(r, encKey))
}

export function listKeysSafe() {
  const rows = db.prepare('SELECT * FROM keys ORDER BY created_at ASC').all()
  return rows.map((r) => toSafeKeyView(r))
}

export function getActiveKeyId() {
  const r = _stmtGetActiveKeyId.get()
  return r ? r.id : null
}

export function getKeyByIdDecrypted(id, encKey = null) {
  const r = _stmtGetKeyById.get(id)
  if (!r) return null
  return rowToKey(r, encKey)
}

export function getKeyByIdSafe(id) {
  const r = _stmtGetKeyById.get(id)
  if (!r) return null
  return toSafeKeyView(r)
}

// Возвращает расшифрованный активный ключ (для /validate, /chat). encKey обязателен, если зашифровано.
export function getActiveKeyDecrypted(encKey = null) {
  const r = _stmtGetActiveKeyFull.get()
  if (!r) return null
  return rowToKey(r, encKey)
}

export function upsertKey(key, encKey = null) {
  if (!key || !String(key.id || '').trim()) throw new Error('upsertKey: key.id is required')
  const now = Date.now()
  const encKeyValid = (Buffer.isBuffer(encKey) || encKey instanceof Uint8Array)
    ? encKey.length > 0
    : (typeof encKey === 'string' && encKey.trim().length > 0)
  const useEnc = vaultEnabled() && encKeyValid
  // Не шифруем пустой ключ — шифртекст пустой строки только засоряет БД
  const rawApiKey = key.apiKey || ''
  const storedApiKey = (useEnc && rawApiKey) ? encrypt(rawApiKey, encKey) : rawApiKey
  const encFlag = (useEnc && rawApiKey) ? 1 : 0
  const model = String(key.model || '').trim()
  const availableModels = stringifyModels(key.availableModels, model)
  // Нормализуем authType — только допустимые значения
  const authType = ['bearer', 'cookie', 'custom'].includes(key.authType) ? key.authType : 'bearer'
  const authHeader = String(key.authHeader || '').trim()
  const responsePath = String(key.responsePath || '').trim()
  const extraHeaders = JSON.stringify(
    (key.extraHeaders && typeof key.extraHeaders === 'object' && !Array.isArray(key.extraHeaders))
      ? key.extraHeaders : {}
  )

  const exists = db.prepare('SELECT id FROM keys WHERE id = ?').get(key.id)
  const onlyFreeFlag = key.onlyFree ? 1 : 0
  if (exists) {
    db.prepare(
      `UPDATE keys
       SET name=?, base_url=?, api_key=?, model=?, available_models=?,
           enc=?, auth_type=?, auth_header=?, response_path=?, extra_headers=?, only_free=?, updated_at=?
       WHERE id=?`,
    ).run(
      key.name,
      key.baseUrl,
      storedApiKey,
      model,
      availableModels,
      encFlag,
      authType,
      authHeader,
      responsePath,
      extraHeaders,
      onlyFreeFlag,
      now,
      key.id,
    )
  } else {
    db.prepare(
      `INSERT INTO keys
         (id, name, base_url, api_key, model, available_models,
          is_active, enc, auth_type, auth_header, response_path, extra_headers, only_free, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      key.id,
      key.name,
      key.baseUrl,
      storedApiKey,
      model,
      availableModels,
      encFlag,
      authType,
      authHeader,
      responsePath,
      extraHeaders,
      onlyFreeFlag,
      now,
      now,
    )
  }
  if (!getActiveKeyId()) setActiveKey(key.id)
  const row = db.prepare('SELECT * FROM keys WHERE id=?').get(key.id)
  return row ? rowToKey(row, encKey) : null
}

export function deleteKey(id) {
  const tx = db.transaction((delId) => {
    const wasActive = getActiveKeyId() === delId
    db.prepare('DELETE FROM keys WHERE id=?').run(delId)
    if (wasActive) {
      const first = db.prepare('SELECT id FROM keys ORDER BY created_at ASC LIMIT 1').get()
      if (first) db.prepare('UPDATE keys SET is_active=1 WHERE id=?').run(first.id)
    }
  })
  tx(id)
}

export function setActiveKey(id) {
  if (id) {
    const exists = db.prepare('SELECT id FROM keys WHERE id = ?').get(id)
    if (!exists) throw new Error(`setActiveKey: key '${id}' not found`)
  }
  const tx = db.transaction((activeId) => {
    db.prepare('UPDATE keys SET is_active = 0').run()
    if (activeId) db.prepare('UPDATE keys SET is_active = 1 WHERE id = ?').run(activeId)
  })
  tx(id)
}

export function replaceKeys(keys, activeKeyId, encKey = null) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('replaceKeys: keys must be a non-empty array')
  }
  const now = Date.now()
  const encKeyValid = (Buffer.isBuffer(encKey) || encKey instanceof Uint8Array)
    ? encKey.length > 0
    : (typeof encKey === 'string' && encKey.trim().length > 0)
  const useEnc = vaultEnabled() && encKeyValid
  const tx = db.transaction((items, activeId) => {
    db.prepare('DELETE FROM keys').run()
    const ins = db.prepare(
      `INSERT INTO keys
         (id, name, base_url, api_key, model, available_models,
          is_active, enc, auth_type, auth_header, response_path, extra_headers, only_free, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const k of items) {
      const model = String(k.model || '').trim()
      const rawK = k.apiKey || ''
      const stored = (useEnc && rawK) ? encrypt(rawK, encKey) : rawK
      const authType = ['bearer', 'cookie', 'custom'].includes(k.authType) ? k.authType : 'bearer'
      const extraH = JSON.stringify(
        (k.extraHeaders && typeof k.extraHeaders === 'object' && !Array.isArray(k.extraHeaders))
          ? k.extraHeaders : {}
      )
      ins.run(
        k.id,
        k.name || '',
        k.baseUrl || '',
        stored,
        model,
        stringifyModels(k.availableModels, model),
        k.id === activeId ? 1 : 0,
        (useEnc && rawK) ? 1 : 0,
        authType,
        String(k.authHeader || '').trim(),
        String(k.responsePath || '').trim(),
        extraH,
        k.onlyFree ? 1 : 0,
        k.createdAt || now,
        now,
      )
    }
    const activeFound = db.prepare('SELECT id FROM keys WHERE is_active=1').get()
    if (!activeFound) {
      if (activeKeyId) console.warn(`[db] replaceKeys: activeKeyId '${activeKeyId}' not found in keys — activating first key`)
      const first = db.prepare('SELECT id FROM keys ORDER BY created_at ASC LIMIT 1').get()
      if (first) db.prepare('UPDATE keys SET is_active=1 WHERE id=?').run(first.id)
    }
  })
  tx(keys, activeKeyId)
}

// Перешифровать все ключи: из текущего состояния (oldKey|null) в новое (newKey|null).
// newKey=null → расшифровать всё (отключить шифрование).
export function reencryptAll(oldKey, newKey) {
  const rows = db.prepare('SELECT * FROM keys').all()
  const tx = db.transaction(() => {
    for (const r of rows) {
      // получаем открытый текст
      let plain = r.api_key
      if (r.enc) {
        if (!oldKey) {
          console.warn(`[db] reencryptAll: skipping encrypted key ${r.id} — oldKey not provided`)
          continue
        }
        plain = decrypt(r.api_key, oldKey)
      }
      const newKeyValid = newKey && (Buffer.isBuffer(newKey) || newKey instanceof Uint8Array
        ? newKey.length > 0
        : String(newKey).length > 0)
      const stored = newKeyValid ? encrypt(plain, newKey) : plain
      db.prepare('UPDATE keys SET api_key=?, enc=? WHERE id=?').run(
        stored,
        newKey ? 1 : 0,
        r.id,
      )
    }
  })
  tx()
}

export function getParams() {
  const r = _stmtGetParams.get()
  if (!r) return { systemPrompt: '', temperature: 0.7, stream: true, useWebAI: false }
  return {
    systemPrompt: r.system_prompt,
    maxSteps: Number(r.max_steps || 0),
    temperature: r.temperature,
    stream: Boolean(r.stream),
    useWebAI: Boolean(r.use_web_ai),
  }
}

export function setParams(p) {
  const cur = getParams()
  const next = { ...cur, ...p }
  if (!Number.isFinite(next.temperature)) next.temperature = cur.temperature
  db.prepare(
    `UPDATE params SET system_prompt=?, temperature=?, stream=?, use_web_ai=?, max_steps=? WHERE id='singleton'`,
  ).run(next.systemPrompt, next.temperature, next.stream ? 1 : 0, next.useWebAI ? 1 : 0, Math.max(0, Math.min(100, Number(next.maxSteps || 0))))
  return getParams()
}

// ---- Бэкап: сырые ряды ключей (как лежат в БД, включая enc/шифртекст) ----
export function dumpRawKeys() {
  // WAL checkpoint: убеждаемся что все данные записаны в основной файл
  try { db.pragma('wal_checkpoint(FULL)') } catch { /* ignore — not critical */ }
  const rows = db.prepare('SELECT * FROM keys ORDER BY created_at ASC').all()
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKey: r.api_key, // если enc=1 — это шифртекст
    model: r.model,
    availableModels: parseModels(r.available_models, r.model),
    authType: r.auth_type || 'bearer',
    authHeader: r.auth_header || '',
    responsePath: r.response_path || '',
    extraHeaders: parseExtraHeaders(r.extra_headers),
    isActive: r.is_active,
    enc: r.enc,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

// Восстановление сырых рядов (для зашифрованного бэкапа — пишем как есть)
export function restoreRawKeys(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('restoreRawKeys: rows must be a non-empty array')
  }
  const tx = db.transaction((items) => {
    db.prepare('DELETE FROM keys').run()
    const ins = db.prepare(
      `INSERT INTO keys
         (id, name, base_url, api_key, model, available_models,
          is_active, enc, auth_type, auth_header, response_path, extra_headers, only_free, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = Date.now()
    for (const k of items) {
      const model = String(k.model || '').trim()
      const authType = ['bearer', 'cookie', 'custom'].includes(k.authType) ? k.authType : 'bearer'
      const extraH = JSON.stringify(
        (k.extraHeaders && typeof k.extraHeaders === 'object' && !Array.isArray(k.extraHeaders))
          ? k.extraHeaders : {}
      )
      ins.run(
        k.id,
        k.name || '',
        k.baseUrl || '',
        k.apiKey || '',
        model,
        stringifyModels(k.availableModels, model),
        k.isActive ? 1 : 0,
        k.enc ? 1 : 0,
        authType,
        String(k.authHeader || '').trim(),
        String(k.responsePath || '').trim(),
        extraH,
        k.onlyFree ? 1 : 0,
        k.createdAt || now,
        k.updatedAt || now,
      )
    }
    if (!db.prepare('SELECT id FROM keys WHERE is_active=1').get()) {
      const first = db.prepare('SELECT id FROM keys ORDER BY created_at ASC LIMIT 1').get()
      if (first) db.prepare('UPDATE keys SET is_active=1 WHERE id=?').run(first.id)
    }
  })
  tx(rows)
}

// ── Кешированные prepared statements для горячих путей ─────────────────────
// better-sqlite3 рекомендует создавать Statement один раз и переиспользовать.
const _stmtGetActiveKeyId    = db.prepare('SELECT id FROM keys WHERE is_active = 1 LIMIT 1')
const _stmtGetActiveKeyFull  = db.prepare('SELECT * FROM keys WHERE is_active = 1 LIMIT 1')
const _stmtGetKeyById        = db.prepare('SELECT * FROM keys WHERE id = ? LIMIT 1')
// WAL checkpoint scheduler — prevents wal file growing indefinitely
// Runs every 30 min; harmless if DB is idle (nothing to checkpoint)
const _walTimer = setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)') } catch { /* ignore */ }
}, 30 * 60 * 1000)
_walTimer?.unref?.()

const _stmtGetParams         = db.prepare(`SELECT * FROM params WHERE id='singleton'`)
const _stmtGetMeta           = db.prepare('SELECT value FROM meta WHERE key=?')

export default db
