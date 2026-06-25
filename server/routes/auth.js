import express from 'express'
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import db from '../db.js'
import { sha256, passwordHashAsync, verifyPassword } from '../crypto.js'
import { loginIpLimiter } from '../securityHardening.js'

const _stmtGetSession = db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    LIMIT 1
  `)

const router = express.Router()

const AUTH_COOKIE = 'browserai_session'
const SESSION_DAYS = 30
const RESET_TTL_MS = 60 * 60 * 1000

let mailer = null
let mailerInit = false

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
    CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
  `)
} catch (e) {
  console.error('[auth] failed to ensure password_resets table:', e?.message || e)
}

function getMailer() {
  if (mailerInit) return mailer
  mailerInit = true
  const host = process.env.SMTP_HOST || ''
  const port = Number(process.env.SMTP_PORT || 587)
  const user = process.env.SMTP_USER || ''
  const pass = process.env.SMTP_PASS || ''
  if (!host || !user || !pass) return null
  mailer = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
  return mailer
}

function validEmail(email = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
}

function normalizePhone(phone = '') {
  const raw = String(phone || '').trim()
  if (!raw) return null
  return raw.replace(/[^+\d]/g, '') || null
}

function validatePassword(password = '') {
  const value = String(password || '')
  if (value.length < 10) return 'Пароль должен содержать минимум 10 символов.'
  if (!/[A-ZА-ЯЁ]/.test(value)) return 'Пароль должен содержать заглавную букву.'
  if (!/[a-zа-яё]/.test(value)) return 'Пароль должен содержать строчную букву.'
  if (!/\d/.test(value)) return 'Пароль должен содержать цифру.'
  if (!/[^A-Za-zА-Яа-яЁё\d]/.test(value)) return 'Пароль должен содержать спецсимвол.'
  return ''
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60
  const secure = process.env.NODE_ENV === 'production' && (process.env.APP_URL || '').startsWith('https')
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`)
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), userId, sha256(token), Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000, Date.now())
  return token
}

export function getSessionUser(req) {
  const rawCookie = req.headers.cookie || ''
  const cookies = Object.fromEntries(rawCookie.split(';').map(v => {
    const eqIdx = v.indexOf('=')
    if (eqIdx === -1) return [v.trim(), '']
    return [v.slice(0, eqIdx).trim(), v.slice(eqIdx + 1).trim()]
  }))
  const token = cookies[AUTH_COOKIE]
  if (!token) return null
  let decodedToken
  try { decodedToken = decodeURIComponent(token) } catch { decodedToken = token }
  const tokenHash = sha256(decodedToken)
  const row = _stmtGetSession.get(tokenHash, Date.now())
  return row || null
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

async function sendResetEmail(email, resetLink) {
  const transport = getMailer()
  if (!transport) {
    console.log(`[auth] password reset link for ${email}: ${resetLink}`)
    return false
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER
  await transport.sendMail({
    from,
    to: email,
    subject: 'BrowserAI — сброс пароля',
    text: `Перейдите по ссылке для сброса пароля: ${resetLink}`,
    html: `<p>Перейдите по ссылке для сброса пароля:</p><p><a href="${resetLink}">${resetLink}</a></p>`,
  })
  return true
}

router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user) })
})

router.post('/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const name = String(req.body?.name || '').trim()
  const phone = normalizePhone(req.body?.phone)
  const password = String(req.body?.password || '')
  const registrationSecret = String(req.body?.registrationSecret || '').trim()

  if (!validEmail(email)) return res.status(400).json({ error: 'Введите корректный email.' })
  const passwordError = validatePassword(password)
  if (passwordError) return res.status(400).json({ error: passwordError })

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email)
    if (existing) return res.status(409).json({ error: 'Пользователь с таким email уже существует.' })

    const userCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count || 0)
    const requiredSecret = String(process.env.REGISTRATION_SECRET || '').trim()
    if (userCount > 0 && requiredSecret && registrationSecret !== requiredSecret) {
      return res.status(403).json({ error: 'Неверный секрет регистрации.' })
    }

    const now = Date.now()
    const id = crypto.randomUUID()
    const role = userCount === 0 ? 'owner' : 'user'
    const passwordHash = await passwordHashAsync(password)
    db.prepare(`INSERT INTO users (id,email,name,phone,password_hash,role,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, email, name || '', phone, passwordHash, role, now, now)

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id)
    const token = createSession(id)
    setSessionCookie(res, token)
    res.status(201).json({ user: publicUser(user) })
  } catch (e) {
    console.error('[auth] register error:', e?.message || e)
    res.status(500).json({ error: 'Ошибка сервера при регистрации. Попробуйте ещё раз.' })
  }
})

router.post('/login', loginIpLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  try {
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email)
    const ok = user && await verifyPassword(password, user.password_hash)
    if (!ok) {
      return res.status(401).json({ error: 'Неверный email или пароль' })
    }
    const token = createSession(user.id)
    setSessionCookie(res, token)
    res.json({ user: publicUser(user) })
  } catch (e) {
    console.error('[auth] login error:', e?.message || e)
    res.status(500).json({ error: 'Ошибка сервера при входе. Попробуйте ещё раз.' })
  }
})

router.post('/logout', (req, res) => {
  clearSessionCookie(res)
  res.json({ ok: true })
})

router.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  try {
    if (!validEmail(email)) return res.json({ ok: true })
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email)
    if (!user) return res.json({ ok: true })
    const token = crypto.randomBytes(32).toString('base64url')
    const now = Date.now()
    db.prepare('INSERT INTO password_resets (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), user.id, sha256(token), now + RESET_TTL_MS, now)
    const appUrl = String(process.env.APP_URL || '').trim() || 'http://localhost'
    const resetLink = `${appUrl}/?reset_token=${encodeURIComponent(token)}`
    await sendResetEmail(email, resetLink)
    res.json({ ok: true })
  } catch (e) {
    console.error('[auth] forgot-password error:', e?.message || e)
    res.json({ ok: true })
  }
})

router.post('/reset-password', async (req, res) => {
  const token = String(req.body?.token || '').trim()
  const password = String(req.body?.password || '')
  const passwordError = validatePassword(password)
  if (passwordError) return res.status(400).json({ error: passwordError })
  if (!token) return res.status(400).json({ error: 'Токен сброса не указан.' })
  try {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND expires_at>? ORDER BY created_at DESC LIMIT 1')
      .get(sha256(token), Date.now())
    if (!row) return res.status(400).json({ error: 'Ссылка сброса недействительна или устарела.' })
    const passwordHash = await passwordHashAsync(password)
    db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(passwordHash, Date.now(), row.user_id)
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(row.user_id)
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id)
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id)
    const newToken = createSession(row.user_id)
    setSessionCookie(res, newToken)
    res.json({ ok: true, user: publicUser(user) })
  } catch (e) {
    console.error('[auth] reset-password error:', e?.message || e)
    res.status(500).json({ error: 'Не удалось изменить пароль. Попробуйте ещё раз.' })
  }
})

router.post('/sms-send', (req, res) => {
  res.status(501).json({ error: 'Сброс по SMS пока не настроен на сервере.' })
})

router.post('/sms-verify', (req, res) => {
  res.status(501).json({ error: 'Сброс по SMS пока не настроен на сервере.' })
})

router.put('/phone', (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' })
  const phone = normalizePhone(req.body?.phone)
  try {
    db.prepare('UPDATE users SET phone=?, updated_at=? WHERE id=?').run(phone, Date.now(), req.user.id)
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
    res.json({ user: publicUser(user) })
  } catch (e) {
    console.error('[auth] update phone error:', e?.message || e)
    res.status(500).json({ error: 'Не удалось обновить телефон.' })
  }
})

export default router

