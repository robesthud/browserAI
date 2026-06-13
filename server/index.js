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
import logger from './logger.js'
import { isBlockedHost } from './ssrf.js'
import AdmZip from 'adm-zip'
import path from 'node:path'
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readdirSync, readFileSync, createReadStream as fsCreateReadStream } from 'node:fs'
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
  getActiveKeyDecrypted,
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
  fileNameToMime,
  getWorkspaceMetadata,
  listRecentWorkspaceActivity,
  readProjectRules,
  safePath,
  withWorkspaceScope,
  deleteWorkspaceScope,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'
// gateway.js (free-gateway routing) удалён вместе с gemini-web-proxy.
// retryVideoJob удалён вместе с gemini_video runner.
import { createJob, getJob, initJobs, listJobs, startJob, cancelJob, retryJob, registerRuntimeInput } from './jobs.js'
import { initAgentWorkflows, listAutomationRecipes, createWorkflow, startWorkflow, getWorkflow, listWorkflows, cancelWorkflow, retryWorkflow } from './agentWorkflows.js'
import { getAutomationPolicy, listAutomationPolicyEvents } from './automationPolicy.js'
import { initIncidents, listIncidents, getIncident, resolveIncident, createIncident, createIncidentWorkflow } from './incidents.js'
import { getAgentControlPlane } from './agentControlPlane.js'
import { initOperatorMode, getOperatorStatus, listOperatorProjects, upsertOperatorProject, startOperatorMission, listOperatorMissions, getOperatorMission } from './operatorMode.js'
import { getOperatorCodeTask, listOperatorCodeTasks } from './operatorCode.js'
import { listOpsServices, runOpsAction, readOpsAudit } from './ops.js'
import { buildSessionHeaders, getSiteProfile, applyBodyDefaults, getChatUrl } from './stealthHeaders.js'

import { isDeepSeekWebUrl, handleDeepSeekWebChat, validateDeepSeekWebKey } from './deepseekWeb.js'
import {
  bootstrap as bootstrapDeepSeekSession,
  getSessionState as getDeepSeekState,
  getActiveBearer as getDeepSeekBearer,
  getCookieHeader as getDeepSeekCookieHeader,
  getCachedModels as getDeepSeekModels,
  refreshNow as refreshDeepSeekNow,
  setSession as setDeepSeekSession,
} from './deepseekTokenRefresher.js'
import { startTelegramBot } from './telegramBot.js'
import { runAgent, listActiveAgentRuns, clearActiveAgentRun } from './agentLoop.js'
import { listDeterministicActions } from './deterministicActionRouter.js'
import { getAgentTask, latestAgentTask, listAgentTasks, buildResumeSystemMessage } from './agentTasks.js'
import {
  callLLM, callLLMStream, isAnthropicOfficialUrl, isGoogleGenerativeNativeUrl,
  getProviderCapabilities, normalizeProviderError, fetchViaProxy,
} from './llmClient.js'
import { sandboxHealth } from './agentSandbox.js'
import { browserHealth } from './browserTools.js'
import { answerQuestion, cancelQuestion, listPendingQuestions, getPendingQuestion } from './askUserRegistry.js'


const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8787

// Версия веб-приложения. Берём из package.json один раз при старте, потому что
// process.env.npm_package_version пуст при запуске через `node server/index.js`
// (без npm). Раньше из-за этого /api/app-version всегда отдавал захардкоженную
// устаревшую версию.
const APP_WEB_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    return pkg.version || process.env.npm_package_version || '0.0.0'
  } catch {
    return process.env.npm_package_version || '0.0.0'
  }
})()

// Rate limiting: 300 запросов на IP за 15 минут (общий)
// Увеличен с 100 до 300 т.к. чат-запросы теперь тоже идут через сервер
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
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

// HSTS is dangerous when the app is served over plain HTTP on a bare IP
// (no TLS on :443). Browsers cache `Strict-Transport-Security` for 180 days
// and silently rewrite every later `http://<ip>/...` to `https://<ip>/...`,
// which then fails with `NetworkError when attempting to fetch resource`
// (Firefox) or `ERR_CONNECTION_REFUSED` (Chrome) — even for /api/chat,
// /api/cloud, image uploads, etc. We saw exactly this symptom in prod when
// users hit http://186.246.31.78.
//
// Rule: only enable HSTS when APP_URL is https://… AND the host is a DNS
// name (not a raw IP). Otherwise turn it off so browsers never enter the
// upgrade-to-HTTPS trap.
function shouldEnableHsts() {
  const appUrl = String(process.env.APP_URL || '').trim()
  if (!appUrl.toLowerCase().startsWith('https://')) return false
  try {
    const host = new URL(appUrl).hostname
    // IPv4 literal or IPv6 literal in brackets → no HSTS.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false
    if (host.includes(':')) return false
    return true
  } catch {
    return false
  }
}
const HSTS_ENABLED = shouldEnableHsts()
if (!HSTS_ENABLED) {
  console.log('[security] HSTS disabled (APP_URL is plain http:// or a raw IP). Set APP_URL=https://<dns-name> to re-enable.')
}

app.use(helmet({
  // See shouldEnableHsts() above — false on http:// or bare IP, true on
  // https:// + DNS name. When false, helmet does NOT set the
  // Strict-Transport-Security header at all.
  hsts: HSTS_ENABLED,
  // COOP is only meaningful on potentially trustworthy origins (HTTPS or localhost).
  // On a bare http://IP deployment browsers ignore it and spam the console.
  crossOriginOpenerPolicy: HSTS_ENABLED ? { policy: 'same-origin' } : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      // Vite legacy builds inject small inline loader scripts. They are required
      // for older Android System WebView versions that do not support modules.
      scriptSrc: ["'self'", "'unsafe-inline'", 'data:', 'blob:'],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: null,
      objectSrc: ["'none'"],
      workerSrc: ["'self'", 'blob:'],
    },
  },
}))
app.use(limiter)
// #7 FIX: CORS — в production только для своего домена
// APP_URL объявляется ниже, поэтому читаем из env напрямую здесь
const _corsOrigin = process.env.CORS_ORIGIN
  || (process.env.APP_URL ? process.env.APP_URL : null)

// #40 FIX: More robust CORS origin matching.
// NOTE: this function MUST be passed as the `origin` option of cors(),
// i.e. cors({ origin: corsOptions }). If passed directly to cors(...),
// the package calls it with the request object instead of the Origin
// string and every request fails with "Not allowed by CORS".
const corsOptions = (origin, callback) => {
  const allowed = [_corsOrigin, process.env.APP_URL]
    .filter(Boolean)
    .map(a => String(a).replace(/\/$/, ''));

  // If APP_URL/CORS_ORIGIN is not configured in production, do NOT reject
  // requests with an Origin header. Vite emits <script crossorigin>, so
  // browsers may send Origin even for same-site static assets like
  // /assets/*.js. Rejecting here breaks the whole UI on bare-IP deploys.
  const isAllowed = !origin || allowed.length === 0 || allowed.some(a => {
    try {
      return typeof origin === 'string' && origin.replace(/\/$/, '').startsWith(a);
    } catch {
      return false;
    }
  });

  if (isAllowed || process.env.NODE_ENV !== 'production') {
    callback(null, true);
  } else {
    // Do not throw for disallowed origins: throwing turns simple static asset
    // requests into 500s. Return false CORS instead.
    callback(null, false);
  }
};

app.use(cors({ origin: corsOptions, credentials: true }))
app.use(express.json({ limit: '50mb', verify: (req, _res, buf) => { req.rawBody = buf } }))

// ---- Auth + encrypted cloud sync ----
const AUTH_COOKIE = 'browserai_session'
const SESSION_DAYS = 30
const APP_URL = (process.env.APP_URL
  || 'http://localhost:8787').replace(/\/$/, '')
const AUTH_SECRET = process.env.AUTH_SECRET
if (!AUTH_SECRET) {
  console.error('FATAL: AUTH_SECRET is not set. Set a long random string (≥32 chars) in .env or environment variable.')
  process.exit(1)
}
if (!process.env.AUTH_SECRET) {
  console.warn('⚠ AUTH_SECRET is not set. Set a long random AUTH_SECRET in the .env / environment for production.')
}

// Время старта процесса — отдаётся в /api/app-version как ориентир «когда задеплоено».
const DEPLOYED_AT = new Date().toISOString()

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
  // Only set Secure flag when actually behind HTTPS (APP_URL starts with https)
  const secure = process.env.NODE_ENV === 'production' && APP_URL.startsWith('https')
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
const sessionCleanupInterval = setInterval(cleanExpiredSessions, 60 * 60 * 1000)

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
      signal: AbortSignal.timeout(15000),
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
    throw new Error('SMTP не настроен. Добавьте SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM в окружение (.env).')
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
    signal: AbortSignal.timeout(15000),
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
  if (isBlockedHost(hostname)) {
    return { ok: false, status: 403, models: [], preferredModel: '', error: 'Access to internal networks is not allowed' }
  }

  const root = String(baseUrl).replace(/\/$/, '')
  const r = await fetch(`${root}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
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
app.get('/api/settings', requireAuth, async (req, res) => {
  const keys = listKeys(encKey())
  res.json({
    keys,
    activeKeyId: getActiveKeyId(),
    params: getParams(),
    vault: vaultState(),
  })
})

app.get('/api/keys', requireAuth, (req, res) => {
  const keys = listKeys(encKey())
  res.json({ keys, activeKeyId: getActiveKeyId(), vault: vaultState() })
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
    baseUrl, model,
    authType = 'bearer',
    authHeader = '',
    extraHeaders = {},
  } = req.body || {}
  let { apiKey } = req.body || {}
  let mergedExtraHeaders = extraHeaders

  // Managed DeepSeek: inject server-side token+cookies if client omits apiKey.
  if (isDeepSeekWebUrl(baseUrl) && (!apiKey || apiKey === '__managed__')) {
    const managedBearer = getDeepSeekBearer()
    const managedCookies = getDeepSeekCookieHeader()
    if (managedBearer) {
      apiKey = managedBearer
      mergedExtraHeaders = { ...(extraHeaders || {}) }
      if (managedCookies && !Object.keys(mergedExtraHeaders).some((k) => k.toLowerCase() === 'cookie')) {
        mergedExtraHeaders.Cookie = managedCookies
      }
    } else {
      return res.json({ ok: false, message: 'DeepSeek session is not configured on the server', models: [], preferredModel: '' })
    }
  }

  // free-gateway routing удалён вместе с gemini-web-proxy — DeepSeek
  // теперь обслуживается напрямую через handleDeepSeekWebChat (см. выше).

  if (!baseUrl || !apiKey) {
    return res.json({ ok: false, message: 'Укажите Base URL и ключ', models: [], preferredModel: '' })
  }

  // SSRF-защита
  let hostname
  try { hostname = new URL(baseUrl).hostname } catch {
    return res.json({ ok: false, message: 'Неверный URL', models: [], preferredModel: '' })
  }
  if (isBlockedHost(hostname)) {
    return res.json({ ok: false, message: 'Доступ к внутренней сети запрещён', models: [], preferredModel: '' })
  }


  const root = String(baseUrl).replace(/\/$/, '')
  const profile = getSiteProfile(baseUrl)

  // ── DeepSeek Web Experimental: это не OpenAI-compatible API.
  // Проверяем через создание chat_session, а не через /chat/completions.
  if (isDeepSeekWebUrl(baseUrl)) {
    const result = await validateDeepSeekWebKey({ baseUrl, apiKey, authType, authHeader, extraHeaders: mergedExtraHeaders, model })
    // Прикладываем кэшированный список managed-моделей если client пришёл без своих
    if (result?.ok && (!result.models || !result.models.length)) {
      const cached = getDeepSeekModels()
      if (cached?.length) {
        result.models = cached.map((m) => m.id)
        result.preferredModel = result.preferredModel || cached[0].id
      }
    }
    return res.json(result)
  }


  // ── Official Anthropic API (not OpenAI-compatible) ──────────────────────
  if (isAnthropicOfficialUrl(baseUrl)) {
    try {
      const r = await fetch(`${root}/models`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
        },
        signal: AbortSignal.timeout(15000),
      })
      const raw = await r.text()
      if (!r.ok) {
        return res.json({ ok: false, message: `Anthropic ответил ${r.status}: ${raw.slice(0, 300)}`, models: [], preferredModel: '' })
      }
      const data = JSON.parse(raw)
      const models = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : []
      const preferred = model && models.includes(model) ? model : (models.find((m) => /sonnet|opus|haiku/i.test(m)) || models[0] || model || '')
      return res.json({ ok: true, message: `Anthropic API ключ валиден · моделей: ${models.length}`, models, preferredModel: preferred })
    } catch (e) {
      return res.json({ ok: false, message: `Anthropic validate: ${e.message || 'ошибка'}`, models: [], preferredModel: '' })
    }
  }

  // ── Official Google Gemini GenerateContent API (not OpenAI-compatible) ──
  if (isGoogleGenerativeNativeUrl(baseUrl)) {
    try {
      const proxyUrl = process.env.CF_PROXY_URL || ''
      const proxySecret = process.env.CF_PROXY_SECRET || ''
      const targetUrl = `${root}/models?key=${encodeURIComponent(apiKey)}`
      let r
      if (proxyUrl) {
        r = await fetchViaProxy({ url: targetUrl, method: 'GET', proxyUrl, proxySecret, timeoutMs: 15000 })
      } else {
        r = await fetch(targetUrl, { signal: AbortSignal.timeout(15000) })
      }
      const raw = await r.text()
      if (!r.ok) {
        return res.json({ ok: false, message: `Google ответил ${r.status}: ${raw.slice(0, 300)}`, models: [], preferredModel: '' })
      }
      const data = JSON.parse(raw)
      const models = Array.isArray(data?.models)
        ? data.models
            .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map((m) => String(m.name || '').replace(/^models\//, ''))
            .filter(Boolean)
        : []
      const preferred = model && models.includes(String(model).replace(/^models\//, ''))
        ? String(model).replace(/^models\//, '')
        : (models.find((m) => /gemini-2\.5|gemini-2\.0|gemini-1\.5/i.test(m)) || models[0] || model || '')
      return res.json({ ok: true, message: `Google Gemini API ключ валиден · моделей: ${models.length}`, models, preferredModel: preferred })
    } catch (e) {
      return res.json({ ok: false, message: `Google validate: ${e.message || 'ошибка'}`, models: [], preferredModel: '' })
    }
  }

  // ── Сессионный токен (cookie, custom заголовок, или bearer-JWT с известного сайта) ──
  // Признак сессии: authType !== bearer ИЛИ это известный веб-сайт (isBearerSession)
  const isSession = authType === 'cookie' || authType === 'custom' || profile.isBearerSession

  if (isSession) {
    const stealthH = buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders })

    // Собираем список моделей-кандидатов для перебора
    const candidates = []
    if (model) candidates.push(model)
    if (Array.isArray(profile.modelCandidates)) {
      for (const c of profile.modelCandidates) {
        if (!candidates.includes(c)) candidates.push(c)
      }
    }
    if (candidates.length === 0) candidates.push('gpt-4o-mini')

    // Пробуем каждую модель — собираем работающие
    const workingModels = []
    let firstOkModel = ''
    let tokenRejected = false
    let lastStatus = 0

    // Используем CF прокси если доступен (решает гео-блокировку)
    const valProxyUrl = process.env.CF_PROXY_URL || ''
    const valProxySecret = process.env.CF_PROXY_SECRET || ''
    const useValProxy = Boolean(valProxyUrl)

    for (const candidateModel of candidates) {
      try {
        const probeBody = applyBodyDefaults({
          model:    candidateModel,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
          stream:   false,
        }, baseUrl)

        const probeTarget = getChatUrl(baseUrl)
        let r
        if (useValProxy) {
          r = await fetch(valProxyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(valProxySecret ? { 'X-Proxy-Key': valProxySecret } : {}),
            },
            body: JSON.stringify({ targetUrl: probeTarget, headers: stealthH, body: probeBody }),
            signal: AbortSignal.timeout(10000),
          })
        } else {
          r = await fetch(probeTarget, {
            method: 'POST',
            headers: stealthH,
            body: JSON.stringify(probeBody),
            signal: AbortSignal.timeout(10000),
          })
        }
        lastStatus = r.status

        if (r.status === 401 || r.status === 403) {
          tokenRejected = true
          break
        }
        if (r.status === 429) {
          // Rate limited — считаем что токен валиден, но не можем проверить модели
          if (workingModels.length === 0 && model) workingModels.push(model)
          break
        }

        if (r.ok) {
          // Пробуем извлечь реальное имя модели из ответа
          let realModel = candidateModel
          try {
            const body = await r.json()
            if (body?.model) realModel = body.model
          } catch { /* ignore parse errors */ }

          if (!workingModels.includes(realModel)) workingModels.push(realModel)
          // Также добавляем имя кандидата если отличается
          if (realModel !== candidateModel && !workingModels.includes(candidateModel)) {
            workingModels.push(candidateModel)
          }
          if (!firstOkModel) firstOkModel = realModel
        }
        // 400 — модель невалидна, пробуем следующую (не добавляем)
      } catch {
        // Таймаут одного кандидата — пробуем следующего
        continue
      }
    }

    if (tokenRejected) {
      return res.json({
        ok: false,
        message: `Токен отклонён (${lastStatus}) — обнови токен в браузере`,
        models: [],
        preferredModel: '',
      })
    }

    if (workingModels.length > 0) {
      return res.json({
        ok: true,
        message: `Сессионный токен принят · моделей: ${workingModels.length}`,
        models: workingModels,
        preferredModel: firstOkModel || workingModels[0],
      })
    }

    // Ничего не сработало
    return res.json({
      ok: false,
      message: lastStatus ? `Сервер ответил ${lastStatus} — ни одна модель не работает` : 'Не удалось подключиться',
      models: [],
      preferredModel: '',
    })
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

function workspaceChatIdFromReq(req) {
  return req.get('x-browserai-chat-id')
    || req.query?.chatId
    || req.body?.chatId
    || ''
}

app.use('/api/workspace', (req, _res, next) => {
  withWorkspaceScope(workspaceChatIdFromReq(req), () => next())
})

app.post('/api/workspace/chat/init', requireAuth, async (_req, res) => {
  try {
    await ensureWorkspaceRoot()
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось создать workspace чата' })
  }
})

app.delete('/api/workspace/chat', requireAuth, async (req, res) => {
  try {
    const chatId = workspaceChatIdFromReq(req)
    if (!chatId) return res.status(400).json({ error: 'chatId required' })
    await deleteWorkspaceScope(chatId)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось удалить workspace чата' })
  }
})

app.get('/api/workspace/metadata', requireAuth, async (req, res) => {
  try {
    const meta = await getWorkspaceMetadata()
    res.json({ metadata: meta })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать metadata workspace' })
  }
})

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
      const fileName = getDownloadName(rel)
      // Honour ?inline=1 so the same endpoint can be used as a <video>/<img>
      // src (browsers refuse to render `attachment` responses). Default stays
      // 'attachment' for backwards compatibility with the explicit "Download"
      // buttons.
      const inlineMode = /^(1|true|yes)$/i.test(String(req.query?.inline || ''))
      const mime = inlineMode ? fileNameToMime(fileName) : 'application/octet-stream'
      res.setHeader(
        'Content-Disposition',
        `${inlineMode ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`,
      )
      res.setHeader('Content-Type', mime)
      // Allow byte-range so HTML5 <video> can seek without re-downloading
      // the whole file (especially important for the Veo-generated mp4s,
      // which routinely run 10-30 MB).
      res.setHeader('Accept-Ranges', 'bytes')

      const full = safePath(rel)
      const range = req.headers.range
      if (range && stat.size > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0
          let end = m[2] ? parseInt(m[2], 10) : stat.size - 1
          if (Number.isNaN(start) || start < 0) start = 0
          if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1
          if (start > end) {
            res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end()
            return
          }
          res.status(206)
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
          res.setHeader('Content-Length', String(end - start + 1))
          const partial = fsCreateReadStream(full, { start, end })
          partial.on('error', (err) => {
            if (!res.headersSent) res.status(500).json({ error: 'Ошибка при чтении файла' })
            else res.destroy(err)
          })
          partial.pipe(res)
          return
        }
      }

      res.setHeader('Content-Length', String(stat.size))
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
    const { parentPath = '', url = '', branch = '', stripTopLevel } = req.body || {}
    if (!url) return res.status(400).json({ error: 'url required' })
    const result = await uploadFromUrl(parentPath, url, { branch, stripTopLevel })
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


// /api/gateway/* endpoints удалены вместе с gemini-web-proxy. DeepSeek
// managed теперь обслуживается через handleDeepSeekWebChat напрямую.

app.get('/api/ops/services', requireAuth, (_req, res) => {
  res.json({ services: listOpsServices() })
})

app.post('/api/ops/action', requireAuth, async (req, res) => {
  try {
    const { service, action, params = {}, confirm = false } = req.body || {}
    const result = await runOpsAction({ service, action, params, confirm })
    res.json({ ok: true, result })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'ops action failed' })
  }
})

app.get('/api/ops/audit', requireAuth, (req, res) => {
  res.json({ entries: readOpsAudit({ limit: req.query.limit || 100 }) })
})

// ── Public webhooks ────────────────────────────────────────────────────────
function getGithubWebhookSecret() {
  return process.env.GITHUB_WEBHOOK_SECRET || getMeta('github_webhook_secret') || ''
}

function verifyGithubWebhookSignature(req) {
  const secret = getGithubWebhookSecret()
  if (!secret) return process.env.GITHUB_WEBHOOK_SECRET_REQUIRED === '1' ? false : true
  const sig = String(req.get('x-hub-signature-256') || '')
  if (!sig.startsWith('sha256=')) return false
  const body = req.rawBody || Buffer.from(JSON.stringify(req.body || {}))
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) } catch { return false }
}

app.get('/api/webhooks/github/config', requireAuth, (req, res) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http'
  const host = req.get('host') || ''
  res.json({
    endpoint: `${proto}://${host}/api/webhooks/github`,
    configured: Boolean(getGithubWebhookSecret()),
    required: process.env.GITHUB_WEBHOOK_SECRET_REQUIRED === '1',
    source: process.env.GITHUB_WEBHOOK_SECRET ? 'env' : (getMeta('github_webhook_secret') ? 'db' : 'none'),
  })
})

app.post('/api/webhooks/github/secret', requireAuth, (_req, res) => {
  if (process.env.GITHUB_WEBHOOK_SECRET) return res.status(409).json({ ok: false, error: 'GITHUB_WEBHOOK_SECRET is configured via environment; rotate it in server env.' })
  const secret = crypto.randomBytes(32).toString('hex')
  setMeta('github_webhook_secret', secret)
  res.json({ ok: true, secret, configured: true })
})

app.post('/api/webhooks/github', async (req, res) => {
  if (!verifyGithubWebhookSignature(req)) return res.status(401).json({ ok: false, error: 'invalid github webhook signature' })
  const event = String(req.get('x-github-event') || '')
  const delivery = String(req.get('x-github-delivery') || '')
  const body = req.body || {}
  try {
    if (event === 'workflow_run' && body.action === 'completed' && body.workflow_run?.conclusion && body.workflow_run.conclusion !== 'success') {
      const run = body.workflow_run
      const repo = body.repository?.full_name || ''
      const inc = createIncident({
        source: 'github.workflow_run',
        severity: 'high',
        title: `GitHub Actions failed: ${run.name || 'workflow'} (${run.conclusion})`,
        fingerprint: `github-workflow-${repo}-${run.id}-${run.conclusion}`,
        details: { event, delivery, repo, runId: run.id, name: run.name, conclusion: run.conclusion, status: run.status, branch: run.head_branch, sha: run.head_sha, url: run.html_url },
      })
      const wf = createIncidentWorkflow({ incident: inc, recipeId: 'github_ci_status', input: { githubEvent: event, delivery, repo, runId: run.id, sha: run.head_sha } })
      return res.json({ ok: true, event, incident: inc, workflowId: wf.id })
    }
    if (event === 'push' && body.ref === 'refs/heads/main') {
      const repo = body.repository?.full_name || ''
      const inc = createIncident({
        source: 'github.push',
        severity: 'low',
        title: `Push to main: ${repo}`,
        fingerprint: `github-push-main-${repo}-${body.after || delivery}`,
        details: { event, delivery, repo, before: body.before, after: body.after, pusher: body.pusher?.name, compare: body.compare },
      })
      const wf = createIncidentWorkflow({ incident: inc, recipeId: 'production_health_check', input: { githubEvent: event, delivery, repo, sha: body.after } })
      return res.json({ ok: true, event, incident: inc, workflowId: wf.id })
    }
    return res.json({ ok: true, event, ignored: true })
  } catch (e) {
    console.warn('[github webhook] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: e?.message || String(e), event })
  }
})

// ── User-defined custom tools (MCP-style) ──────────────────────────────────
app.get('/api/custom-tools', requireAuth, async (req, res) => {
  try {
    const { listCustomTools } = await import('./customTools.js')
    res.json({ tools: listCustomTools(req.user?.id) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/custom-tools', requireAuth, async (req, res) => {
  try {
    const { upsertCustomTool } = await import('./customTools.js')
    res.json({ ok: true, ...upsertCustomTool(req.user?.id, req.body || {}) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.delete('/api/custom-tools/:name', requireAuth, async (req, res) => {
  try {
    const { deleteCustomTool } = await import('./customTools.js')
    res.json({ ok: true, ...deleteCustomTool(req.user?.id, req.params.name) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ── Cron / scheduled jobs ──────────────────────────────────────────────────
app.get('/api/cron', requireAuth, async (req, res) => {
  try {
    const { listCronJobs } = await import('./cron.js')
    res.json({ jobs: listCronJobs(req.user?.id) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/cron', requireAuth, async (req, res) => {
  try {
    const { upsertCronJob } = await import('./cron.js')
    res.json({ ok: true, ...upsertCronJob(req.user?.id, req.body || {}) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.delete('/api/cron/:id', requireAuth, async (req, res) => {
  try {
    const { deleteCronJob } = await import('./cron.js')
    res.json({ ok: true, ...deleteCronJob(req.user?.id, req.params.id) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.patch('/api/cron/:id', requireAuth, async (req, res) => {
  try {
    const { setCronJobEnabled } = await import('./cron.js')
    res.json({ ok: true, ...setCronJobEnabled(req.user?.id, req.params.id, req.body?.enabled !== false) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/cron/:id/run', requireAuth, async (req, res) => {
  try {
    const { triggerCronJobNow } = await import('./cron.js')
    res.json(await triggerCronJobNow(req.user?.id, req.params.id))
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ── Knowledge base (RAG) ───────────────────────────────────────────────────
app.get('/api/kb', requireAuth, async (req, res) => {
  try {
    const { listDocuments } = await import('./knowledgeBase.js')
    res.json({ documents: listDocuments(req.user?.id) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/kb', requireAuth, async (req, res) => {
  try {
    const { addDocument } = await import('./knowledgeBase.js')
    res.json({ ok: true, ...addDocument(req.user?.id, req.body || {}) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.delete('/api/kb/:id', requireAuth, async (req, res) => {
  try {
    const { deleteDocument } = await import('./knowledgeBase.js')
    res.json({ ok: true, ...deleteDocument(req.user?.id, req.params.id) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.get('/api/kb/search', requireAuth, async (req, res) => {
  try {
    const { searchKnowledge } = await import('./knowledgeBase.js')
    res.json({ results: searchKnowledge(req.user?.id, String(req.query.q || ''), { topK: Number(req.query.top_k || 5) }) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ── Semantic long-term memory ───────────────────────────────────────────────
app.get('/api/memory', requireAuth, async (req, res) => {
  try {
    const { listMemories } = await import('./semanticMemory.js')
    res.json({ memories: listMemories(req.user?.id, { limit: Number(req.query.limit || 50) }) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/memory', requireAuth, async (req, res) => {
  try {
    const { rememberMemory } = await import('./semanticMemory.js')
    const r = await rememberMemory(req.user?.id, String(req.body?.text || ''), { chatId: req.body?.chatId || '' })
    res.json({ ok: true, ...(r || {}) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.delete('/api/memory/:id', requireAuth, async (req, res) => {
  try {
    const { forgetMemory } = await import('./semanticMemory.js')
    res.json({ ok: true, ...forgetMemory(req.user?.id, req.params.id) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/jobs', requireAuth, (req, res) => {
  try {
    const { type, title = '', prompt = '', chatId = '', model = '', attachments = [], input = {} } = req.body || {}
    const job = createJob({
      userId: req.user?.id || '',
      chatId,
      type,
      title: title || type,
      input: { ...input, prompt, model, attachments },
    })
    startJob(job.id)
    res.json({ ok: true, job: getJob(job.id) })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Не удалось создать задачу' })
  }
})

app.post('/api/jobs/tool', requireAuth, (req, res) => {
  try {
    const { tool, args = {}, chatId = '', title = '' } = req.body || {}
    if (!tool) return res.status(400).json({ ok: false, error: 'tool required' })
    const job = createJob({
      userId: req.user?.id || '',
      chatId,
      type: `tool_${tool}`,
      title: title || `Tool: ${tool}`,
      input: { tool, args },
    })
    startJob(job.id)
    res.json({ ok: true, job: getJob(job.id) })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Не удалось создать tool-задачу' })
  }
})

app.post('/api/jobs/agent', requireAuth, (req, res) => {
  try {
    const {
      chatId = '', history = [], prompt = '', extraSystem = '', title = 'Agent background task',
      baseUrl = '', apiKey = '', authType = 'bearer', authHeader = '', extraHeaders = {}, model = '', temperature = 0.3,
    } = req.body || {}
    const safeHistory = Array.isArray(history) && history.length ? history.map((m) => ({ role: m.role, content: m.content })) : [{ role: 'user', content: String(prompt || 'continue') }]
    const job = createJob({
      userId: req.user?.id || '',
      chatId,
      type: 'agent_run',
      title,
      input: { history: safeHistory, prompt, extraSystem, provider: { baseUrl, model, authType, authHeader, extraHeaders, temperature } },
    })
    registerRuntimeInput(job.id, { provider: { baseUrl, apiKey, authType, authHeader, extraHeaders, model, temperature } })
    startJob(job.id)
    res.json({ ok: true, job: getJob(job.id) })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Не удалось создать agent-задачу' })
  }
})

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

app.get('/api/jobs', requireAuth, (req, res) => {
  res.json({ jobs: listJobs({ chatId: String(req.query.chatId || ''), userId: req.user?.id || '', limit: req.query.limit || 50 }) })
})

app.post('/api/jobs/:id/cancel', requireAuth, (req, res) => {
  const job = cancelJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ ok: true, job })
})

app.post('/api/jobs/:id/retry', requireAuth, (req, res) => {
  const job = retryJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ ok: true, job })
})

// Retry a failed/timed-out video job. Creates a NEW job with the same input
// and starts it. The UI links the new job from the failed card's button.
app.post('/api/jobs/:id/retry-video', requireAuth, async (req, res) => {
  // retryVideoJob удалён вместе с gemini_video runner — эндпоинт оставлен
  // как заглушка, чтобы старые клиенты получали понятную ошибку, а не краш.
  res.status(410).json({ ok: false, error: 'video retry is no longer supported' })
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
    if (isBlockedHost(hostname)) {
      return res.status(403).json({ error: 'Access to internal networks is not allowed' })
    }
    const page = await fetchWebPage(url)
    res.json(page)
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить web page' })
  }
})

// ---- Серверный прокси для чат-запросов (/api/chat) ----
// Решает проблему CORS: фронтенд шлёт запрос на свой сервер,
// сервер проксирует его к провайдеру (DeepSeek, Grok и т.д.) с stealthHeaders.
// Поддерживает как streaming (SSE), так и обычные JSON-ответы.

// ---- DEBUG LOG: пишем каждый /api/chat в файл (для отладки серого экрана) ----
// Включается переменной CHAT_DEBUG_LOG=/data/chat-debug.log
import { appendFileSync as _appendFileSyncDebug } from 'node:fs'
function chatDebugLog(tag, payload) {
  const file = process.env.CHAT_DEBUG_LOG
  if (!file) return
  try {
    const safe = JSON.parse(JSON.stringify(payload || {}))
    // Маскируем секреты
    if (typeof safe.apiKey === 'string' && safe.apiKey.length > 8) {
      safe.apiKey = safe.apiKey.slice(0, 6) + '...***...' + safe.apiKey.slice(-4)
    }
    if (safe.extraHeaders && safe.extraHeaders.Cookie) {
      safe.extraHeaders.Cookie = String(safe.extraHeaders.Cookie).slice(0, 30) + '...***...'
    }
    if (safe.extraHeaders && safe.extraHeaders.cookie) {
      safe.extraHeaders.cookie = String(safe.extraHeaders.cookie).slice(0, 30) + '...***...'
    }
    _appendFileSyncDebug(file, `${new Date().toISOString()} ${tag} ${JSON.stringify(safe)}\n`)
  } catch (e) {
    try { _appendFileSyncDebug(file, `${new Date().toISOString()} ${tag} LOG_ERR ${e.message}\n`) } catch { /* ignore debug log write error */ }
  }
}

app.post('/api/chat', requireAuth, async (req, res) => {
  chatDebugLog('REQ', {
    baseUrl: req.body?.baseUrl,
    apiKey: req.body?.apiKey,
    model: req.body?.model,
    authType: req.body?.authType,
    msgCount: Array.isArray(req.body?.messages) ? req.body.messages.length : 0,
    firstMsg: Array.isArray(req.body?.messages) && req.body.messages[0]
      ? { role: req.body.messages[0].role, len: String(req.body.messages[0].content || '').length }
      : null,
    stream: req.body?.stream,
    extraHeadersKeys: req.body?.extraHeaders ? Object.keys(req.body.extraHeaders) : [],
    user: req.user?.email || req.user?.id || null,
  })

  // Перехватим завершение ответа чтобы залогировать статус
  const origStatus = res.status.bind(res)
  res.status = (code) => { res._dbgStatus = code; return origStatus(code) }
  res.on('finish', () => {
    chatDebugLog('RES', { status: res._dbgStatus || res.statusCode })
  })
  res.on('close', () => {
    if (!res.writableEnded) chatDebugLog('RES_CLOSED', { status: res._dbgStatus || res.statusCode, aborted: true })
  })

  let {
    baseUrl,
    authType = 'bearer',
    authHeader = '',
    extraHeaders = {},
    model,
    messages,
    temperature = 0.7,
    stream = false,
  } = req.body || {}
  let { apiKey } = req.body || {}

  // gateway routing удалён вместе с gemini-web-proxy

  // Managed DeepSeek: if client omits apiKey (or passes '__managed__'),
  // inject the server-managed Bearer token + cookies from the refresher.
  let mergedExtraHeaders = extraHeaders
  if (isDeepSeekWebUrl(baseUrl) && (!apiKey || apiKey === '__managed__')) {
    const managedBearer = getDeepSeekBearer()
    const managedCookies = getDeepSeekCookieHeader()
    if (!managedBearer) {
      return res.status(503).json({
        error: 'DeepSeek session is not configured on the server. Ask an admin to provide a userToken.',
      })
    }
    apiKey = managedBearer
    mergedExtraHeaders = { ...(extraHeaders || {}) }
    if (managedCookies && !Object.keys(mergedExtraHeaders).some((k) => k.toLowerCase() === 'cookie')) {
      mergedExtraHeaders.Cookie = managedCookies
    }
  }

  if (!baseUrl || !apiKey || !model) {
    return res.status(400).json({ error: 'baseUrl, apiKey и model обязательны' })
  }

  // SSRF-защита
  let hostname
  try { hostname = new URL(baseUrl).hostname } catch {
    return res.status(400).json({ error: 'Неверный URL' })
  }
  if (isBlockedHost(hostname)) {
    return res.status(403).json({ error: 'Доступ к внутренней сети запрещён' })
  }

  // DeepSeek Web Experimental использует собственные endpoints/body/POW,
  // поэтому обрабатываем его отдельным адаптером. В managed-режиме передаём
  // подменённые apiKey/extraHeaders из серверного refresher'а.
  if (isDeepSeekWebUrl(baseUrl)) {
    const reqBody = { ...(req.body || {}), apiKey, extraHeaders: mergedExtraHeaders }
    chatDebugLog('DEEPSEEK_DISPATCH', {
      hasManagedBearer: Boolean(apiKey && apiKey !== req.body?.apiKey),
      mergedHeadersKeys: Object.keys(mergedExtraHeaders || {}),
      model,
      stream,
    })
    try {
      return await handleDeepSeekWebChat({ reqBody, res })
    } catch (e) {
      chatDebugLog('DEEPSEEK_THROW', { message: e?.message, stack: String(e?.stack || '').slice(0, 800) })
      console.error('[deepseek] handler threw:', e)
      if (!res.headersSent) res.status(500).json({ error: e?.message || 'DeepSeek handler error' })
      return
    }
  }


  // Official Anthropic / Google Gemini APIs are not OpenAI-compatible.
  // Convert them to the OpenAI-ish response shape expected by the frontend
  // so normal chat and Agent Mode both work with the same saved key.
  if (isAnthropicOfficialUrl(baseUrl) || isGoogleGenerativeNativeUrl(baseUrl)) {
    try {
      const providerArgs = {
        baseUrl, apiKey, model, messages,
        temperature: Number(temperature ?? 0.7),
        authType, authHeader, extraHeaders: mergedExtraHeaders,
      }
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders?.()
        const reply = await callLLMStream({
          ...providerArgs,
          onTextDelta: (chunk) => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
          },
        })
        if (reply?.usage) {
          res.write(`data: ${JSON.stringify({ choices: [], usage: {
            prompt_tokens: reply.usage.prompt || 0,
            completion_tokens: reply.usage.completion || 0,
            total_tokens: reply.usage.total || 0,
          } })}\n\n`)
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const reply = await callLLM(providerArgs)
      return res.json({
        id: `browserai-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text || '' }, finish_reason: 'stop' }],
        usage: reply.usage ? {
          prompt_tokens: reply.usage.prompt || 0,
          completion_tokens: reply.usage.completion || 0,
          total_tokens: reply.usage.total || 0,
        } : undefined,
      })
    } catch (e) {
      const providerError = normalizeProviderError(e, { baseUrl, model, phase: 'chat' })
      if (!res.headersSent) return res.status(502).json({ error: providerError.message, providerError })
      res.end()
      return
    }
  }


  const root = String(baseUrl).replace(/\/$/, '')
  const stealthH = buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders: mergedExtraHeaders })
  const body = applyBodyDefaults({ model, messages, temperature, stream }, baseUrl)
  const targetUrl = getChatUrl(baseUrl)

  // Определяем, нужно ли проксировать через Cloudflare Workers
  // Для сессионных токенов (веб-интерфейсы) — да, если CF_PROXY_URL задан
  const profile = getSiteProfile(baseUrl)
  const isSession = authType === 'cookie' || authType === 'custom' || profile.isBearerSession
  const cfProxyUrl = process.env.CF_PROXY_URL || ''
  const cfProxySecret = process.env.CF_PROXY_SECRET || ''
  const useProxy = isSession && cfProxyUrl

  try {
    let upstream

    // Connect-only timeout (60s to first byte of response headers). A flat
    // AbortSignal.timeout(120000) also counted STREAMING time and aborted
    // long SSE answers (GLM-5/DeepSeek-R1 reasoning runs for minutes) —
    // surfacing in the UI as «Сетевая ошибка или временный сбой».
    const connectCtl = new AbortController()
    const connectTimer = setTimeout(() => connectCtl.abort(new Error('Провайдер не ответил за 60 секунд')), 60_000)
    try {
      if (useProxy) {
        // Через Cloudflare Workers прокси
        console.log(`[chat proxy] via CF Workers → ${targetUrl} model=${model}`)
        upstream = await fetch(cfProxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfProxySecret ? { 'X-Proxy-Key': cfProxySecret } : {}),
          },
          body: JSON.stringify({
            targetUrl,
            headers: stealthH,
            body,
          }),
          signal: connectCtl.signal,
        })
      } else {
        // Прямой запрос к провайдеру
        console.log(`[chat proxy] direct → ${targetUrl} model=${model}`)
        upstream = await fetch(targetUrl, {
          method: 'POST',
          headers: stealthH,
          body: JSON.stringify(body),
          signal: connectCtl.signal,
        })
      }
    } finally {
      clearTimeout(connectTimer)
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      console.warn(`[chat proxy] upstream ${upstream.status} for ${root}: ${errText.slice(0, 200)}`)
      return res.status(upstream.status).json({
        error: `Провайдер ответил ${upstream.status}: ${errText.slice(0, 500)}`,
      })
    }

    // Проверяем Content-Type — если HTML вместо JSON/SSE, значит провайдер вернул страницу (captcha, redirect, etc.)
    const upstreamCT = (upstream.headers.get('content-type') || '').toLowerCase()
    console.log(`[chat proxy] upstream OK ${upstream.status} stream=${stream} model=${model} ct=${upstreamCT}`)

    if (upstreamCT.includes('text/html')) {
      const htmlSnippet = await upstream.text().catch(() => '')
      console.warn(`[chat proxy] received HTML instead of JSON from ${root}: ${htmlSnippet.slice(0, 200)}`)
      return res.status(502).json({
        error: `Провайдер вернул HTML вместо JSON — возможно, токен устарел, требуется капча или смена IP. Обнови токен.`,
      })
    }

    if (stream) {
      // SSE — стримим ответ клиенту как есть
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()

      const reader = upstream.body?.getReader()
      if (!reader) {
        res.end()
        return
      }

      // Если клиент отключился — отменяем чтение upstream
      req.on('close', () => {
        reader.cancel().catch(() => {})
      })

      // Keep-alive comments: mobile networks and VPNs silently drop HTTP
      // connections that stay quiet for ~30-60s (reasoning models think
      // silently for minutes). SSE comments keep the pipe warm. Plus an
      // idle watchdog so a dead provider can't hang the request forever.
      let lastData = Date.now()
      const ka = setInterval(() => {
        try { res.write(': keep-alive\n\n') } catch { /* client gone */ }
        if (Date.now() - lastData > 300_000) { try { reader.cancel() } catch { /* ignore */ } }
      }, 15_000)

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          lastData = Date.now()
          res.write(value)
        }
      } catch (e) {
        // Если клиент отключился — не считаем это ошибкой
        if (!res.destroyed) {
          console.warn('Chat proxy stream error:', e.message)
          try { res.write(`data: ${JSON.stringify({ error: 'Поток провайдера оборвался: ' + (e?.message || 'connection lost') })}\n\n`) } catch { /* ignore */ }
        }
      } finally {
        clearInterval(ka)
        try { res.write('data: [DONE]\n\n') } catch { /* ignore */ }
        res.end()
      }
    } else {
      // Обычный JSON-ответ — пробрасываем как есть
      const contentType = upstream.headers.get('content-type') || 'application/json'
      res.setHeader('Content-Type', contentType)
      const data = await upstream.text()
      res.send(data)
    }
  } catch (e) {
    const msg = e?.name === 'TimeoutError'
      ? 'Таймаут — провайдер не ответил за 2 минуты'
      : (e.message || 'Ошибка сети')
    if (!res.headersSent) {
      res.status(502).json({ error: msg })
    } else {
      res.end()
    }
  }
})

app.get('/api/health', (req, res) => res.json({ ok: true }))

// HSTS-eviction endpoint. If a previous deploy accidentally sent
// `Strict-Transport-Security: max-age=...` over plain HTTP (which is what
// we used to do via helmet's default config), browsers now silently
// upgrade every http://<host>/... request to https:// and fail with a
// network error. Sending `max-age=0` once tells the browser to forget
// the pin. Safe to call anytime — has no effect when there's no pin and
// no effect once HSTS is correctly served over real HTTPS.
app.get('/api/hsts-reset', requireAuth, requireUnlocked, (_req, res) => {
  res.setHeader('Strict-Transport-Security', 'max-age=0')
  res.json({ ok: true, message: 'HSTS pin cleared (max-age=0).' })
})

// ── Временный диагностический эндпоинт ──────────────────────────────────────
// Берёт активный ключ, шлёт тестовый запрос к провайдеру и показывает что вернулось
app.get('/api/debug/chat-test', requireAuth, async (req, res) => {
  try {
    const key = getActiveKeyDecrypted(encKey())
    if (!key) return res.json({ error: 'Нет активного ключа', key: null })

    const info = {
      keyName: key.name,
      baseUrl: key.baseUrl,
      model: key.model,
      authType: key.authType,
      availableModels: key.availableModels,
      hasApiKey: Boolean(key.apiKey),
      apiKeyLength: key.apiKey?.length || 0,
      apiKeyPrefix: key.apiKey?.slice(0, 20) + '...',
      extraHeaders: key.extraHeaders,
    }

    const stealthH = buildSessionHeaders({
      baseUrl: key.baseUrl,
      apiKey: key.apiKey,
      authType: key.authType,
      authHeader: key.authHeader,
      extraHeaders: key.extraHeaders,
    })
    const body = applyBodyDefaults({
      model: key.model,
      messages: [{ role: 'user', content: 'Скажи коротко: привет' }],
      max_tokens: 20,
      stream: false,
    }, key.baseUrl)

    const t0 = Date.now()
    const dbgProxyUrl = process.env.CF_PROXY_URL || ''
    const dbgProxySecret = process.env.CF_PROXY_SECRET || ''
    const targetUrl = getChatUrl(key.baseUrl)

    let upstream
    if (dbgProxyUrl) {
      upstream = await fetch(dbgProxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(dbgProxySecret ? { 'X-Proxy-Key': dbgProxySecret } : {}),
        },
        body: JSON.stringify({ targetUrl, headers: stealthH, body }),
        signal: AbortSignal.timeout(30000),
      })
    } else {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: stealthH,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
    }
    const elapsed = Date.now() - t0

    const ct = upstream.headers.get('content-type') || ''
    const rawText = await upstream.text().catch(() => '')

    res.json({
      keyInfo: info,
      requestBody: body,
      upstream: {
        status: upstream.status,
        contentType: ct,
        elapsed: elapsed + 'ms',
        bodyLength: rawText.length,
        bodySnippet: rawText.slice(0, 1000),
      },
    })
  } catch (e) {
    res.json({ error: e.message || 'Ошибка', stack: e.stack?.split('\n').slice(0, 3) })
  }
})



// ── Версия нативного APK ─────────────────────────────────────────────────────
// Публичный эндпоинт — Android-приложение проверяет его при старте.
// Возвращает минимальный требуемый versionCode и ссылку на APK.
// Если APK пользователя >= minNativeVersion — обновление не нужно.
//
// Как обновить: просто измени APP_NATIVE_VERSION в окружении (.env).
// Например: APP_NATIVE_VERSION=4
// Все установленные приложения с versionCode < 4 получат уведомление.
app.get('/api/app-version', (req, res) => {
  // Минимальный нативный versionCode — задаётся через переменную окружения
  // или хардкодится здесь. При пересборке APK — увеличь это число.
  const minNativeVersion = parseInt(process.env.APP_NATIVE_VERSION || '3', 10)

  // Ссылка на последний APK — можно задать через переменную или использовать GitHub
  const apkUrl = process.env.APP_APK_URL
    || 'https://github.com/robesthud/browserAI/releases/latest/download/BrowserAI-latest.apk'

  // Ссылка на страницу релиза для fallback
  const releaseUrl = process.env.APP_RELEASE_URL
    || 'https://github.com/robesthud/browserAI/releases/latest'

  // Краткое описание что нового в этом APK
  const releaseNotes = process.env.APP_RELEASE_NOTES
    || 'Исправления ошибок и улучшения стабильности.'

  res.json({
    // Версия нативной оболочки (Java-код)
    minNativeVersion,
    // Прямая ссылка на APK-файл
    apkUrl,
    // Страница релиза (fallback если нет прямой ссылки)
    releaseUrl,
    // Что нового
    releaseNotes,
    // Версия веб-приложения (для инфо) — читается из package.json при старте
    webVersion: APP_WEB_VERSION,
    // Время старта текущего процесса сервера (ориентир последнего деплоя)
    deployedAt: DEPLOYED_AT,
  })
})

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
console.log('Production: serving static from', distDir)
console.log('Project root contents:', readdirSync(join(__dirname, '..')))
if (existsSync(distDir)) {
  console.log('Dist directory exists. Files:', readdirSync(distDir))
  app.use(express.static(distDir))
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(join(distDir, 'index.html'))
  })
} else {
  console.log('Dist directory DOES NOT exist!')
}

try {
  await ensureWorkspaceRoot();
  initJobs();
  initAgentWorkflows();
  initIncidents();
  initOperatorMode();
} catch (err) {
  console.error('FATAL: Failed to initialize workspace:', err.message);
  process.exit(1);
}

// ── DeepSeek managed-session admin API ─────────────────────────────────────
// All routes require auth. Token/cookies are server-side only and never
// returned to the client in raw form (see getSessionState()).
app.get('/api/admin/deepseek/status', requireAuth, (req, res) => {
  res.json(getDeepSeekState())
})

app.post('/api/admin/deepseek/refresh', requireAuth, async (req, res) => {
  try {
    const state = await refreshDeepSeekNow({ source: `admin-ui:${req.user?.id || req.user?.email || 'unknown'}` })
    res.json({ ok: true, state })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/admin/deepseek/token', requireAuth, async (req, res) => {
  const { userToken = '', cookies = null } = req.body || {}
  if (!userToken && !cookies) {
    return res.status(400).json({ ok: false, error: 'Provide userToken and/or cookies' })
  }
  try {
    const state = await setDeepSeekSession({
      userToken,
      cookies,
      source: `admin-ui:${req.user?.id || req.user?.email || 'unknown'}`,
    })
    res.json({ ok: true, state })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/api/admin/deepseek/models', requireAuth, (req, res) => {
  res.json({ models: getDeepSeekModels() })
})

// Client-side error reporter (no auth — anonymous crash reports).
// Writes one JSON line per crash to CLIENT_ERROR_LOG (default
// /data/client-errors.log) so we can debug grey screens via SSH:
//   tail -f /opt/browserai-data/client-errors.log
app.post('/api/debug/client-error', express.json({ limit: '256kb' }), async (req, res) => {
  const file = process.env.CLIENT_ERROR_LOG || '/data/client-errors.log'
  try {
    const body = req.body || {}
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
      ...body,
    })
    _appendFileSyncDebug(file, line + '\n')
    // Also fan out to monitoring so a wave of grey screens pings the admin.
    try {
      const { captureClientError } = await import('./monitoring.js')
      captureClientError(body)
    } catch { /* monitoring optional */ }
  } catch {
    // Swallow — we never want this endpoint to throw back at the browser.
  }
  res.status(204).end()
})

// Lightweight metrics endpoint for uptime checks / dashboards.
// Unauthenticated on purpose — only reveals process info, no secrets.
app.get('/api/health/metrics', async (_req, res) => {
  try {
    const { snapshotMetrics } = await import('./monitoring.js')
    res.json(snapshotMetrics())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Cost tracking ──────────────────────────────────────────────────────────
// Returns the user's LLM spend over the trailing 24h plus a per-model
// breakdown. The UI consumes this for the token/cost badge in the topbar.
app.get('/api/cost/today', requireAuth, async (req, res) => {
  try {
    const { dailyTotalUsd, topModelsToday, checkCap } = await import('./costTracker.js')
    const cap = checkCap(req.user?.id || '')
    res.json({
      dailyTotal: dailyTotalUsd(req.user?.id || ''),
      top: topModelsToday(req.user?.id || '', 5),
      cap: cap.cap || Number(process.env.BROWSERAI_DAILY_USD || 5),
      capReached: !cap.ok,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/cost/chat/:chatId', requireAuth, async (req, res) => {
  try {
    const { chatTotalUsd } = await import('./costTracker.js')
    res.json(chatTotalUsd(String(req.params.chatId || '')))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── MCP (Model Context Protocol) ───────────────────────────────────────────
// All endpoints require admin (we only allow management for the owner of
// the box because MCP servers can read filesystem / call out / etc.).
// ── Computer Use status ──────────────────────────────────────────────────
// Tells the UI whether computer-sandbox is reachable and enabled. The
// frontend can show a "Computer Use available" indicator and a hint for
// how to turn it on.
app.get('/api/computer/status', requireAuth, async (_req, res) => {
  const enabled = String(process.env.BROWSERAI_COMPUTER_USE || '').toLowerCase() === 'on'
  if (!enabled) {
    return res.json({
      enabled: false,
      reachable: false,
      hint: 'BROWSERAI_COMPUTER_USE is off. Set it to "on" in .env and start the sandbox: `docker compose --profile computer up -d computer-sandbox`.',
    })
  }
  try {
    const { computerStatus } = await import('./computerUse.js')
    const s = await computerStatus({})
    res.json({ enabled: true, reachable: Boolean(s?.ok), info: s?.info || null, error: s?.error || null })
  } catch (e) {
    res.json({ enabled: true, reachable: false, error: e?.message || String(e) })
  }
})

app.get('/api/mcp/status', requireAuth, async (_req, res) => {
  try {
    const { getMcpServerStatus } = await import('./mcpClient.js')
    res.json({ servers: getMcpServerStatus() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/mcp/config', requireAuth, async (_req, res) => {
  try {
    const { getMcpConfig } = await import('./mcpClient.js')
    res.json({ servers: await getMcpConfig() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/mcp/server/:name', requireAuth, async (req, res) => {
  try {
    const { setMcpServer } = await import('./mcpClient.js')
    const out = await setMcpServer(String(req.params.name), req.body || {})
    res.json({ ok: true, servers: out, restartHint: 'Restart the container or POST /api/mcp/restart to apply.' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/mcp/server/:name', requireAuth, async (req, res) => {
  try {
    const { deleteMcpServer } = await import('./mcpClient.js')
    const out = await deleteMcpServer(String(req.params.name))
    res.json({ ok: true, servers: out })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/mcp/restart', requireAuth, async (_req, res) => {
  try {
    const { stopMcpHub, startMcpHub } = await import('./mcpClient.js')
    stopMcpHub()
    await new Promise((r) => setTimeout(r, 500))
    await startMcpHub()
    const { getMcpServerStatus } = await import('./mcpClient.js')
    res.json({ ok: true, servers: getMcpServerStatus() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Approval policy (per-user) ─────────────────────────────────────────────
app.get('/api/approval/policy', requireAuth, async (req, res) => {
  try {
    const { loadPolicy } = await import('./approvalGate.js')
    res.json({ policy: loadPolicy(req.user?.id || '') })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/approval/policy', requireAuth, async (req, res) => {
  try {
    const { savePolicy } = await import('./approvalGate.js')
    const next = savePolicy(req.user?.id || '', req.body?.policy || {})
    res.json({ ok: true, policy: next })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Checkpoints (session-level undo) ───────────────────────────────────────
app.get('/api/checkpoints/:chatId', requireAuth, async (req, res) => {
  try {
    const { listCheckpoints } = await import('./checkpoints.js')
    res.json({ checkpoints: listCheckpoints(String(req.params.chatId || '')) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/checkpoints/:chatId/restore', requireAuth, async (req, res) => {
  try {
    const { restoreCheckpoint } = await import('./checkpoints.js')
    const result = await restoreCheckpoint({
      chatId: String(req.params.chatId || ''),
      step: Number(req.body?.step) || 0,
    })
    res.json({ ok: true, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Web Push ───────────────────────────────────────────────────────────────
app.get('/api/push/vapid', async (_req, res) => {
  try {
    const { getPublicVapidKey } = await import('./push.js')
    res.json({ publicKey: await getPublicVapidKey() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { saveSubscription } = await import('./push.js')
    await saveSubscription(req.user?.id, req.body || {})
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { deleteSubscription } = await import('./push.js')
    res.json({ ok: true, ...deleteSubscription(String(req.body?.endpoint || '')) })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/push/test', requireAuth, async (req, res) => {
  try {
    const { notifyUser } = await import('./push.js')
    const r = await notifyUser(req.user?.id, {
      title: 'BrowserAI', body: String(req.body?.body || 'Test notification ✅'),
    })
    res.json(r)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Agent mode ─────────────────────────────────────────────────────────────
// SSE stream of an autonomous agent that can call workspace, web and
// sandboxed bash tools. The agent loop is provider-agnostic — it works
// with DeepSeek (managed), OpenAI, BigModel, Groq, Mistral, Together,
// OpenRouter, Gemini's OpenAI proxy, etc.
//
// Body shape (same as /api/chat):
//   {
//     baseUrl, apiKey, model,
//     authType?, authHeader?, extraHeaders?,
//     history: [{role, content}],   // chat so far, last item is the new user turn
//     extraSystem?: string,         // optional extra context for the system prompt
//   }
//
// If baseUrl is chat.deepseek.com and apiKey is '__managed__' or empty,
// the managed bearer + cookies are injected — exact same mechanism the
// regular /api/chat uses, so the managed DeepSeek preset works in the
// agent toggle out of the box.
app.post('/api/agent/chat', requireAuth, async (req, res) => {
  let {
    baseUrl,
    authType = 'bearer',
    authHeader = '',
    extraHeaders = {},
    model,
    history = [],
    extraSystem = '',
    temperature = 0.3,
    chatId = '',
  } = req.body || {}
  let { apiKey } = req.body || {}

  // gateway routing удалён вместе с gemini-web-proxy

  if (!baseUrl || !model) {
    return res.status(400).json({ error: 'baseUrl and model are required' })
  }
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: 'history must be a non-empty array' })
  }

  // Managed DeepSeek injection — same logic as /api/chat
  let mergedExtraHeaders = extraHeaders
  if (isDeepSeekWebUrl(baseUrl) && (!apiKey || apiKey === '__managed__')) {
    const managedBearer = getDeepSeekBearer()
    const managedCookies = getDeepSeekCookieHeader()
    if (!managedBearer) {
      // #35 FIX: Better error message for missing DeepSeek session
      return res.status(503).json({
        error: 'DeepSeek managed session is not configured on the server. Please visit /admin/deepseek or use the Telegram bot to provide a userToken.',
      })
    }
    apiKey = managedBearer
    mergedExtraHeaders = { ...(extraHeaders || {}) }
    if (managedCookies && !Object.keys(mergedExtraHeaders).some((k) => k.toLowerCase() === 'cookie')) {
      mergedExtraHeaders.Cookie = managedCookies
    }
  }

  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey is required' })
  }

  // SSRF guard (same as /api/chat)
  let hostname
  try { hostname = new URL(baseUrl).hostname } catch {
    return res.status(400).json({ error: 'Invalid baseUrl' })
  }
  if (isBlockedHost(hostname)) {
    return res.status(403).json({ error: 'Access to internal networks is not allowed' })
  }

  // Normalise history — drop empty messages, keep role + (string OR
  // multimodal content[]). Multimodal user messages look like
  //   { role: 'user', content: [{type:'text',text:…}, {type:'image_url',…}] }
  // and must be passed through verbatim so the vision model sees them.
  function hasContent(m) {
    if (!m) return false
    if (m.role === 'tool') return true // tool results always have content
    if (m.tool_calls && m.tool_calls.length > 0) return true // assistant calls
    if (typeof m.content === 'string') return m.content.trim().length > 0
    if (Array.isArray(m.content)) {
      return m.content.some((p) =>
        (p?.type === 'text'      && String(p.text || '').trim()) ||
        (p?.type === 'image_url' && p.image_url?.url) ||
        (p?.type === 'image'     && (p.source || p.image)),
      )
    }
    return false
  }

  // #22 FIX: Preserve tool calls and tool roles in history. 
  // Models like Claude and GPT-4 strictly require the correct sequence:
  // assistant(tool_calls) -> tool(result) -> assistant(reply).
  // Stripping these or changing roles to 'user' causes 400 errors or hangs.
  const safeHistory = history
    .filter(hasContent)
    .map((m) => {
      const out = { 
        role: m.role, 
        content: m.content 
      }
      if (m.role === 'assistant' && m.tool_calls) {
        out.tool_calls = m.tool_calls
      }
      if (m.role === 'tool') {
        out.tool_call_id = m.tool_call_id || m.id
        out.name = m.name
      }
      return out
    })

  // Inject a real "what was done recently in this workspace" digest so the
  // agent can produce an HONEST summary when the user asks "что ты сделал?"
  // instead of hallucinating one out of its chat memory. Limited to the
  // current chat's workspace scope and the last 60 minutes.
  let realActivityNote = ''
  let projectRulesNote = ''
  try {
    if (chatId) {
      // FIX: also timeout the recent activity query (can be slow on large workspaces after first agent task).
      const events = await Promise.race([
        withWorkspaceScope(chatId, () => listRecentWorkspaceActivity({ sinceMs: 60 * 60 * 1000, limit: 50 })),
        new Promise((r) => setTimeout(() => r([]), 3000)),
      ]).catch(() => [])
      if (events.length) {
        const lines = events.map((e) => {
          const iso = new Date(e.ts).toISOString().slice(11, 19)
          return `  • [${iso}] ${e.reason.toUpperCase()} ${e.path}`
        }).join('\n')
        realActivityNote = `# Recently-applied changes in /workspace (ground truth, last 60 min)\n\n${lines}\n\nWhen the user asks for a report or summary, build it FROM THIS LIST and from your own tool-call history. Do NOT invent file paths or changes that aren't here.`
      } else {
        realActivityNote = '# Recently-applied changes in /workspace (last 60 min)\n\n(none — no files were created or modified yet)\n\nIf the user thinks you "fixed" something, be honest: nothing has been applied to disk yet. Either apply it now via edit_file/write_file, or say so plainly.'
      }

      // First-turn auto-read of project rules. The frontend marks the very
  // first message of a chat with a `[browserai-first-turn]` token in
  // extraSystem — when we see it we briefly look in the workspace for
  // commonly-used "rules for AI agents" files and inject up to 12 KB of
  // them as project context. This is the 1:1 Arena Parity fix.
  if (String(extraSystem || '').includes('[browserai-first-turn]')) {
    const rules = await withWorkspaceScope(chatId, () => readProjectRules())
    if (rules) projectRulesNote = rules
  }
    }
  } catch (e) {
    console.warn('[agent] workspace activity digest failed:', e?.message || e)
  }
  // Cross-session memory: render the user's persisted facts (Tailwind v3 not v4,
  // 'main repo is /opt/browserai', …) into the system prompt every turn.
  let userFactsNote = ''
  try {
    const { renderFactsForPrompt } = await import('./userMemory.js')
    userFactsNote = renderFactsForPrompt(req.user?.id || '') || ''
  } catch (e) {
    console.warn('[agent] facts render failed:', e?.message || e)
  }

  // Model self-knowledge: context window + tier + vision flag.
  let modelHintNote = ''
  try {
    const { renderModelHintForPrompt } = await import('./modelKnowledge.js')
    modelHintNote = renderModelHintForPrompt(model)
  } catch { /* optional */ }

  // Semantic recall: pull the top-K memories most relevant to whatever
  // the user just typed (last user message). This is the cross-chat
  // "wait, we talked about this last week" memory layer — works on top
  // of the explicit remember_fact KV the agent can also write to.
  let recallNote = ''
  try {
    const lastUser = [...safeHistory].reverse().find((m) => m.role === 'user')
    if (lastUser?.content && req.user?.id) {
      const { renderRecallForPrompt } = await import('./semanticMemory.js')
      // FIX: wrap semantic recall (which may do a provider /embeddings call) in a hard timeout.
      // Previously a slow/hanging embeddings fetch on the second+ agent task in a chat could
      // block the entire request handler before any SSE headers or events were sent,
      // leaving the UI spinner spinning forever with no visible progress.
      // 6s is generous for a cheap embed + cosine; if it times out we just proceed with no extra recall note.
      recallNote = await Promise.race([
        renderRecallForPrompt(req.user.id, lastUser.content, {
          topK: 5,
          provider: { baseUrl, apiKey, authType, authHeader, extraHeaders: mergedExtraHeaders, model },
        }),
        new Promise((r) => setTimeout(() => r(''), 6000)),
      ]).catch(() => '')
    }
  } catch (e) { console.warn('[agent] recall failed:', e?.message || e) }

  let resumeTaskNote = ''
  try {
    const lastUser = [...safeHistory].reverse().find((m) => m.role === 'user')
    if (/^(продолжай|continue|resume|дальше|go on)/i.test(String(lastUser?.content || '').trim())) {
      const task = latestAgentTask({ chatId, userId: req.user?.id || '', includeDone: true })
      resumeTaskNote = buildResumeSystemMessage(task)
    }
  } catch { /* optional */ }

  const extraSystemFinal = [
    `## AGENT QUALITY RULES (ENFORCED)

- ALWAYS call read_project_rules BEFORE starting work on a new task. This loads AGENTS.md, README.md, and package.json context automatically.
- ALWAYS call verify_code IMMEDIATELY after every write_file or edit_file to catch syntax errors before they crash the app.
- ALWAYS run npm_test after making code changes to verify nothing broke. If tests fail, fix the code before continuing.
- Use git_status BEFORE git_commit to see what changed. Commit messages must be descriptive: "feat: add Telegram bot" or "fix: correct auth middleware".
- Use npm_install when you need a new dependency — never write code that imports packages not in package.json.
- Use docker_logs to debug container crashes. Use docker_ps to see running containers.
- After creating or editing files, output their FULL content in markdown code blocks in the final answer so the user can see the result.
- Do NOT end with questions or offers to help further unless genuinely blocked.
`,
    String(extraSystem || '').replace(/\[browserai-first-turn\]/g, '').trim(),
    modelHintNote,
    userFactsNote,
    recallNote,
    resumeTaskNote,
    projectRulesNote,
    realActivityNote,
  ].filter(Boolean).join('\n\n')

  try {
    await runAgent({
      provider: {
        baseUrl,
        apiKey,
        authType,
        authHeader,
        extraHeaders: mergedExtraHeaders,
        model,
        temperature,
        forceAgent: true,
      },
      history: safeHistory,
      extraSystem: extraSystemFinal,
      workspaceScope: chatId,
      userId: req.user?.id || '',
      res,
    })
    // Fire-and-forget: ask the model to extract 0-3 memorable facts from
    // the turn we just finished and store them in long-term memory.
    // Never blocks the response — runs after the SSE stream has ended.
    if (req.user?.id) {
      try {
        const { extractAndStore } = await import('./factExtractor.js')
        void extractAndStore({
          userId: req.user.id, chatId,
          provider: { baseUrl, apiKey, authType, authHeader, extraHeaders: mergedExtraHeaders, model },
          history: safeHistory,
        }).catch(() => { /* best-effort */ })
      } catch { /* optional */ }
    }
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message })
    }
  }
})



// ── Incidents ──────────────────────────────────────────────────────────────
app.get('/api/incidents', requireAuth, (req, res) => {
  res.json({ incidents: listIncidents({ userId: req.user?.id || '', status: String(req.query.status || ''), limit: req.query.limit || 50 }) })
})

app.get('/api/incidents/:id', requireAuth, (req, res) => {
  const incident = getIncident(req.params.id)
  if (!incident || (incident.userId && incident.userId !== req.user?.id)) return res.status(404).json({ error: 'incident not found' })
  res.json({ incident })
})

app.post('/api/incidents/:id/resolve', requireAuth, (req, res) => {
  const incident = getIncident(req.params.id)
  if (!incident || (incident.userId && incident.userId !== req.user?.id)) return res.status(404).json({ error: 'incident not found' })
  res.json({ ok: true, incident: resolveIncident(req.params.id, { note: String(req.body?.note || '') }) })
})

app.post('/api/incidents/:id/diagnose', requireAuth, (req, res) => {
  try {
    const incident = getIncident(req.params.id)
    if (!incident || (incident.userId && incident.userId !== req.user?.id)) return res.status(404).json({ error: 'incident not found' })
    const recipeId = String(req.body?.recipeId || 'browserai_full_diagnostic')
    const workflow = createIncidentWorkflow({ incident: { ...incident, userId: incident.userId || req.user?.id || '' }, recipeId, userId: req.user?.id || '', input: { manualDiagnose: true } })
    res.json({ ok: true, incident: getIncident(req.params.id), workflow })
  } catch (e) { res.status(400).json({ ok: false, error: e?.message || String(e), code: e?.code || 'ERROR' }) }
})

// ── Agent Automation Workflows ─────────────────────────────────────────────
app.get('/api/agent/recipes', requireAuth, (_req, res) => {
  res.json({ recipes: listAutomationRecipes() })
})

app.get('/api/agent/policy', requireAuth, (req, res) => {
  res.json({ policy: getAutomationPolicy(), events: listAutomationPolicyEvents({ userId: req.user?.id || '', limit: Number(req.query.limit || 50) }) })
})

app.get('/api/agent/control-plane', requireAuth, (req, res) => {
  res.json({ controlPlane: getAgentControlPlane({ userId: req.user?.id || '' }) })
})

app.get('/api/operator/status', requireAuth, async (req, res) => {
  res.json({ operator: await getOperatorStatus({ userId: req.user?.id || '' }) })
})

app.get('/api/operator/projects', requireAuth, (req, res) => {
  res.json({ projects: listOperatorProjects({ userId: req.user?.id || '' }) })
})

app.post('/api/operator/projects', requireAuth, (req, res) => {
  try { res.json({ ok: true, project: upsertOperatorProject({ userId: req.user?.id || '', ...(req.body || {}) }) }) }
  catch (e) { res.status(400).json({ ok: false, error: e?.message || String(e) }) }
})

app.get('/api/operator/missions', requireAuth, (req, res) => {
  res.json({ missions: listOperatorMissions({ userId: req.user?.id || '', limit: req.query.limit || 30 }) })
})

app.get('/api/operator/missions/:id', requireAuth, (req, res) => {
  const mission = getOperatorMission(req.params.id)
  if (!mission || (mission.userId && mission.userId !== req.user?.id)) return res.status(404).json({ error: 'mission not found' })
  res.json({ mission })
})

app.get('/api/operator/code-tasks', requireAuth, (req, res) => {
  res.json({ tasks: listOperatorCodeTasks({ userId: req.user?.id || '', limit: req.query.limit || 30 }) })
})

app.get('/api/operator/code-tasks/:id', requireAuth, (req, res) => {
  const task = getOperatorCodeTask(req.params.id)
  if (!task || (task.userId && task.userId !== req.user?.id)) return res.status(404).json({ error: 'code task not found' })
  res.json({ task })
})

app.post('/api/operator/missions', requireAuth, (req, res) => {
  try {
    const mission = startOperatorMission({
      userId: req.user?.id || '',
      projectId: String(req.body?.projectId || 'browserai'),
      type: String(req.body?.type || 'full_diagnostic'),
      goal: String(req.body?.goal || ''),
      confirm: req.body?.confirm === true,
    })
    res.json({ ok: true, mission })
  } catch (e) { res.status(e?.code === 'CONFIRM_REQUIRED' ? 409 : 400).json({ ok: false, error: e?.message || String(e), code: e?.code || 'ERROR' }) }
})

app.get('/api/agent/workflows', requireAuth, (req, res) => {
  res.json({ workflows: listWorkflows({ userId: req.user?.id || '', chatId: String(req.query.chatId || ''), limit: req.query.limit || 30 }) })
})

app.post('/api/agent/workflows', requireAuth, (req, res) => {
  try {
    const wf = createWorkflow({
      userId: req.user?.id || '',
      chatId: String(req.body?.chatId || ''),
      recipeId: String(req.body?.recipeId || ''),
      input: req.body?.input || {},
      confirm: req.body?.confirm === true,
      source: String(req.body?.source || 'manual'),
    })
    startWorkflow(wf.id)
    res.json({ ok: true, workflow: getWorkflow(wf.id) })
  } catch (e) {
    const status = e?.code === 'CONFIRM_REQUIRED' ? 409 : 400
    res.status(status).json({ ok: false, error: e?.message || String(e), code: e?.code || 'ERROR', policy: e?.policy || null })
  }
})

app.get('/api/agent/workflows/:id', requireAuth, (req, res) => {
  const wf = getWorkflow(req.params.id)
  if (!wf || (wf.userId && wf.userId !== req.user?.id)) return res.status(404).json({ error: 'workflow not found' })
  res.json({ workflow: wf })
})

app.post('/api/agent/workflows/:id/cancel', requireAuth, (req, res) => {
  const wf = getWorkflow(req.params.id)
  if (!wf || (wf.userId && wf.userId !== req.user?.id)) return res.status(404).json({ error: 'workflow not found' })
  res.json({ ok: true, workflow: cancelWorkflow(req.params.id) })
})

app.post('/api/agent/workflows/:id/retry', requireAuth, (req, res) => {
  const wf = getWorkflow(req.params.id)
  if (!wf || (wf.userId && wf.userId !== req.user?.id)) return res.status(404).json({ error: 'workflow not found' })
  res.json({ ok: true, workflow: retryWorkflow(req.params.id) })
})

app.get('/api/agent/actions', requireAuth, (_req, res) => {
  res.json({ actions: listDeterministicActions() })
})

app.get('/api/agent/runs', requireAuth, (_req, res) => {
  res.json({ runs: listActiveAgentRuns() })
})

app.get('/api/agent/tasks', requireAuth, (req, res) => {
  res.json({ tasks: listAgentTasks({ chatId: String(req.query.chatId || ''), userId: req.user?.id || '', limit: req.query.limit || 20 }) })
})

app.get('/api/agent/tasks/latest', requireAuth, (req, res) => {
  res.json({ task: latestAgentTask({ chatId: String(req.query.chatId || ''), userId: req.user?.id || '', includeDone: true }) })
})

app.get('/api/agent/tasks/:id', requireAuth, (req, res) => {
  const task = getAgentTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'task not found' })
  res.json({ task })
})

app.post('/api/agent/tasks/:id/resume-note', requireAuth, (req, res) => {
  const task = getAgentTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'task not found' })
  res.json({ note: buildResumeSystemMessage(task), task })
})

app.post('/api/agent/runs/:chatId/reset', requireAuth, (req, res) => {
  const cleared = clearActiveAgentRun(req.params.chatId || '')
  res.json({ ok: true, cleared })
})

// Provider adapter metadata. Lets UI/self-tests understand which protocol
// the selected model will use before starting an agent run.
app.post('/api/agent/provider/capabilities', requireAuth, (req, res) => {
  const { baseUrl = '', model = '' } = req.body || {}
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' })
  res.json({ capabilities: getProviderCapabilities(baseUrl, model) })
})

// Lightweight provider diagnostic: capabilities + optional tiny probe.
// This does not expose secrets and returns a normalized provider_error on fail.
app.post('/api/agent/provider/diagnose', requireAuth, async (req, res) => {
  let {
    baseUrl = '', apiKey = '', model = '',
    authType = 'bearer', authHeader = '', extraHeaders = {},
    runProbe = true,
  } = req.body || {}
  if (!baseUrl || !model) return res.status(400).json({ error: 'baseUrl and model required' })

  // Managed DeepSeek injection — same logic as /api/chat and /api/agent/chat.
  let mergedExtraHeaders = extraHeaders
  if (isDeepSeekWebUrl(baseUrl) && (!apiKey || apiKey === '__managed__')) {
    const managedBearer = getDeepSeekBearer()
    const managedCookies = getDeepSeekCookieHeader()
    if (!managedBearer) {
      return res.status(503).json({
        ok: false,
        capabilities: getProviderCapabilities(baseUrl, model),
        providerError: normalizeProviderError(new Error('DeepSeek managed session is not configured'), { baseUrl, model, phase: 'diagnose' }),
      })
    }
    apiKey = managedBearer
    mergedExtraHeaders = { ...(extraHeaders || {}) }
    if (managedCookies && !Object.keys(mergedExtraHeaders).some((k) => k.toLowerCase() === 'cookie')) {
      mergedExtraHeaders.Cookie = managedCookies
    }
  }

  const capabilities = getProviderCapabilities(baseUrl, model)
  if (!runProbe) return res.json({ ok: true, capabilities, probe: null })
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      capabilities,
      providerError: normalizeProviderError(new Error('apiKey is required for probe'), { baseUrl, model, phase: 'diagnose' }),
    })
  }

  try {
    const reply = await callLLM({
      baseUrl, apiKey, model, authType, authHeader,
      extraHeaders: mergedExtraHeaders,
      messages: [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'Diagnostic ping.' },
      ],
      temperature: 0,
    })
    res.json({
      ok: true,
      capabilities,
      probe: {
        text: String(reply?.text || '').slice(0, 200),
        usage: reply?.usage || null,
      },
    })
  } catch (e) {
    res.status(502).json({
      ok: false,
      capabilities,
      providerError: normalizeProviderError(e, { baseUrl, model, phase: 'diagnose' }),
    })
  }
})

app.post('/api/agent/self-test', requireAuth, async (req, res) => {
  try {
    const { runAgentSelfTest } = await import('./agentSelfTest.js')
    const result = await runAgentSelfTest({
      userId: req.user?.id || '',
      chatId: String(req.body?.chatId || '').slice(0, 100),
    })
    res.status(result.ok ? 200 : 500).json(result)
  } catch (e) {
    res.status(500).json({
      schema: 'browserai.agent_self_test.v1',
      ok: false,
      error: e?.message || String(e),
    })
  }
})

app.get('/api/agent/health', requireAuth, async (req, res) => {
  const sandbox = await sandboxHealth()
  const browser = await browserHealth()
  res.json({
    deepseekManaged: Boolean(getDeepSeekState().alive),
    sandbox,
    browser,
  })
})

// Submit an answer to a pending ask_user question. The body is the answer
// payload the LLM will see as the tool result, typically
// { selected: ['opt1','opt2'], custom: 'optional free-form text' }.
app.get('/api/agent/questions', requireAuth, (req, res) => {
  const chatId = String(req.query?.chatId || '')
  res.json({ questions: listPendingQuestions({ userId: req.user?.id || '', chatId }) })
})

app.get('/api/agent/questions/:id', requireAuth, (req, res) => {
  const q = getPendingQuestion(String(req.params.id || ''), { userId: req.user?.id || '' })
  if (!q) return res.status(404).json({ error: 'question_id not found' })
  res.json({ question: q })
})

app.post('/api/agent/answer', requireAuth, (req, res) => {
  const { question_id, answer } = req.body || {}
  if (!question_id) return res.status(400).json({ error: 'question_id is required' })
  const ok = answerQuestion(String(question_id), answer ?? null, { userId: req.user?.id || '' })
  if (!ok) return res.status(404).json({ error: 'question_id not found, expired, already answered, or belongs to another user' })
  res.json({ ok: true })
})

app.post('/api/agent/questions/:id/cancel', requireAuth, (req, res) => {
  const reason = String(req.body?.reason || 'cancelled by user').slice(0, 300)
  const ok = cancelQuestion(String(req.params.id || ''), reason, { userId: req.user?.id || '' })
  if (!ok) return res.status(404).json({ error: 'question_id not found, expired, or belongs to another user' })
  res.json({ ok: true })
})

// Public-ish: lets the chat UI know whether a managed DeepSeek session is
// available without exposing the token. No auth required because it returns
// only booleans + model ids.
app.get('/api/deepseek/managed', requireAuth, (req, res) => {
  const s = getDeepSeekState()
  res.json({
    available: Boolean(s.hasToken && s.alive !== false),
    models: s.models || [],
    expiresAt: s.expiresAt,
  })
})

// ── Глобальный обработчик ошибок ───────────────────────────────────────────
// Express 5 автоматически передаёт сюда отклонённые промисы из async-роутов.
// Без этого middleware необработанное исключение отдавало бы дефолтную
// HTML-страницу со стектрейсом (утечка путей/инфраструктуры). Возвращаем
// безопасный JSON; подробности пишем только в серверный лог.
// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, next) => {
  console.error('[unhandled]', req.method, req.path, '-', err?.stack || err?.message || err)
  
  // Добавляем отправку ошибок Express в Telegram
  try {
    const { captureError } = await import('./monitoring.js')
    captureError('express', {
      message: `${req.method} ${req.path} - ${err?.message || 'Express error'}`,
      stack: err?.stack || '',
    })
  } catch (e) {
    console.error('Failed to capture express error', e)
  }

  if (res.headersSent) return
  res.status(err?.status || 500).json({ error: 'Внутренняя ошибка сервера' })
})

// Process-level error handlers + graceful shutdown (monitoring).
try {
  const { installProcessErrorHandlers, installGracefulShutdown } = await import('./monitoring.js')
  installProcessErrorHandlers()
  // installGracefulShutdown wires SIGTERM/SIGINT after app.listen below.
  globalThis.__ba_install_graceful = installGracefulShutdown
} catch (e) {
  console.warn('[monitoring] bootstrap failed:', e.message)
}

const httpServer = app.listen(PORT, () => {
  console.log(`BrowserAI API + SQLite + Workspace на http://localhost:${PORT}`)
})
try {
  globalThis.__ba_install_graceful?.({ server: httpServer })
} catch { /* ignore */ }

// Daily auto-backup (DB + workspace tarball; optional S3 push).
try {
  const { startBackupScheduler } = await import('./backup.js')
  startBackupScheduler()
} catch (e) {
  console.warn('[backup] bootstrap failed:', e.message)
}

// ── DeepSeek session auto-refresh bootstrap ────────────────────────────────
// Loads persisted token from /data/deepseek_session.json (or env vars on
// first boot), starts the 10-min heartbeat and hourly models refresh.
try {
  bootstrapDeepSeekSession()
} catch (e) {
  console.warn('[deepseek-refresh] bootstrap failed:', e.message)
}

// ── Telegram v2 single-bot interface ───────────────────────────────────────
// One token only (TG_BOT_TOKEN): admin menu + server ops + the same AI/agent
// pipeline as the web app. Replaces legacy deepseekBot/userTelegramBot.
try {
  startTelegramBot()
} catch (e) {
  console.warn('[tg-v2] bootstrap failed:', e.message)
}

// Cron worker — polls every 60 s for due scheduled jobs.
try {
  const { startCronWorker } = await import('./cron.js')
  startCronWorker()
} catch (e) {
  console.warn('[cron] bootstrap failed:', e.message)
}

// Production watchdog — safe health monitor that opens incidents and diagnostics.
try {
  const { startProductionWatchdog } = await import('./productionWatchdog.js')
  startProductionWatchdog()
} catch (e) {
  console.warn('[watchdog] bootstrap failed:', e.message)
}

// MCP hub — spawn any servers listed in /data/mcp.json (disabled by default).
try {
  const { startMcpHub } = await import('./mcpClient.js')
  startMcpHub().catch((e) => console.warn('[mcp] hub start failed:', e?.message || e))
} catch (e) {
  console.warn('[mcp] bootstrap failed:', e.message)
}

