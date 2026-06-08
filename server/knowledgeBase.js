/**
 * Tiny per-user knowledge base for retrieval-augmented chat.
 *
 * Documents are chunked into ~600-char passages, each gets a sparse
 * TF-IDF representation stored as a JSON blob. Search uses cosine
 * similarity on a query's TF-IDF vector and returns the top-K passages
 * with their parent document. No embeddings required → works offline,
 * no GPU, no cost. Good enough for ~hundreds of docs per user.
 *
 * For a future RAG upgrade we'd add a `vector` column with sentence-
 * transformer embeddings; the cosine code below is already shaped for it.
 *
 * Limits:
 *   - 100 documents/user
 *   - per-doc raw text ≤ 256 KB
 *   - chunk size 600 chars, overlap 60
 *   - vocabulary ~30k tokens (lower-cased, alpha-num + _, length ≥ 2)
 */
import db from './db.js'

let initialized = false
function init() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT NOT NULL,
      source      TEXT,
      created_at  INTEGER NOT NULL,
      bytes       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kb_user ON kb_documents(user_id);

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id           TEXT PRIMARY KEY,
      doc_id       TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      ord          INTEGER NOT NULL,
      text         TEXT NOT NULL,
      tfidf_json   TEXT NOT NULL,
      FOREIGN KEY(doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_user ON kb_chunks(user_id);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc  ON kb_chunks(doc_id);
  `)
  initialized = true
}

const MAX_DOCS_PER_USER = 100
const MAX_TEXT_BYTES = 256 * 1024
const CHUNK_SIZE = 600
const CHUNK_OVERLAP = 60

const STOP = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'he','her','him','his','i','if','in','is','it','its','my','no','not','of',
  'on','or','our','she','so','than','that','the','their','them','then','they',
  'this','to','was','we','were','will','with','you','your','it’s','что','это',
  'как','на','в','и','с','по','для','что','же','от','до','к','а','но','или',
  'мы','вы','я','он','она','оно','они','о','об','а','же','ли','бы','быть',
])

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

function tf(tokens) {
  const map = new Map()
  for (const t of tokens) map.set(t, (map.get(t) || 0) + 1)
  // Normalise to log(1+f) so common words don't dominate.
  for (const [k, v] of map) map.set(k, Math.log(1 + v))
  return map
}

function dot(a, b) {
  let s = 0
  for (const [k, va] of a) {
    const vb = b.get(k)
    if (vb) s += va * vb
  }
  return s
}
function magnitude(m) {
  let s = 0
  for (const v of m.values()) s += v * v
  return Math.sqrt(s)
}

function chunkText(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    out.push(text.slice(i, i + CHUNK_SIZE))
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return out.length ? out : [text]
}

export function listDocuments(userId) {
  init()
  if (!userId) return []
  return db.prepare(`
    SELECT d.id, d.title, d.source, d.created_at, d.bytes,
           (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) AS chunks
    FROM kb_documents d
    WHERE d.user_id = ?
    ORDER BY d.created_at DESC
  `).all(userId)
}

export function addDocument(userId, { title, source = '', text }) {
  init()
  if (!userId) throw new Error('userId required')
  if (!title) throw new Error('title required')
  const body = String(text || '')
  if (!body) throw new Error('text required')
  if (Buffer.byteLength(body, 'utf-8') > MAX_TEXT_BYTES) throw new Error(`text > ${MAX_TEXT_BYTES} bytes`)

  const count = db.prepare('SELECT COUNT(*) c FROM kb_documents WHERE user_id=?').get(userId).c
  if (count >= MAX_DOCS_PER_USER) throw new Error(`limit ${MAX_DOCS_PER_USER} docs reached`)

  const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ts = Date.now()
  db.prepare('INSERT INTO kb_documents (id,user_id,title,source,created_at,bytes) VALUES (?,?,?,?,?,?)')
    .run(id, userId, title.slice(0, 200), source.slice(0, 400), ts, Buffer.byteLength(body, 'utf-8'))

  const chunks = chunkText(body)
  const ins = db.prepare('INSERT INTO kb_chunks (id,doc_id,user_id,ord,text,tfidf_json) VALUES (?,?,?,?,?,?)')
  chunks.forEach((c, i) => {
    const map = tf(tokenize(c))
    ins.run(`${id}-c${i}`, id, userId, i, c, JSON.stringify([...map]))
  })
  return { id, chunks: chunks.length }
}

export function deleteDocument(userId, id) {
  init()
  if (!userId) throw new Error('userId required')
  db.prepare('DELETE FROM kb_chunks WHERE user_id=? AND doc_id=?').run(userId, id)
  const r = db.prepare('DELETE FROM kb_documents WHERE user_id=? AND id=?').run(userId, id)
  return { deleted: r.changes }
}

export function searchKnowledge(userId, query, { topK = 5 } = {}) {
  init()
  if (!userId || !query) return []
  const qmap = tf(tokenize(query))
  const qmag = magnitude(qmap)
  if (qmag === 0) return []

  const rows = db.prepare('SELECT id,doc_id,ord,text,tfidf_json FROM kb_chunks WHERE user_id=?').all(userId)
  const scored = []
  for (const row of rows) {
    let cmap
    try { cmap = new Map(JSON.parse(row.tfidf_json)) } catch { continue }
    const cmag = magnitude(cmap)
    if (cmag === 0) continue
    const sim = dot(qmap, cmap) / (qmag * cmag)
    if (sim <= 0) continue
    scored.push({ id: row.id, doc_id: row.doc_id, ord: row.ord, text: row.text, score: sim })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, Math.max(1, Math.min(20, Number(topK) || 5)))
  // Hydrate parent document title.
  const docIds = [...new Set(top.map((s) => s.doc_id))]
  if (docIds.length === 0) return []
  const placeholders = docIds.map(() => '?').join(',')
  const docs = db.prepare(`SELECT id,title,source FROM kb_documents WHERE id IN (${placeholders})`).all(...docIds)
  const docMap = new Map(docs.map((d) => [d.id, d]))
  return top.map((s) => ({
    text: s.text,
    score: Math.round(s.score * 1000) / 1000,
    doc: docMap.get(s.doc_id) || { id: s.doc_id },
    ord: s.ord,
  }))
}
