/**
 * Lightweight monitoring + error tracking for BrowserAI.
 *
 * Three responsibilities:
 *   1. process-level error capture (uncaughtException, unhandledRejection)
 *      → write to /data/errors.log + fan out to Telegram admin
 *   2. periodic system metrics (RSS, heap, process up-time, sandbox liveness)
 *      → /api/health/metrics
 *   3. graceful shutdown hook so the docker stop signal flushes the DB
 *      WAL and closes the server cleanly.
 *
 * No external dependencies (no Sentry SDK) — we just want the same
 * 'something exploded, tell me on TG' behaviour. Errors deduped by a
 * rolling hash so a tight crash loop doesn't pager-storm the admin.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DATA_DIR = process.env.DATA_DIR || '/data'
const ERR_LOG = path.join(DATA_DIR, 'errors.log')

const seenRecently = new Map()    // hash → ts
const DEDUPE_WINDOW_MS = 5 * 60_000
const TG_TOKEN = process.env.TG_BOT_TOKEN || ''
const TG_ADMIN = process.env.TG_ADMIN_CHAT_ID || ''

const startedAt = Date.now()

function ensureDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }) }
  catch { /* ignore */ }
}

function hashEvent(kind, payload) {
  const s = `${kind}::${(payload?.stack || payload?.message || JSON.stringify(payload) || '').slice(0, 400)}`
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16)
}

async function notifyTelegram(text) {
  if (!TG_TOKEN || !TG_ADMIN) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_ADMIN, text: String(text || '').slice(0, 3500) }),
      signal: AbortSignal.timeout(8000),
    })
  } catch { /* best-effort */ }
}

export function captureError(kind, payload = {}) {
  const h = hashEvent(kind, payload)
  const now = Date.now()
  const last = seenRecently.get(h)
  if (last && now - last < DEDUPE_WINDOW_MS) return
  seenRecently.set(h, now)
  // Garbage-collect old entries
  if (seenRecently.size > 200) {
    for (const [k, v] of seenRecently) if (now - v > DEDUPE_WINDOW_MS * 4) seenRecently.delete(k)
  }

  const line = JSON.stringify({
    ts: new Date(now).toISOString(),
    kind,
    host: os.hostname(),
    pid: process.pid,
    ...payload,
  })
  ensureDir()
  try { appendFileSync(ERR_LOG, line + '\n') } catch { /* ignore */ }

  // Telegram notification — high signal: only top frame + first 600 chars
  // of stack/message.
  void notifyTelegram(
    `🚨 BrowserAI ${kind}\n` +
    `host: ${os.hostname()}\n` +
    (payload.message ? `msg: ${String(payload.message).slice(0, 400)}\n` : '') +
    (payload.stack ? `stack: ${String(payload.stack).slice(0, 600)}\n` : '')
  )
}

export function installProcessErrorHandlers() {
  process.on('uncaughtException', (err) => {
    captureError('uncaughtException', { message: err?.message, stack: err?.stack })
  })
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    captureError('unhandledRejection', { message: err.message, stack: err.stack })
  })
  console.log('[monitoring] process error handlers installed')
}

export function installGracefulShutdown({ server, beforeExit } = {}) {
  const stop = async (sig) => {
    console.log(`[monitoring] received ${sig}, shutting down…`)
    try { if (typeof beforeExit === 'function') await beforeExit() } catch { /* ignore */ }
    if (server && typeof server.close === 'function') {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 8000).unref()
    } else { process.exit(0) }
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT',  () => stop('SIGINT'))
}

export function snapshotMetrics() {
  const mem = process.memoryUsage()
  return {
    pid: process.pid,
    nodeVersion: process.version,
    upSec: Math.round((Date.now() - startedAt) / 1000),
    rssMB: Math.round(mem.rss / (1024 * 1024)),
    heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    heapTotalMB: Math.round(mem.heapTotal / (1024 * 1024)),
    loadavg: os.loadavg(),
    freememMB: Math.round(os.freemem() / (1024 * 1024)),
    totalmemMB: Math.round(os.totalmem() / (1024 * 1024)),
    cpus: os.cpus().length,
  }
}

/**
 * Client-side error reporter — used by the existing
 *   POST /api/debug/client-error
 * endpoint shape. Just calls captureError with kind:'client'.
 */
export function captureClientError(body = {}) {
  captureError('client', {
    message: body.message || '',
    stack: String(body.stack || '').slice(0, 2000),
    url: body.url || '',
    ua: body.ua || '',
    kind: body.kind || 'client',
  })
}
