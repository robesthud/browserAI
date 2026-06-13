/**
 * Lightweight structured JSON logger.
 * Outputs one JSON line per log entry for production log parsing.
 */
const IS_DEV = process.env.NODE_ENV !== 'production'

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    pid: process.pid,
    ...meta,
  }
  const line = JSON.stringify(entry)
  if (IS_DEV) {
    // In dev, pretty-print for human readability
    console.log(`[${level}] ${message}`, meta && Object.keys(meta).length ? meta : '')
  } else {
    console.log(line)
  }
}

export const info = (msg, meta) => log('info', msg, meta)
export const warn = (msg, meta) => log('warn', msg, meta)
export const error = (msg, meta) => log('error', msg, meta)
export default { info, warn, error }
