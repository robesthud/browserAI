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
import { buildSessionHeaders, getSiteProfile, applyBodyDefaults, isSessionUrl, buildProbeBody } from './stealthHeaders.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8787

function isPrivateIp(address) {
  if (!isIp(address)) return false
  const addr = ipaddr.parse(address)
  return addr.range() !== 'unicast' || addr.isLoopback() || addr.isLinkLocal()
}

// Rate limiting: 100 запросов на IP за 15 минут (общий)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down' },
})

// #5 FIX: строгий лимит для auth-эндпоинтов — не более 10 попыток за 15 минут
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts, try again later' },
  skipSuccessfulRequests: true,
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
      imgSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      workerSrc: ["'self'", 'blob:'],
      upgradeInsecureRequests: [],
    },
  },
}))
app.use(limiter)
// #7 FIX: CORS — в production только для своего домена
// APP_URL объявляется ниже, поэтому читаем из env напрямую здесь
const _corsOrigin = process.env.CORS_ORIGIN
  || (process.env.APP_URL ? process.env.APP_URL : null)
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
const corsOptions = _corsOrigin
  ? { origin: _corsOrigin, credentials: true }
  : { origin: true, credentials: true }
app.use(cors(corsOptions))
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

// #3 FIX: используем HKDF для вывода ключа шифрования из AUTH_SECRET.
// HKDF добавляет контекстный info-параметр и salt, что безопаснее голого SHA-256.
function encryptionKey() {
  return crypto.hkdfSync(
    'sha256',
    Buffer.from(AUTH_SECRET, 'utf8'),
    Buffer.from('browserai-cloud-encryption-salt-v1', 'utf8'),
    Buffer.from('browserai-cloud-encryption', 'utf8'),
    32,
  )
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
    phone: row.phone || null,
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
      phone TEXT DEFAULT NULL,
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

    CREATE TABLE IF NOT EXISTS sms_codes (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone) WHERE phone IS NOT NULL;

    CREATE TABLE IF NOT EXISTS user_cloud_data (
      user_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- #11 FIX: явные индексы для быстрого поиска сессий и токенов сброса пароля
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
  `)
}
initAuthTables()

// Миграция: добавляем phone если столбца ещё нет (для существующих БД)
try {
  const cols = db.prepare('PRAGMA table_info(users)').all()
  if (!cols.some((c) => c.name === 'phone')) {
    db.exec('ALTER TABLE users ADD COLUMN phone TEXT DEFAULT NULL')
    console.log('Migration: added phone column to users')
  }
} catch { /* ignore */ }

// #20 FIX: периодическая очистка устаревших сессий и токенов сброса пароля
// Запускается каждый час, чтобы таблица sessions не росла бесконечно
function cleanExpiredSessions() {
  try {
    const ts = now()
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(ts)
    db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(ts)
    db.prepare('DELETE FROM sms_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(ts)
  } catch (e) {
    console.warn('Session cleanup error:', e.message)
  }
}
cleanExpiredSessions()
setInterval(cleanExpiredSessions, 60 * 60 * 1000)

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

// #4 FIX: строгая проверка сложности пароля
function validatePassword(password) {
  if (!password || password.length < 10) return 'Пароль должен быть не менее 10 символов'
  if (!/[A-Z]/.test(password)) return 'Пароль должен содержать хотя бы одну заглавную букву'
  if (!/[a-z]/.test(password)) return 'Пароль должен содержать хотя бы одну строчную букву'
  if (!/[0-9]/.test(password)) return 'Пароль должен содержать хотя бы одну цифру'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Пароль должен содержать хотя бы один спецсимвол'
  return null
}

// ---- Twilio SMS ----
function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_FROM
  )
}

function normalizePhone(raw = '') {
  // Приводим к формату +7XXXXXXXXXX или +1XXXXXXXXXX
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('8') && digits.length === 11) return '+7' + digits.slice(1)
  if (digits.startsWith('7') && digits.length === 11) return '+' + digits
  if (digits.length >= 10) return '+' + digits
  return null
}

async function sendSmsCode(phone, code) {
  if (!twilioConfigured()) {
    // В dev-режиме просто логируем код
    console.log(`[SMS DEV] Phone: ${phone} Code: ${code}`)
    return
  }
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_FROM

  const body = `BrowserAI: ваш код сброса пароля: ${code}. Действует 10 минут.`
  const params = new URLSearchParams({ To: phone, From: from, Body: body })

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(`Twilio error: ${err.message || response.status}`)
  }
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

app.post('/api/auth/register', authLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254)
  const name = String(req.body?.name || '').trim().slice(0, 100)
  const password = String(req.body?.password || '')
  const registrationSecret = String(req.body?.registrationSecret || '')
  const rawPhone = String(req.body?.phone || '').trim().slice(0, 20)
  const phone = rawPhone ? normalizePhone(rawPhone) : null

  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Некорректный email' })
  if (rawPhone && !phone) return res.status(400).json({ error: 'Некорректный номер телефона' })
  const pwError = validatePassword(password)
  if (pwError) return res.status(400).json({ error: pwError })

  const usersCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count
  if (usersCount > 0) {
    const required = process.env.REGISTRATION_SECRET || ''
    if (!required || registrationSecret !== required) {
      return res.status(403).json({ error: 'Регистрация закрыта. Первый пользователь уже создан.' })
    }
  }

  if (phone) {
    const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ? LIMIT 1').get(phone)
    if (existingPhone) return res.status(409).json({ error: 'Этот номер уже используется' })
  }

  const id = uidAuth()
  const role = usersCount === 0 ? 'owner' : 'user'
  try {
    db.prepare('INSERT INTO users (id, email, name, phone, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, email, name, phone, passwordHash(password), role, now(), now())
    createSession(res, id)
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id)
    res.json({ user: publicUser(user) })
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Email уже зарегистрирован' })
    res.status(500).json({ error: 'Не удалось зарегистрировать пользователя' })
  }
})

app.post('/api/auth/login', authLimiter, (req, res) => {
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

// ---- SMS сброс пароля ----

// Шаг 1: ввести телефон → получить SMS с кодом
app.post('/api/auth/sms-send', authLimiter, async (req, res) => {
  const rawPhone = String(req.body?.phone || '').trim()
  const phone = normalizePhone(rawPhone)
  if (!phone) return res.status(400).json({ error: 'Некорректный номер телефона' })

  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)
  // Отвечаем одинаково чтобы не раскрывать есть ли пользователь
  if (!user) {
    return res.json({ ok: true, message: 'Если номер зарегистрирован, код отправлен' })
  }

  // Генерируем 6-значный код
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const codeHash = sha256(code)
  const expiresAt = now() + 10 * 60 * 1000 // 10 минут

  // Удаляем старые коды для этого телефона
  db.prepare('DELETE FROM sms_codes WHERE phone = ?').run(phone)
  db.prepare('INSERT INTO sms_codes (id, phone, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uidAuth(), phone, codeHash, expiresAt, now())

  try {
    await sendSmsCode(phone, code)
    res.json({ ok: true, message: 'Код отправлен на ваш номер' })
  } catch (e) {
    console.error('SMS send error:', e.message)
    res.status(503).json({ error: 'Не удалось отправить SMS. Попробуйте позже.' })
  }
})

// Шаг 2: ввести код из SMS → получить временный токен для смены пароля
app.post('/api/auth/sms-verify', authLimiter, (req, res) => {
  const rawPhone = String(req.body?.phone || '').trim()
  const code = String(req.body?.code || '').trim()
  const phone = normalizePhone(rawPhone)

  if (!phone || !code) return res.status(400).json({ error: 'Укажите телефон и код' })

  const codeHash = sha256(code)
  const row = db.prepare(
    'SELECT * FROM sms_codes WHERE phone = ? AND code_hash = ? AND expires_at > ? AND used_at IS NULL'
  ).get(phone, codeHash, now())

  if (!row) return res.status(400).json({ error: 'Неверный или устаревший код' })

  // Помечаем код использованным
  db.prepare('UPDATE sms_codes SET used_at = ? WHERE id = ?').run(now(), row.id)

  // Ищем пользователя
  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' })

  // Создаём временный токен для смены пароля (действует 15 минут)
  const resetToken = crypto.randomBytes(32).toString('base64url')
  db.prepare(
    'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uidAuth(), user.id, sha256(resetToken), now() + 15 * 60 * 1000, now())

  res.json({ ok: true, resetToken })
})

// Обновить телефон (когда пользователь залогинен)
app.put('/api/auth/phone', requireAuth, (req, res) => {
  const rawPhone = String(req.body?.phone || '').trim()
  const phone = rawPhone ? normalizePhone(rawPhone) : null

  if (rawPhone && !phone) return res.status(400).json({ error: 'Некорректный номер телефона' })

  // Проверяем что телефон не занят другим пользователем
  if (phone) {
    const existing = db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, req.user.id)
    if (existing) return res.status(409).json({ error: 'Этот номер уже используется' })
  }

  db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?').run(phone, now(), req.user.id)
  res.json({ ok: true })
})

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
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

app.post('/api/auth/reset-password', authLimiter, (req, res) => {
  const token = String(req.body?.token || '')
  const password = String(req.body?.password || '')
  const pwError = validatePassword(password)
  if (pwError) return res.status(400).json({ error: pwError })
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
  if (!row) return res.json({ data: null, updatedAt: null })
  try {
    res.json({ data: decryptJson(row.payload), updatedAt: row.updated_at || null })
  } catch {
    // Данные в БД испорчены или зашифрованы другим ключом — возвращаем пусто
    res.json({ data: null, updatedAt: row.updated_at || null })
  }
})

app.put('/api/cloud', requireAuth, (req, res) => {
  // Лимит: не более 500 чатов, не более 200 сообщений на чат
  const MAX_CHATS = 500
  const MAX_MESSAGES_PER_CHAT = 200
  let chats = Array.isArray(req.body?.chats) ? req.body.chats : []
  if (chats.length > MAX_CHATS) chats = chats.slice(0, MAX_CHATS)
  chats = chats.map((c) => ({
    ...c,
    messages: Array.isArray(c.messages)
      ? c.messages.slice(0, MAX_MESSAGES_PER_CHAT)
      : [],
  }))

  const data = {
    settings: req.body?.settings || null,
    chats,
  }

  // Лимит на итоговый размер payload: 5 МБ
  const raw = JSON.stringify(data)
  if (raw.length > 5 * 1024 * 1024) {
    return res.status(413).json({ error: 'Cloud payload слишком большой (макс. 5 МБ)' })
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
app.get('/api/vault/status', requireAuth, (req, res) => {
  res.json(vaultState())
})

app.post('/api/vault/setup', requireAuth, (req, res) => {
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

app.post('/api/vault/unlock', requireAuth, (req, res) => {
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

app.post('/api/vault/lock', requireAuth, (req, res) => {
  unlockedKey = null
  res.json(vaultState())
})

app.post('/api/vault/change', requireAuth, (req, res) => {
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

app.post('/api/vault/disable', requireAuth, (req, res) => {
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
app.post('/api/vault/autolock', requireAuth, (req, res) => {
  const { minutes } = req.body || {}
  setAutoLockMinutes(minutes)
  touch()
  res.json(vaultState())
})

// ---- Зашифрованный бэкап БД ----
app.get('/api/vault/backup', requireAuth, (req, res) => {
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

app.post('/api/vault/restore', requireAuth, (req, res) => {
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
// #2 FIX: защита настроек и ключей — требуем авторизацию
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    keys: listKeys(encKey()),
    activeKeyId: getActiveKeyId(),
    params: getParams(),
    vault: vaultState(),
  })
})

app.get('/api/keys', requireAuth, (req, res) => {
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys', requireAuth, requireUnlocked, (req, res) => {
  const k = req.body || {}
  if (!k.id || typeof k.id !== 'string') return res.status(400).json({ error: 'id required' })
  // Лимиты на длину полей ключа
  const name = String(k.name || '').slice(0, 100)
  const baseUrl = String(k.baseUrl || '').slice(0, 500)
  const apiKey = String(k.apiKey || '').slice(0, 2000)  // токены могут быть длинными
  const model = String(k.model || '').slice(0, 200)
  const availableModels = Array.isArray(k.availableModels)
    ? k.availableModels.slice(0, 200).map((m) => String(m || '').slice(0, 200))
    : []
  // ИСПРАВЛЕНО: сохраняем authType, authHeader, responsePath
  const authType = ['bearer', 'cookie', 'custom'].includes(k.authType) ? k.authType : 'bearer'
  const authHeader = String(k.authHeader || '').slice(0, 200)
  const responsePath = String(k.responsePath || '').slice(0, 200)
  // extraHeaders: объект доп. заголовков { 'Referer': '...', 'x-app-version': '...' }
  const rawExtra = k.extraHeaders
  const extraHeaders = (rawExtra && typeof rawExtra === 'object' && !Array.isArray(rawExtra))
    ? Object.fromEntries(
        Object.entries(rawExtra)
          .filter(([hk]) => !['host','content-length','transfer-encoding'].includes(String(hk).toLowerCase()))
          .map(([hk, hv]) => [String(hk).slice(0, 100), String(hv).slice(0, 500)])
          .slice(0, 20)
      )
    : {}

  upsertKey(
    { id: k.id.slice(0, 100), name, baseUrl, apiKey, model, availableModels, authType, authHeader, responsePath, extraHeaders },
    encKey()
  )
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.delete('/api/keys/:id', requireAuth, requireUnlocked, (req, res) => {
  deleteKey(req.params.id)
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys/:id/activate', requireAuth, (req, res) => {
  setActiveKey(req.params.id)
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys/import', requireAuth, requireUnlocked, (req, res) => {
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

app.get('/api/keys/export', requireAuth, requireUnlocked, (req, res) => {
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId() })
})

app.put('/api/params', requireAuth, (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  // Валидация temperature: допустимый диапазон 0..2 (как у OpenAI API)
  if (body.temperature !== undefined) {
    const t = Number(body.temperature)
    if (Number.isNaN(t) || t < 0 || t > 2) {
      return res.status(400).json({ error: 'temperature должен быть от 0 до 2' })
    }
    body.temperature = t
  }
  // Принудительно приводим булевые поля к boolean
  if (body.stream !== undefined) body.stream = Boolean(body.stream)
  if (body.useWebAI !== undefined) body.useWebAI = Boolean(body.useWebAI)
  // Лимит на длину systemPrompt: 8000 символов
  if (body.systemPrompt !== undefined) {
    body.systemPrompt = String(body.systemPrompt || '').slice(0, 8000)
  }
  res.json({ params: setParams(body) })
})

// ---- Проверка валидности ключа ----
// Для всех сессионных токенов (cookie/custom/bearer-JWT) — stealthHeaders + probe /chat/completions
// Для обычных API-ключей — /models + probe /chat/completions
app.post('/api/validate', requireAuth, async (req, res) => {
  const {
    baseUrl, apiKey, model,
    authType = 'bearer',
    authHeader = '',
    extraHeaders = {},
  } = req.body || {}

  if (!baseUrl || !apiKey) {
    return res.json({ ok: false, message: 'Укажите Base URL и ключ', models: [], preferredModel: '' })
  }

  // SSRF-защита
  let hostname
  try { hostname = new URL(baseUrl).hostname } catch {
    return res.json({ ok: false, message: 'Неверный URL', models: [], preferredModel: '' })
  }
  if (isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
    return res.json({ ok: false, message: 'Доступ к внутренней сети запрещён', models: [], preferredModel: '' })
  }

  const root = String(baseUrl).replace(/\/$/, '')
  const profile = getSiteProfile(baseUrl)

  // ── Сессионный токен (cookie, custom заголовок, или bearer-JWT с известного сайта) ──
  // Признак сессии: authType !== bearer ИЛИ это известный веб-сайт (isBearerSession)
  const isSession = authType === 'cookie' || authType === 'custom' || profile.isBearerSession

  if (isSession) {
    const stealthH = buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders })
    const probeBody = buildProbeBody(baseUrl, model)

    try {
      const r = await fetch(`${root}/chat/completions`, {
        method: 'POST',
        headers: stealthH,
        body: JSON.stringify(probeBody),
        signal: AbortSignal.timeout(15000),
      })

      // 200, 400 (неверная модель/параметр) — токен принят сервером
      if (r.ok || r.status === 400) {
        return res.json({
          ok: true,
          message: `Сессионный токен принят (${r.status})`,
          models: model ? [model] : [],
          preferredModel: model || '',
        })
      }
      if (r.status === 401 || r.status === 403) {
        return res.json({
          ok: false,
          message: `Токен отклонён (${r.status}) — обнови токен в браузере`,
          models: [],
          preferredModel: '',
        })
      }
      if (r.status === 429) {
        return res.json({
          ok: false,
          message: 'Слишком много запросов (429) — подожди немного',
          models: [],
          preferredModel: '',
        })
      }
      return res.json({
        ok: false,
        message: `Сервер ответил ${r.status}`,
        models: [],
        preferredModel: '',
      })
    } catch (e) {
      const msg = e?.name === 'TimeoutError' ? 'Таймаут (15s) — сайт не ответил' : (e.message || 'Ошибка сети')
      return res.json({ ok: false, message: msg, models: [], preferredModel: '' })
    }
  }

  // ── Обычный API-ключ (bearer, официальный провайдер) ──
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
        models: [],
        preferredModel: '',
      })
    }
  } catch { /* пробуем chat ниже */ }

  // Fallback — probe через /chat/completions
  try {
    const stealthH = buildSessionHeaders({ baseUrl, apiKey, authType: 'bearer', authHeader: '', extraHeaders })
    const r = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: stealthH,
      body: JSON.stringify({
        model:     model || 'gpt-4o-mini',
        messages:  [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        stream:    false,
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (r.ok) {
      return res.json({ ok: true, message: 'Ключ валиден', models: model ? [model] : [], preferredModel: model || '' })
    }
    if (r.status === 401 || r.status === 403) {
      return res.json({ ok: false, message: `Ключ отклонён (${r.status})`, models: [], preferredModel: '' })
    }
    let detail = ''
    try { detail = (await r.json())?.error?.message || '' } catch { /* ignore */ }
    return res.json({ ok: false, message: `Ошибка ${r.status}${detail ? ': ' + detail : ''}`, models: [], preferredModel: '' })
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? 'Таймаут — сервер не ответил' : ('Ошибка: ' + (e.message || 'сеть'))
    return res.json({ ok: false, message: msg, models: [], preferredModel: '' })
  }
})

// ---- Server Workspace ----
// #1 FIX: все workspace-эндпоинты требуют авторизации через requireAuth
app.get('/api/workspace/tree', requireAuth, async (req, res) => {
  try {
    const showHidden = String(req.query.hidden || '0') === '1'
    const tree = await getWorkspaceTree(showHidden)
    res.json({ tree })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать workspace' })
  }
})

app.get('/api/workspace/file', requireAuth, async (req, res) => {
  try {
    const file = await readWorkspaceFile(req.query.path || '')
    res.json(file)
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать файл' })
  }
})

app.get('/api/workspace/download', requireAuth, async (req, res) => {
  try {
    const rel = String(req.query.path || '')
    // Запрещаем скачивание корня workspace целиком — потенциальный DoS
    if (!rel || rel === '.' || rel === '/') {
      return res.status(400).json({ error: 'Укажите конкретный файл или папку для скачивания' })
    }
    const stat = await statWorkspaceItem(rel)

    if (stat.isDirectory) {
      const folderFull = safePath(rel)
      const folderName = path.basename(rel) || 'folder'
      const zip = new AdmZip()
      zip.addLocalFolder(folderFull, folderName)
      const buffer = zip.toBuffer()
      // Лимит: не отдаём ZIP больше 200 МБ
      if (buffer.length > 200 * 1024 * 1024) {
        return res.status(413).json({ error: 'Папка слишком большая для скачивания (макс. 200 МБ)' })
      }
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
      const stream = streamWorkspaceFile(rel)
      stream.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ error: 'Ошибка при чтении файла' })
        else res.destroy(err)
      })
      stream.pipe(res)
      return
    }

    res.status(400).json({ error: 'Path is neither file nor directory' })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to download' })
  }
})

app.post('/api/workspace/folder', requireAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Тело запроса должно быть объектом JSON' })
    }
    const { parentPath = '', name = 'New Folder' } = req.body
    const cleanName = String(name).trim()
    if (!cleanName || cleanName === '.' || cleanName === '..') return res.status(400).json({ error: 'Недопустимое имя папки' })
    if (cleanName.length > 255) return res.status(400).json({ error: 'Имя папки слишком длинное (макс. 255)' })
    await createFolder(parentPath, cleanName)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось создать папку' })
  }
})

app.post('/api/workspace/file', requireAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Тело запроса должно быть объектом JSON' })
    }
    const { parentPath = '', name = 'untitled.txt', content = '' } = req.body
    const cleanName = String(name).trim()
    if (!cleanName || cleanName === '.' || cleanName === '..') return res.status(400).json({ error: 'Недопустимое имя файла' })
    if (cleanName.length > 255) return res.status(400).json({ error: 'Имя файла слишком длинное (макс. 255)' })
    await createFile(parentPath, cleanName, content)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось создать файл' })
  }
})

app.put('/api/workspace/file', requireAuth, async (req, res) => {
  try {
    const { path, content = '' } = req.body || {}
    if (!path) return res.status(400).json({ error: 'path required' })
    await writeFileContent(path, content)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось сохранить файл' })
  }
})

app.post('/api/workspace/rename', requireAuth, async (req, res) => {
  try {
    const { path, newName } = req.body || {}
    if (!path || !newName) return res.status(400).json({ error: 'path and newName required' })
    await renameItem(path, newName)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось переименовать' })
  }
})

app.post('/api/workspace/move', requireAuth, async (req, res) => {
  try {
    const { sourcePath, targetDirPath = '' } = req.body || {}
    if (!sourcePath) return res.status(400).json({ error: 'sourcePath required' })
    await moveItem(sourcePath, targetDirPath)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось переместить' })
  }
})

app.delete('/api/workspace/item', requireAuth, async (req, res) => {
  try {
    const { path } = req.body || {}
    if (!path) return res.status(400).json({ error: 'path required' })
    await deleteItem(path)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось удалить' })
  }
})

app.post('/api/workspace/upload', requireAuth, async (req, res) => {
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

app.post('/api/workspace/upload-url', requireAuth, async (req, res) => {
  try {
    const { parentPath = '', url = '' } = req.body || {}
    if (!url) return res.status(400).json({ error: 'url required' })
    const result = await uploadFromUrl(parentPath, url)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить по URL' })
  }
})

app.get('/api/workspace/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '')
    const showHidden = String(req.query.hidden || '0') === '1'
    const results = await searchWorkspaceContent(q, showHidden)
    res.json({ results })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось выполнить поиск' })
  }
})

app.get('/api/workspace/history', requireAuth, async (req, res) => {
  try {
    const path = String(req.query.path || '')
    if (!path) return res.status(400).json({ error: 'path required' })
    const items = await getFileHistory(path)
    res.json({ items })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать историю файла' })
  }
})

app.post('/api/workspace/history/restore', requireAuth, async (req, res) => {
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

app.get('/api/web/search', requireAuth, async (req, res) => {
  try {
    const query = String(req.query.q || '')
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit || '5', 10) || 5))
    const results = await searchWeb(query, limit)
    res.json({ results })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось выполнить web search' })
  }
})

app.get('/api/web/fetch', requireAuth, async (req, res) => {
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

// Удаление своего аккаунта (залогиненный пользователь)
app.delete('/api/auth/account', requireAuth, (req, res) => {
  const userId = req.user.id
  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  clearSessionCookie(res)
  res.json({ ok: true })
})



// #6 FIX: удалён мёртвый код «void getActiveKeyDecrypted»
// Функция импортирована из db.js и доступна в модуле напрямую, если понадобится.

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