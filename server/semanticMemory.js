/**
 * Long-term semantic memory — the "I remember everything from past chats"
 * piece that makes BrowserAI's agent feel like Claude/Arena.
 *
 * Strategy:
 *  1. After every assistant turn we ask the SAME LLM to extract 0–3
 *     "memorable facts" worth keeping across sessions (preferences,
 *     facts about the user's projects, ongoing decisions). Stored in
 *     `semantic_memory` with a small dense embedding + the raw text.
 *  2. On every NEW agent turn we embed the user's message, do a cosine
 *     search over that user's stored memories, and inject the top-K
 *     into the system prompt as "Relevant context from past chats".
 *
 * Embeddings — we use the SAME provider as the chat call when it exposes
 *   POST /v1/embeddings (OpenAI-compatible). For DeepSeek Web / Gemini Web
 *   we fall back to a deterministic hashed bag-of-words vector (256 dim).
 *   Cheap, no extra network round-trip, still measurably better than
 *   simple keyword search for "тот проект где мы делали оживление видео".
 *
 * Storage caps per user:
 *   - 500 memories max
 *   - each text ≤ 600 chars
 *   - oldest pruned on overflow
 */
import db from './db.js'
import { workspaceScope } from './workspace.js'

let initialized = false
function init() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_memory (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      chat_id      TEXT,
      text         TEXT NOT NULL,
      vector_json  TEXT NOT NULL,
      dim          INTEGER NOT NULL,
      score_hits   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sm_user ON semantic_memory(user_id);
    CREATE INDEX IF NOT EXISTS idx_sm_created ON semantic_memory(created_at);
    
    -- FTS5 Virtual Table for incredibly fast exact-phrase and keyword search on our VPS
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memory_fts USING fts5(mem_id UNINDEXED, text);
  `)
  initialized = true
}

const MAX_PER_USER = 500
const MAX_TEXT_LEN = 600
const HASH_DIM = 256
const RECALL_TOP_K = 5

// ── Cheap built-in embedder ────────────────────────────────────────────────
// 256-dimensional hashed bag-of-words. Deterministic, no external calls.
// Quality: roughly comparable to BM25 on short texts; loses to real
// embeddings on synonyms, but good enough as fallback when the provider
// doesn't expose /embeddings (DeepSeek Web, Gemini Web).
function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) | 0
  return Math.abs(h)
}
function localEmbed(text) {
  const v = new Float32Array(HASH_DIM)
  for (const t of tokenize(text)) v[hashStr(t) % HASH_DIM] += 1
  // Sub-linear scaling so frequent terms don't dominate.
  for (let i = 0; i < HASH_DIM; i += 1) if (v[i] > 0) v[i] = Math.log(1 + v[i])
  // L2 normalize so cosine becomes a simple dot product.
  let n = 0; for (let i = 0; i < HASH_DIM; i += 1) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < HASH_DIM; i += 1) v[i] /= n
  return Array.from(v)
}

// ── Provider-backed embedder (preferred) ──────────────────────────────────
async function providerEmbed(text, provider) {
  if (!provider?.baseUrl || !provider?.apiKey) return null
  if (provider.apiKey === '__managed__' || provider.apiKey === '__gateway__') return null
  
  // Pick a sensible embeddings model based on provider hostname.
  let model = 'text-embedding-3-small'
  if (provider.baseUrl.includes('mistral')) model = 'mistral-embed'
  else if (provider.baseUrl.includes('cohere')) model = 'embed-english-v3.0'
  else if (provider.baseUrl.includes('voyage')) model = 'voyage-3-lite'
  
  // #14 FIX: deepseek and some other providers don't support /embeddings at all
  // or use a different base URL. If it's deepseek, don't even try - save time and hang risk.
  if (provider.baseUrl.includes('deepseek.com')) return null
  // Ollama exposes embeddings at a different path (/api/embeddings) and NOT at
  // the OpenAI-compatible /v1/embeddings we build below → every call 404'd and
  // spammed the logs. Fall back to the local hashed embedder instead.
  if (provider.baseUrl.includes('ollama') || provider.baseUrl.includes(':11434')) return null

  const url = `${String(provider.baseUrl).replace(/\/$/, '')}/embeddings`
  // A — SSRF guard: don't embed via internal/loopback hosts
  try {
    const { isBlockedHost } = await import('./ssrf.js')
    const _u = new URL(url)
    if (isBlockedHost(_u.hostname)) return null
  } catch { /* URL parse error → let fetch fail naturally */ }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model, input: String(text || '').slice(0, 2000) }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const j = await r.json().catch(() => null)
    const v = j?.data?.[0]?.embedding
    if (!Array.isArray(v)) return null
    // L2-normalize so we can use plain dot-product as cosine later.
    let n = 0; for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    return v.map((x) => x / n)
  } catch { return null }
}

export async function embed(text, { provider } = {}) {
  const v = provider ? await providerEmbed(text, provider) : null
  return v || localEmbed(text)
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

// ── Public API ─────────────────────────────────────────────────────────────
export async function rememberMemory(userId, text, { chatId = '', provider } = {}) {
  init()
  if (!userId) throw new Error('userId required')
  const clean = String(text || '').trim().slice(0, MAX_TEXT_LEN)
  if (!clean) return null
  const vector = await embed(clean, { provider })
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ts = Date.now()
  db.prepare(`
    INSERT INTO semantic_memory (id, user_id, chat_id, text, vector_json, dim, score_hits, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, userId, chatId || '', clean, JSON.stringify(vector), vector.length, ts, ts)
  
  // Sync insert into FTS5
  try {
    db.prepare(`INSERT INTO semantic_memory_fts (mem_id, text) VALUES (?, ?)`).run(id, clean)
  } catch { /* best-effort */ }

  // Trim oldest if we overflow.
  const overflow = db.prepare('SELECT COUNT(*) c FROM semantic_memory WHERE user_id=?').get(userId).c
  if (overflow > MAX_PER_USER) {
    const toDeleteRows = db.prepare(`SELECT id FROM semantic_memory WHERE user_id=? ORDER BY last_used_at ASC LIMIT ?`).all(userId, overflow - MAX_PER_USER)
    const deleteIds = toDeleteRows.map((r) => r.id)
    if (deleteIds.length > 0) {
      db.prepare(`DELETE FROM semantic_memory WHERE id IN (${deleteIds.map(() => '?').join(',')})`).run(...deleteIds)
      try {
        db.prepare(`DELETE FROM semantic_memory_fts WHERE mem_id IN (${deleteIds.map(() => '?').join(',')})`).run(...deleteIds)
      } catch { /* best-effort */ }
    }
  }
  return { id }
}

export async function recallMemory(userId, query, { topK = RECALL_TOP_K, provider } = {}) {
  init()
  if (!userId || !query) return []
  const qv = await embed(query, { provider })

  // Fast exact-keyword/FTS5 sparse pre-search to boost matches
  let ftsIds = new Set()
  try {
    // D — guard empty query after sanitize: '' + '*' = '*' matches ALL rows in FTS5
    const ftsQuery = query.trim().replace(/[*"']/g, '').trim()
    if (!ftsQuery) throw new Error('empty FTS query')
    const ftsRows = db.prepare(`
      SELECT mem_id FROM semantic_memory_fts WHERE text MATCH ? LIMIT 30
    `).all(ftsQuery + '*') // wildcard safe
    ftsIds = new Set(ftsRows.map((r) => r.mem_id))
  } catch { /* FTS5 empty or wildcard syntax error */ }

  // Pull ALL rows whose dim matches the query vector — switching providers
  // mid-session might leave heterogeneous dims; we just ignore the rest.
  const _scopeChat = workspaceScope.getStore()?.chatId
    const _sql = _scopeChat
      ? 'SELECT id, text, vector_json, dim FROM semantic_memory WHERE user_id=? AND chat_id=?'
      : 'SELECT id, text, vector_json, dim FROM semantic_memory WHERE user_id=?'
    const rows = _scopeChat
      ? db.prepare(_sql).all(userId, _scopeChat)
      : db.prepare(_sql).all(userId)
  const scored = []
  for (const r of rows) {
    if (r.dim !== qv.length) continue
    let v
    try { v = JSON.parse(r.vector_json) } catch { continue }
    let s = cosine(qv, v)
    if (ftsIds.has(r.id)) {
      s += 0.35 // Hybrid search boost! Greatly improves exact match quality!
    }
    if (s > 0.15) scored.push({ id: r.id, text: r.text, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, Math.max(1, Math.min(20, Number(topK) || RECALL_TOP_K)))
  // Bump usage counters for the picked ones — keeps useful memories alive.
  if (top.length) {
    const now = Date.now()
    const stmt = db.prepare('UPDATE semantic_memory SET score_hits=score_hits+1, last_used_at=? WHERE id=?')
    for (const t of top) stmt.run(now, t.id)
  }
  return top
}

/**
 * Format the top-K recalled memories as a markdown block ready to be
 * prepended to the agent system prompt.
 */
export async function renderRecallForPrompt(userId, query, opts = {}) {
  const top = await recallMemory(userId, query, opts)
  if (top.length === 0) return ''
  const lines = ['# Relevant context from past chats (long-term memory)', '']
  for (const t of top) lines.push(`- (${t.score.toFixed(2)}) ${t.text}`)
  lines.push('')
  lines.push('Use these when they help, ignore if irrelevant.')
  return lines.join('\n')
}

export function listMemories(userId, { limit = 50 } = {}) {
  init()
  if (!userId) return []
  return db.prepare(
    (workspaceScope.getStore()?.chatId
      ? 'SELECT id, text, score_hits, created_at, last_used_at FROM semantic_memory WHERE user_id=? AND chat_id=? ORDER BY last_used_at DESC LIMIT ?'
      : 'SELECT id, text, score_hits, created_at, last_used_at FROM semantic_memory WHERE user_id=? ORDER BY last_used_at DESC LIMIT ?')
  ).all(
      ...(workspaceScope.getStore()?.chatId ? [userId, workspaceScope.getStore().chatId] : [userId]),
      Math.max(1, Math.min(200, Number(limit) || 50))
    )
}

export function forgetMemory(userId, id) {
  init()
  const _scopeChat = workspaceScope.getStore()?.chatId
    const r = _scopeChat
      ? db.prepare('DELETE FROM semantic_memory WHERE user_id=? AND chat_id=? AND id=?').run(userId, _scopeChat, id)
      : db.prepare('DELETE FROM semantic_memory WHERE user_id=? AND id=?').run(userId, id)
  try {
    db.prepare('DELETE FROM semantic_memory_fts WHERE mem_id=?').run(id)
  } catch { /* best-effort */ }
  return { deleted: r.changes }
}
