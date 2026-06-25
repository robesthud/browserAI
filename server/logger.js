/**
 * Lightweight structured JSON logger.
 * Outputs one JSON line per log entry for production log parsing.
 */
import { safeLogMeta } from './errorSanitizer.js'

const IS_DEV = process.env.NODE_ENV !== 'production'

function log(level, message, meta = {}) {
  const cleanMeta = safeLogMeta(meta || {})
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    pid: process.pid,
    ...cleanMeta,
  }
  const line = JSON.stringify(entry)
  if (IS_DEV) {
    // In dev, pretty-print for human readability
    console.log(`[${level}] ${message}`, cleanMeta && Object.keys(cleanMeta).length ? cleanMeta : '')
  } else {
    console.log(line)
  }
}

export const info = (msg, meta) => log('info', msg, meta)
export const warn = (msg, meta) => log('warn', msg, meta)
export const error = (msg, meta) => log('error', msg, meta)
export default { info, warn, error }
