// Express-бэкенд BrowserAI.
// - REST API для CRUD ключей и параметров (SQLite через db.js)
// - Опциональное шифрование ключей мастер-паролем (vault, см. crypto.js)
// - Автоблокировка по таймауту бездействия
// - Экспорт/импорт зашифрованного бэкапа БД
// - Проверка валидности ключа на стороне сервера (нет проблем с CORS)
// - В production отдаёт собранный фронтенд из ../dist

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { isIP as isIp } from 'is-ip'
import ipaddr from 'ipaddr.js'
import AdmZip from 'adm-zip'
import path from 'node:path'
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  listKeys,
  getActiveKeyId,
  getActiveKeyDecrypted,
  upsertKey,
  deleteKey,
  setActiveKey,
  replaceKeys,
  reencryptAll,
  getParams,
  setParams,
  getVault,
  vaultEnabled,
  getMeta,
  setMeta,
  delMeta,
  dumpRawKeys,
  restoreRawKeys,
} from './db.js'
import db from './db.js'
import {
  generateSalt,
  deriveKey,
  makeVerifier,
  checkVerifier,
} from './crypto.js'
import {
  ensureWorkspaceRoot,
  getWorkspaceTree,
  readWorkspaceFile,
  createFolder,
  createFile,
  writeFileContent,
  renameItem,
  deleteItem,
  moveItem,
  uploadFiles,
  uploadFromUrl,
  searchWorkspaceContent,
  getFileHistory,
  restoreFileRevision,
  streamWorkspaceFile,
  statWorkspaceItem,
  getDownloadName,
  safePath,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8787

function isPrivateIp(address) {
  if (!isIp(address)) return false
  const addr = ipaddr.parse(address)
  return addr.range() !== 'unicast' || addr.isLoopback() || addr.isLinkLocal()
}

// Rate limiting: 100 запросов на IP за 15 минут
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down' }
})

// Мастер-ключ хранилища держим ТОЛЬКО в памяти, пока разблокировано.
let unlockedKey = null
let lastActivity = Date.now()

const app = express()
app.set('trust proxy', 1)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      // Vite legacy builds inject small inline loader scripts. They are required
      // for older Android System WebView versions that do not support modules.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}))
app.use(limiter)
// Do not hard-code localhost in production: Vite emits crossorigin assets,
// and a mismatched Access-Control-Allow-Origin header makes browsers block JS/CSS.
app.use(process.env.CORS_ORIGIN ? cors({ origin: process.env.CORS_ORIGIN }) : cors())
app.use(express.json({ limit: '50mb' }))

// ---- Auth + encrypted cloud sync ----
const AUTH_COOKIE = 'browserai_session'
const SESSION_DAYS = 30
const APP_URL = (process.env.APP_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  || 'http://localhost:8787').replace(/\/$/, '')
const AUTH_SECRET = process.env.AUTH_SECRET || 'browserai-dev-secret-change-me'
if (!process.env.AUTH_SECRET) {
  console.warn('⚠ AUTH_SECRET is not set. Set a long random AUTH_SECRET in Railway Variables for production.')
}

function now() {
  return Date.now()
}

function uidAuth() {
  return crypto.randomUUID()
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored = '') {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const next = passwordHash(password, salt).split(':')[1]
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'))
}

function encryptionKey() {
  return crypto.createHash('sha256').update(AUTH_SECRET).digest()
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value ?? {}), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

function decryptJson(payload) {
  const [version, ivB64, tagB64, dataB64] = String(payload || '').split(':')
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return {}
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plain.toString('utf8'))
}

function parseCookies(req) {
  const raw = req.headers.cookie || ''
  return Object.fromEntries(raw.split(';').map((part) => {
    const at = part.indexOf('=')
    if (at === -1) return ['', '']
    return [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim())]
  }).filter(([k]) => k))
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60
  const secure = process.env.NODE_ENV === 'production'
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`)
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    role: row.role || 'user',
    createdAt: row.created_at,
  }
}

function initAuthTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_cloud_data (
      user_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
}
initAuthTables()

function getSessionUser(req) {
  const token = parseCookies(req)[AUTH_COOKIE]
  if (!token) return null
  const tokenHash = sha256(token)
  const row = db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    LIMIT 1
  `).get(tokenHash, now())
  return row || null
}

function optionalAuth(req, res, next) {
  req.user = getSessionUser(req)
  next()
}

function requireAuth(req, res, next) {
  req.user = getSessionUser(req)
  if (!req.user) return res.status(401).json({ error: 'Требуется вход' })
  next()
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uidAuth(), userId, sha256(token), now() + SESSION_DAYS * 24 * 60 * 60 * 1000, now())
  setSessionCookie(res, token)
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_FROM)
}

async function sendPasswordResetEmail(email, resetUrl) {
  if (!smtpConfigured()) {
    throw new Error('SMTP не настроен. Добавьте SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM в Railway Variables.')
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  })
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Восстановление пароля BrowserAI',
    text: `Для сброса пароля откройте ссылку:\n\n${resetUrl}\n\nСсылка действует 1 час.`,
    html: `<p>Для сброса пароля откройте ссылку:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Ссылка действует 1 час.</p>`,
  })
}

app.get('/api/auth/me', optionalAuth, (req, res) => {
  res.json({ user: publicUser(req.user) })
})

app.post('/api/auth/register', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const name = String(req.body?.name || '').trim()
  const password = String(req.body?.password || '')
  const registrationSecret = String(req.body?.registrationSecret || '')

  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Некорректный email' })
  if (password.length < 8) return res.status(400).json({ error: 'Пароль должен быть минимум 8 символов' })

  const usersCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count
  if (usersCount > 0) {
    const required = process.env.REGISTRATION_SECRET || ''
    if (!required || registrationSecret !== required) {
      return res.status(403).json({ error: 'Регистрация закрыта. Первый пользователь уже создан.' })
    }
  }

  const id = uidAuth()
  const role = usersCount === 0 ? 'owner' : 'user'
  try {
    db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, email, name, passwordHash(password), role, now(), now())
    createSession(res, id)
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id)
    res.json({ user: publicUser(user) })
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Email уже зарегистрирован' })
    res.status(500).json({ error: 'Не удалось зарегистрировать пользователя' })
  }
})

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email)
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный email или пароль' })
  }
  createSession(res, user.id)
  res.json({ user: publicUser(user) })
})

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = parseCookies(req)[AUTH_COOKIE]
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token))
  clearSessionCookie(res)
  res.json({ ok: true })
})

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email)
  if (!user) return res.json({ ok: true })
  const token = crypto.randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uidAuth(), user.id, sha256(token), now() + 60 * 60 * 1000, now())
  const resetUrl = `${APP_URL}/?reset_token=${encodeURIComponent(token)}`
  try {
    await sendPasswordResetEmail(email, resetUrl)
    res.json({ ok: true })
  } catch (error) {
    res.status(503).json({ error: error.message || 'Email-сервис не настроен' })
  }
})

app.post('/api/auth/reset-password', (req, res) => {
  const token = String(req.body?.token || '')
  const password = String(req.body?.password || '')
  if (password.length < 8) return res.status(400).json({ error: 'Пароль должен быть минимум 8 символов' })
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash=? AND expires_at>? AND used_at IS NULL').get(sha256(token), now())
  if (!row) return res.status(400).json({ error: 'Ссылка недействительна или устарела' })
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(passwordHash(password), now(), row.user_id)
    db.prepare('UPDATE password_reset_tokens SET used_at=? WHERE id=?').run(now(), row.id)
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id)
  })()
  res.json({ ok: true })
})

app.get('/api/cloud', requireAuth, (req, res) => {
  const row = db.prepare('SELECT payload, updated_at FROM user_cloud_data WHERE user_id=?').get(req.user.id)
  res.json({ data: row ? decryptJson(row.payload) : null, updatedAt: row?.updated_at || null })
})

app.put('/api/cloud', requireAuth, (req, res) => {
  const data = {
    settings: req.body?.settings || null,
    chats: Array.isArray(req.body?.chats) ? req.body.chats : [],
  }
  const payload = encryptJson(data)
  db.prepare(`
    INSERT INTO user_cloud_data (user_id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
  `).run(req.user.id, payload, now())
  res.json({ ok: true, updatedAt: now() })
})

function encKey() {
  return vaultEnabled() ? unlockedKey : null
}
function isLocked() {
  return vaultEnabled() && !unlockedKey
}

function normalizeModels(data) {
  if (!Array.isArray(data?.data)) return []
  return [...new Set(data.data.map((item) => String(item?.id || '').trim()).filter(Boolean))]
}

function scoreModel(id) {
  const v = String(id || '').toLowerCase()
  let score = 0

  if (/(gpt|claude|chat|instruct|qwen|deepseek|gemini|llama|mistral|yi|grok|kimi|command|sonnet|haiku|opus)/.test(v)) {
    score += 100
  }
  if (/(embed|embedding|rerank|rank|moderation|whisper|tts|speech|transcri|audio|image)/.test(v)) {
    score -= 120
  }
  if (/(mini|small|turbo|lite|flash|instant)/.test(v)) {
    score += 10
  }
  if (/(vision|vl)/.test(v)) {
    score += 5
  }

  return score
}

function rankModels(models = [], requestedModel = '') {
  const unique = [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))]
  const requested = String(requestedModel || '').trim()
  return unique.sort((a, b) => {
    if (a === requested) return -1
    if (b === requested) return 1
    const diff = scoreModel(b) - scoreModel(a)
    return diff || a.localeCompare(b)
  })
}

async function probeChatModel(root, apiKey, model) {
  const r = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
  })

  if (r.ok) return { ok: true }
  let detail = ''
  try {
    const j = await r.json()
    detail = j?.error?.message || ''
  } catch {
    /* ignore */
  }
  return { ok: false, status: r.status, detail }
}

async function fetchModels(baseUrl, apiKey, requestedModel = '') {
  // Блокировка private IP и localhost
  let hostname
  try {
    const url = new URL(baseUrl)
    hostname = url.hostname
  } catch {
    return { ok: false, status: 400, models: [], preferredModel: '', error: 'Invalid URL' }
  }
  if (isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
    return { ok: false, status: 403, models: [], preferredModel: '', error: 'Access to internal networks is not allowed' }
  }

  const root = String(baseUrl).replace(/\/$/, '')
  const r = await fetch(`${root}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!r.ok) {
    return { ok: false, status: r.status, models: [], preferredModel: '' }
  }

  try {
    const data = await r.json()
    const models = normalizeModels(data)
    const ranked = rankModels(models, requestedModel)
    const preferredCandidates = ranked.slice(0, 8)
    for (const candidate of preferredCandidates) {
      const probe = await probeChatModel(root, apiKey, candidate)
      if (probe.ok) {
        return { ok: true, models, preferredModel: candidate }
      }
      if (probe.status === 401 || probe.status === 403) {
        return { ok: false, status: probe.status, models, preferredModel: '' }
      }
    }
    return {
      ok: true,
      models,
      preferredModel: ranked[0] || String(requestedModel || '').trim() || '',
    }
  } catch {
    return { ok: true, models: [], preferredModel: String(requestedModel || '').trim() || '' }
  }
}

// Автоблокировка: 0 = выкл, иначе минуты бездействия
function autoLockMinutes() {
  const v = parseInt(getMeta('vault_autolock') || '0', 10)
  return Number.isFinite(v) && v > 0 ? v : 0
}
function setAutoLockMinutes(min) {
  setMeta('vault_autolock', String(Math.max(0, parseInt(min, 10) || 0)))
}
// Отметить активность (продлевает таймер)
function touch() {
  lastActivity = Date.now()
}
// Сколько секунд осталось до автоблокировки (или null)
function autoLockRemaining() {
  const min = autoLockMinutes()
  if (!min || isLocked() || !vaultEnabled()) return null
  const elapsed = (Date.now() - lastActivity) / 1000
  return Math.max(0, Math.round(min * 60 - elapsed))
}
// Фоновая проверка: блокируем при простое
setInterval(() => {
  const min = autoLockMinutes()
  if (min && unlockedKey && Date.now() - lastActivity > min * 60 * 1000) {
    unlockedKey = null
    console.log('Vault auto-locked (idle)')
  }
}, 15 * 1000).unref?.()

function vaultState() {
  return {
    enabled: vaultEnabled(),
    locked: isLocked(),
    autoLockMinutes: autoLockMinutes(),
    autoLockRemaining: autoLockRemaining(),
  }
}

// ---- Vault ----
app.get('/api/vault/status', (req, res) => {
  res.json(vaultState())
})

app.post('/api/vault/setup', (req, res) => {
  const { passphrase } = req.body || {}
  if (!passphrase || passphrase.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (мин. 4 символа)' })
  }
  if (vaultEnabled()) {
    return res.status(400).json({ error: 'Хранилище уже защищено' })
  }
  const salt = generateSalt()
  const key = deriveKey(passphrase, salt)
  setMeta('vault_salt', salt)
  setMeta('vault_verifier', makeVerifier(key))
  setMeta('vault_enabled', '1')
  reencryptAll(null, key)
  unlockedKey = key
  touch()
  res.json({ ...vaultState(), keys: listKeys(encKey()), activeKeyId: getActiveKeyId() })
})

app.post('/api/vault/unlock', (req, res) => {
  const { passphrase } = req.body || {}
  if (!vaultEnabled()) return res.status(400).json({ error: 'Хранилище не настроено' })
  const { salt, verifier } = getVault()
  const key = deriveKey(passphrase || '', salt)
  if (!checkVerifier(verifier, key)) {
    return res.status(401).json({ error: 'Неверный пароль' })
  }
  unlockedKey = key
  touch()
  res.json({ ...vaultState(), keys: listKeys(encKey()), activeKeyId: getActiveKeyId() })
})

app.post('/api/vault/lock', (req, res) => {
  unlockedKey = null
  res.json(vaultState())
})

app.post('/api/vault/change', (req, res) => {
  if (isLocked()) return res.status(423).json({ error: 'Сначала разблокируйте хранилище' })
  const { passphrase } = req.body || {}
  if (!passphrase || passphrase.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (мин. 4 символа)' })
  }
  const salt = generateSalt()
  const newKey = deriveKey(passphrase, salt)
  reencryptAll(unlockedKey, newKey)
  setMeta('vault_salt', salt)
  setMeta('vault_verifier', makeVerifier(newKey))
  unlockedKey = newKey
  touch()
  res.json(vaultState())
})

app.post('/api/vault/disable', (req, res) => {
  if (!vaultEnabled()) return res.json(vaultState())
  if (isLocked()) return res.status(423).json({ error: 'Сначала разблокируйте хранилище' })
  reencryptAll(unlockedKey, null)
  delMeta('vault_salt')
  delMeta('vault_verifier')
  setMeta('vault_enabled', '0')
  unlockedKey = null
  res.json({ ...vaultState(), keys: listKeys(null), activeKeyId: getActiveKeyId() })
})

// Настроить автоблокировку (минуты, 0 = выкл)
app.post('/api/vault/autolock', (req, res) => {
  const { minutes } = req.body || {}
  setAutoLockMinutes(minutes)
  touch()
  res.json(vaultState())
})

// ---- Зашифрованный бэкап БД ----
app.get('/api/vault/backup', (req, res) => {
  const v = getVault()
  res.json({
    type: 'browserai-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    encrypted: vaultEnabled(),
    vault: vaultEnabled()
      ? { salt: v.salt, verifier: v.verifier, autoLockMinutes: autoLockMinutes() }
      : null,
    keys: dumpRawKeys(),
    params: getParams(),
  })
})

app.post('/api/vault/restore', (req, res) => {
  const b = req.body || {}
  if (b.type !== 'browserai-backup' || !Array.isArray(b.keys)) {
    return res.status(400).json({ error: 'Неверный формат бэкапа' })
  }
  restoreRawKeys(b.keys)
  if (b.params) setParams(b.params)
  if (b.encrypted && b.vault?.salt && b.vault?.verifier) {
    setMeta('vault_salt', b.vault.salt)
    setMeta('vault_verifier', b.vault.verifier)
    setMeta('vault_enabled', '1')
    setAutoLockMinutes(b.vault.autoLockMinutes || 0)
    unlockedKey = null // потребуется разблокировка
  } else {
    delMeta('vault_salt')
    delMeta('vault_verifier')
    setMeta('vault_enabled', '0')
    unlockedKey = null
  }
  res.json({
    ...vaultState(),
    keys: listKeys(encKey()),
    activeKeyId: getActiveKeyId(),
    params: getParams(),
  })
})

// Защита: операции с ключами требуют разблокировки, если хранилище включено
function requireUnlocked(req, res, next) {
  if (isLocked()) {
    return res.status(423).json({ error: 'Хранилище заблокировано', locked: true })
  }
  touch()
  next()
}

// ---- Settings (ключи + параметры) ----
app.get('/api/settings', (req, res) => {
  res.json({
    keys: listKeys(encKey()),
    activeKeyId: getActiveKeyId(),
    params: getParams(),
    vault: vaultState(),
  })
})

app.get('/api/keys', (req, res) => {
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys', requireUnlocked, (req, res) => {
  const k = req.body || {}
  if (!k.id) return res.status(400).json({ error: 'id required' })
  upsertKey(
    {
      id: k.id,
      name: k.name || '',
      baseUrl: k.baseUrl || '',
      apiKey: k.apiKey || '',
      model: k.model || '',
      availableModels: Array.isArray(k.availableModels) ? k.availableModels : [],
    },
    encKey(),
  )
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.delete('/api/keys/:id', requireUnlocked, (req, res) => {
  deleteKey(req.params.id)
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys/:id/activate', (req, res) => {
  setActiveKey(req.params.id)
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys/import', requireUnlocked, (req, res) => {
  const { keys = [], activeKeyId = null } = req.body || {};
  
  // Валидация: keys должен быть массивом
  if (!Array.isArray(keys)) {
    return res.status(400).json({ error: 'keys must be an array' });
  }
  
  // Валидация каждого ключа
  for (const key of keys) {
    if (!key.id || typeof key.id !== 'string') {
      return res.status(400).json({ error: 'Each key must have a string id' });
    }
    if (key.name !== undefined && typeof key.name !== 'string') {
      return res.status(400).json({ error: 'key.name must be string' });
    }
    if (key.baseUrl !== undefined && typeof key.baseUrl !== 'string') {
      return res.status(400).json({ error: 'key.baseUrl must be string' });
    }
    if (key.apiKey !== undefined && typeof key.apiKey !== 'string') {
      return res.status(400).json({ error: 'key.apiKey must be string' });
    }
    if (key.model !== undefined && typeof key.model !== 'string') {
      return res.status(400).json({ error: 'key.model must be string' });
    }
  }
  
  // Валидация activeKeyId (если указан)
  if (activeKeyId !== null && typeof activeKeyId !== 'string') {
    return res.status(400).json({ error: 'activeKeyId must be string or null' });
  }
  
  replaceKeys(keys, activeKeyId, encKey());
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() });
})

app.get('/api/keys/export', requireUnlocked, (req, res) => {
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId() })
})

app.put('/api/params', (req, res) => {
  res.json({ params: setParams(req.body || {}) })
})

// ---- Проверка валидности ключа (исправлена от SSRF) ----
app.post('/api/validate', async (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {}
  if (!baseUrl || !apiKey) {
    return res.json({ ok: false, message: 'Укажите Base URL и ключ', models: [], preferredModel: '' })
  }

  // Блокировка private IP и localhost
  let hostname
  try {
    const url = new URL(baseUrl)
    hostname = url.hostname
  } catch {
    return res.json({ ok: false, message: 'Invalid URL' })
  }
  if (isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
    return res.json({ ok: false, message: 'Access to internal networks is not allowed' })
  }

  const root = String(baseUrl).replace(/\/$/, '')

  try {
    const modelsResult = await fetchModels(baseUrl, apiKey, model)
    if (modelsResult.ok) {
      return res.json({
        ok: true,
        message: modelsResult.models.length
          ? `Ключ валиден · моделей: ${modelsResult.models.length}`
          : 'Ключ валиден',
        models: modelsResult.models,
        preferredModel: modelsResult.preferredModel || model || '',
      })
    }
    if (modelsResult.status === 401 || modelsResult.status === 403) {
      return res.json({
        ok: false,
        message: `Ключ отклонён (${modelsResult.status})`,
        models: modelsResult.models || [],
        preferredModel: '',
      })
    }
  } catch {
    /* пробуем chat ниже */
  }

  try {
    const r = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    })
    if (r.ok) {
      return res.json({
        ok: true,
        message: 'Ключ валиден',
        models: model ? [model] : [],
        preferredModel: model || '',
      })
    }
    if (r.status === 401 || r.status === 403) {
      return res.json({ ok: false, message: `Ключ отклонён (${r.status})`, models: [], preferredModel: '' })
    }
    let detail = ''
    try {
      const j = await r.json()
      detail = j?.error?.message || ''
    } catch {
      /* ignore */
    }
    return res.json({
      ok: false,
      message: `Ошибка ${r.status}${detail ? ': ' + detail : ''}`,
      models: [],
      preferredModel: '',
    })
  } catch (e) {
    return res.json({
      ok: false,
      message: 'Не удалось проверить: ' + (e.message || 'сеть'),
      models: [],
      preferredModel: '',
    })
  }
})

// ---- Server Workspace (с частичной защитой, но основное в workspace.js) ----
app.get('/api/workspace/tree', async (req, res) => {
  try {
    const showHidden = String(req.query.hidden || '0') === '1'
    const tree = await getWorkspaceTree(showHidden)
    res.json({ tree })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать workspace' })
  }
})

app.get('/api/workspace/file', async (req, res) => {
  try {
    const file = await readWorkspaceFile(req.query.path || '')
    res.json(file)
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать файл' })
  }
})

app.get('/api/workspace/download', async (req, res) => {
  try {
    const rel = String(req.query.path || '')
    const stat = await statWorkspaceItem(rel)

    if (stat.isDirectory) {
      const folderFull = safePath(rel)
      const folderName = path.basename(rel) || 'workspace'
      const zip = new AdmZip()
      zip.addLocalFolder(folderFull, folderName)
      const buffer = zip.toBuffer()
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(folderName)}.zip"`,
      )
      res.setHeader('Content-Type', 'application/zip')
      res.end(buffer)
      return
    }

    if (stat.isFile) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(getDownloadName(rel))}"`,
      )
      res.setHeader('Content-Type', 'application/octet-stream')
      streamWorkspaceFile(rel).pipe(res)
      return
    }

    res.status(400).json({ error: 'Path is neither file nor directory' })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to download' })
  }
})

app.post('/api/workspace/folder', async (req, res) => {
  try {
    const { parentPath = '', name = 'New Folder' } = req.body || {}
    await createFolder(parentPath, name)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось создать папку' })
  }
})

app.post('/api/workspace/file', async (req, res) => {
  try {
    const { parentPath = '', name = 'untitled.txt', content = '' } = req.body || {}
    await createFile(parentPath, name, content)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось создать файл' })
  }
})

app.put('/api/workspace/file', async (req, res) => {
  try {
    const { path, content = '' } = req.body || {}
    if (!path) return res.status(400).json({ error: 'path required' })
    await writeFileContent(path, content)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось сохранить файл' })
  }
})

app.post('/api/workspace/rename', async (req, res) => {
  try {
    const { path, newName } = req.body || {}
    if (!path || !newName) return res.status(400).json({ error: 'path and newName required' })
    await renameItem(path, newName)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось переименовать' })
  }
})

app.post('/api/workspace/move', async (req, res) => {
  try {
    const { sourcePath, targetDirPath = '' } = req.body || {}
    if (!sourcePath) return res.status(400).json({ error: 'sourcePath required' })
    await moveItem(sourcePath, targetDirPath)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось переместить' })
  }
})

app.delete('/api/workspace/item', async (req, res) => {
  try {
    const { path } = req.body || {}
    if (!path) return res.status(400).json({ error: 'path required' })
    await deleteItem(path)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось удалить' })
  }
})

app.post('/api/workspace/upload', async (req, res) => {
  try {
    const { parentPath = '', files = [] } = req.body || {}
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files required' })
    }
    await uploadFiles(parentPath, files)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить файлы' })
  }
})

app.post('/api/workspace/upload-url', async (req, res) => {
  try {
    const { parentPath = '', url = '' } = req.body || {}
    if (!url) return res.status(400).json({ error: 'url required' })
    const result = await uploadFromUrl(parentPath, url)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить по URL' })
  }
})

app.get('/api/workspace/search', async (req, res) => {
  try {
    const q = String(req.query.q || '')
    const showHidden = String(req.query.hidden || '0') === '1'
    const results = await searchWorkspaceContent(q, showHidden)
    res.json({ results })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось выполнить поиск' })
  }
})

app.get('/api/workspace/history', async (req, res) => {
  try {
    const path = String(req.query.path || '')
    if (!path) return res.status(400).json({ error: 'path required' })
    const items = await getFileHistory(path)
    res.json({ items })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать историю файла' })
  }
})

app.post('/api/workspace/history/restore', async (req, res) => {
  try {
    const { path, revisionId } = req.body || {}
    if (!path || !revisionId) {
      return res.status(400).json({ error: 'path and revisionId required' })
    }
    await restoreFileRevision(path, revisionId)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось восстановить ревизию' })
  }
})

app.get('/api/web/search', async (req, res) => {
  try {
    const query = String(req.query.q || '')
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit || '5', 10) || 5))
    const results = await searchWeb(query, limit)
    res.json({ results })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось выполнить web search' })
  }
})

app.get('/api/web/fetch', async (req, res) => {
  try {
    const url = String(req.query.url || '')
    // Дополнительная защита от SSRF
    let hostname
    try {
      const urlObj = new URL(url)
      hostname = urlObj.hostname
    } catch {
      return res.status(400).json({ error: 'Invalid URL' })
    }
    if (isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
      return res.status(403).json({ error: 'Access to internal networks is not allowed' })
    }
    const page = await fetchWebPage(url)
    res.json(page)
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить web page' })
  }
})

app.get('/api/health', (req, res) => res.json({ ok: true }))

// доступно для расширений
void getActiveKeyDecrypted

// ---- Статика (production) ----
const distDir = join(__dirname, '..', 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(join(distDir, 'index.html'))
  })
}

try {
  await ensureWorkspaceRoot();
} catch (err) {
  console.error('FATAL: Failed to initialize workspace:', err.message);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`BrowserAI API + SQLite + Workspace на http://localhost:${PORT}`)
})