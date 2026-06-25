import express from 'express'
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import db from '../db.js'
import { sha256, passwordHash, verifyPassword } from '../crypto.js'
import { loginIpLimiter } from '../securityHardening.js'

// Кешированный statement для производительности — вызывается на каждый запрос
const _stmtGetSession = db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    LIMIT 1
  `)

const router = express.Router()

const AUTH_COOKIE = 'browserai_session'
const SESSION_DAYS = 30

export function getSessionUser(req) {
  const rawCookie = req.headers.cookie || ''
  const cookies = Object.fromEntries(rawCookie.split(';').map(v => {
    const eqIdx = v.indexOf('=')
    if (eqIdx === -1) return [v.trim(), '']
    // Берём всё после первого '=' — value может содержать '=' (base64, base64url)
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

// ... (rest of auth routes)
router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user) })
})

router.post('/login', loginIpLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  try {
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email)
    // verifyPassword async — scrypt не блокирует event loop и не роняет mem_limit
    const ok = user && await verifyPassword(password, user.password_hash)
    if (!ok) {
      return res.status(401).json({ error: 'Неверный email или пароль' })
    }
    const token = crypto.randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), user.id, sha256(token), Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000, Date.now())
    const maxAge = SESSION_DAYS * 24 * 60 * 60
    const secure = process.env.NODE_ENV === 'production' && (process.env.APP_URL || '').startsWith('https')
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`)
    res.json({ user: publicUser(user) })
  } catch (e) {
    console.error('[auth] login error:', e?.message || e)
    res.status(500).json({ error: 'Ошибка сервера при входе. Попробуйте ещё раз.' })
  }
})

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  res.json({ ok: true })
})

export default router
