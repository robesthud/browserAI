/**
 * User-defined tools (MCP-style, but simpler).
 *
 * A custom tool is a JSON descriptor stored in SQLite (per-user) that the
 * agent loop registers alongside the built-in tools (server/agentTools.js).
 * Two backends are supported:
 *
 *   type: 'http'    — calls a remote HTTP endpoint with the agent's args.
 *                     Body templating: any "{{key}}" in url/headers/body
 *                     is replaced by args.key before the fetch.
 *
 *   type: 'webhook' — fire-and-forget POST. Returns {sent:true} immediately.
 *
 * Schema (stored as JSON in user_tools.descriptor):
 *   {
 *     name:        "weather",                       // [a-z][a-z0-9_]{2,40}
 *     description: "Get current weather for a city",
 *     params: { city: { type: 'string', required: true } },
 *     type:        "http",
 *     method:      "GET",                           // default GET
 *     url:         "https://wttr.in/{{city}}?format=j1",
 *     headers:     { Authorization: "Bearer {{api_key}}" }, // optional
 *     body:        null,                            // string or object
 *     timeout_ms:  10000,
 *     auth_env:    "WTTR_API_KEY"                   // optional — server env to inject
 *   }
 *
 * Safety:
 *   - URL is validated through the existing SSRF guard (isBlockedHost).
 *   - Per-user cap of 30 custom tools.
 *   - HTTP timeout always capped at 30 s.
 *   - Headers / body never echoed to the LLM in error messages.
 */
import db from './db.js'
import { isBlockedHost } from './ssrf.js'

let initialized = false
function init() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_tools (
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      descriptor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_tools_user ON user_tools(user_id);
  `)
  initialized = true
}

const MAX_TOOLS_PER_USER = 30
const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/i

function validateDescriptor(d) {
  if (!d || typeof d !== 'object') throw new Error('descriptor must be object')
  if (!NAME_RE.test(String(d.name || ''))) throw new Error('name must match [a-zA-Z][a-zA-Z0-9_]{2,40}')
  if (!d.description || typeof d.description !== 'string') throw new Error('description required')
  if (!['http', 'webhook'].includes(d.type)) throw new Error('type must be http or webhook')
  if (!d.url || typeof d.url !== 'string') throw new Error('url required')
  try { new URL(d.url.replace(/{{[^}]+}}/g, 'x')) } catch { throw new Error('url is not a valid URL') }
  if (d.method && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(d.method)) throw new Error('unsupported method')
  if (d.params && typeof d.params !== 'object') throw new Error('params must be object')
}

export function listCustomTools(userId) {
  init()
  if (!userId) return []
  return db.prepare('SELECT name, descriptor, updated_at FROM user_tools WHERE user_id = ? ORDER BY name').all(userId)
    .map((r) => ({ ...r, descriptor: JSON.parse(r.descriptor) }))
}

export function upsertCustomTool(userId, descriptor) {
  init()
  if (!userId) throw new Error('userId required')
  validateDescriptor(descriptor)
  const r = db.prepare('SELECT COUNT(*) c FROM user_tools WHERE user_id=?').get(userId)
  if (r.c >= MAX_TOOLS_PER_USER) {
    const existing = db.prepare('SELECT 1 FROM user_tools WHERE user_id=? AND name=?').get(userId, descriptor.name)
    if (!existing) throw new Error(`limit ${MAX_TOOLS_PER_USER} reached`)
  }
  const ts = Date.now()
  db.prepare(`
    INSERT INTO user_tools (user_id, name, descriptor, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET descriptor=excluded.descriptor, updated_at=excluded.updated_at
  `).run(userId, descriptor.name, JSON.stringify(descriptor), ts, ts)
  return { name: descriptor.name }
}

export function deleteCustomTool(userId, name) {
  init()
  if (!userId) throw new Error('userId required')
  const r = db.prepare('DELETE FROM user_tools WHERE user_id=? AND name=?').run(userId, name)
  return { deleted: r.changes }
}

/** Render a custom-tool descriptor into the same shape agentTools.js uses. */
export function buildToolEntry(descriptor) {
  return {
    description: descriptor.description,
    params: descriptor.params || {},
    handler: async (args = {}) => {
      // A — whitelist of env-var name patterns allowed in auth_env (no AUTH_SECRET, DB_*, etc.)
      const AUTH_ENV_ALLOW = /^[A-Z][A-Z0-9_]{0,63}$/
      const safeAuthEnv = descriptor.auth_env && AUTH_ENV_ALLOW.test(String(descriptor.auth_env))
        // Only allow vars that look like external API keys (contain KEY, TOKEN, SECRET, API, ID)
        // AND are not known internal BrowserAI secrets
        && /KEY|TOKEN|SECRET|API|ID/i.test(String(descriptor.auth_env))
        && !/^(AUTH_SECRET|DB_|SCRYPT_|GITHUB_WEBHOOK|BROWSERAI_ADMIN|ADMIN_PASS)/.test(String(descriptor.auth_env))
        ? String(descriptor.auth_env) : null

      const subst = (s) => String(s || '').replace(/{{([a-zA-Z0-9_]+)}}/g, (_, k) => {
        if (k === 'auth' && safeAuthEnv) return process.env[safeAuthEnv] || ''
        const v = args[k]
        return v == null ? '' : String(v)
      })

      const url = subst(descriptor.url)
      try {
        const u = new URL(url)
        if (isBlockedHost(u.hostname)) return { ok: false, error: 'custom-tool URL points at a blocked (internal) host' }
      } catch (e) { return { ok: false, error: `bad URL after substitution: ${e.message}` } }

      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
      // A — strip CRLF from header keys+values (HTTP header injection guard)
      for (const [k, v] of Object.entries(descriptor.headers || {})) {
        const sk = String(k || '').replace(/[\r\n]/g, '').slice(0, 128)
        if (sk) headers[sk] = subst(v).replace(/[\r\n]/g, '')
      }
      if (descriptor.auth_env && process.env[descriptor.auth_env] && !headers.Authorization) {
        headers.Authorization = `Bearer ${process.env[descriptor.auth_env]}`
      }

      let body = null
      if (descriptor.body != null) {
        try {
          body = typeof descriptor.body === 'string' ? subst(descriptor.body) : JSON.stringify(JSON.parse(subst(JSON.stringify(descriptor.body))))
        } catch (e) { return { ok: false, error: `body serialization failed: ${e.message}` } }
      } else if (descriptor.type === 'http' && descriptor.method && descriptor.method !== 'GET') {
        body = JSON.stringify(args)
      }

      const method = descriptor.type === 'webhook' ? 'POST' : (descriptor.method || 'GET')
      const timeoutMs = Math.min(30_000, Math.max(1_000, Number(descriptor.timeout_ms) || 10_000))

      try {
        const r = await fetch(url, {
          method,
          headers,
          body: body || undefined,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (descriptor.type === 'webhook') return { ok: true, result: { sent: true, status: r.status } }
        const text = await r.text()
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = text }
        return { ok: true, result: parsed }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
  }
}

/** Render all of a user's custom tools as a {name → entry} map. */
export function loadCustomToolsFor(userId) {
  const out = {}
  for (const row of listCustomTools(userId)) {
    try { out[row.descriptor.name] = buildToolEntry(row.descriptor) }
    catch { /* skip malformed */ }
  }
  return out
}
