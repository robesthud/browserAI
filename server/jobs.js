import db from './db.js'
import { withWorkspaceScope, uploadFiles } from './workspace.js'

const DEFAULT_GEMINI_URL = process.env.GEMINI_WEB_PROXY_URL || 'http://host.docker.internal:8080/v1'
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_WEB_MODEL || 'gemini-2.5-pro'
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 10 * 60 * 1000)

let initialized = false
const running = new Set()

function now() { return Date.now() }
function uid(prefix = 'job') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` }
function safeJsonParse(s, fallback = null) { try { return JSON.parse(s || '') } catch { return fallback } }

export function initJobs() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      chat_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      progress INTEGER NOT NULL DEFAULT 0,
      logs TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_chat_id ON jobs(chat_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  `)
  initialized = true
}

function rowToJob(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    chatId: row.chat_id,
    type: row.type,
    status: row.status,
    title: row.title,
    input: safeJsonParse(row.input_json, {}),
    result: safeJsonParse(row.result_json, {}),
    error: row.error || '',
    progress: row.progress || 0,
    logs: safeJsonParse(row.logs, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }
}

export function getJob(id) {
  initJobs()
  return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id))
}

export function listJobs({ chatId = '', userId = '', limit = 50 } = {}) {
  initJobs()
  const max = Math.min(100, Math.max(1, Number(limit) || 50))
  let rows
  if (chatId) rows = db.prepare('SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, max)
  else if (userId) rows = db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, max)
  else rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(max)
  return rows.map(rowToJob)
}

export function createJob({ userId = '', chatId = '', type, title = '', input = {} } = {}) {
  initJobs()
  if (!type) throw new Error('job type required')
  const id = uid('job')
  const ts = now()
  db.prepare(`
    INSERT INTO jobs (id, user_id, chat_id, type, status, title, input_json, result_json, logs, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, '{}', '[]', ?, ?)
  `).run(id, userId || '', chatId || '', type, title || type, JSON.stringify(input || {}), ts, ts)
  return getJob(id)
}

function setJobPatch(id, patch = {}) {
  const current = getJob(id)
  if (!current) throw new Error('job not found')
  const next = { ...current, ...patch, updatedAt: now() }
  db.prepare(`
    UPDATE jobs
    SET status = ?, result_json = ?, error = ?, progress = ?, logs = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
  `).run(
    next.status,
    JSON.stringify(next.result || {}),
    next.error || '',
    Math.max(0, Math.min(100, Number(next.progress) || 0)),
    JSON.stringify(next.logs || []),
    next.updatedAt,
    next.finishedAt || null,
    id,
  )
  return getJob(id)
}

export function appendJobLog(id, message) {
  const job = getJob(id)
  if (!job) return null
  const logs = [...(job.logs || []), { ts: new Date().toISOString(), message: String(message || '') }].slice(-200)
  return setJobPatch(id, { logs })
}

function extractDataUrls(text = '') {
  const out = []
  const re = /data:(image|video|audio|application)\/[^)\s"']+/g
  let m
  while ((m = re.exec(String(text || '')))) {
    if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

function dataUrlToUploadFile(dataUrl, index = 0) {
  const m = String(dataUrl || '').match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s)
  if (!m) return null
  const mime = m[1] || 'application/octet-stream'
  const b64 = m[2] || ''
  const ext = mime.includes('png') ? 'png'
    : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
    : mime.includes('webp') ? 'webp'
    : mime.includes('gif') ? 'gif'
    : mime.includes('mp4') ? 'mp4'
    : mime.includes('pdf') ? 'pdf'
    : mime.includes('presentation') || mime.includes('powerpoint') ? 'pptx'
    : mime.includes('spreadsheet') || mime.includes('excel') ? 'xlsx'
    : mime.includes('word') ? 'docx'
    : 'bin'
  const stamp = Date.now()
  return { path: `generated-${stamp}-${index + 1}.${ext}`, name: `generated-${stamp}-${index + 1}.${ext}`, content: b64, type: mime }
}

async function saveDataUrlsToWorkspace(chatId, dataUrls = []) {
  const files = dataUrls.map(dataUrlToUploadFile).filter(Boolean)
  if (!files.length || !chatId) return []
  await withWorkspaceScope(chatId, async () => uploadFiles('generated', files))
  return files.map((f) => `generated/${f.path}`)
}

async function callGeminiProxy({ prompt, model = DEFAULT_GEMINI_MODEL, attachments = [] } = {}) {
  const content = []
  if (prompt) content.push({ type: 'text', text: prompt })
  for (const a of attachments || []) {
    if (!a?.dataUrl) continue
    if (String(a.type || '').startsWith('image/') || String(a.dataUrl).startsWith('data:image/')) {
      content.push({ type: 'image_url', image_url: { url: a.dataUrl } })
    } else {
      content.push({ type: 'file_url', file_url: { url: a.dataUrl, name: a.name, mime_type: a.type || 'application/octet-stream' } })
    }
  }
  const body = { model, messages: [{ role: 'user', content: content.length ? content : String(prompt || '') }] }
  const r = await fetch(`${DEFAULT_GEMINI_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-needed' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
  })
  const raw = await r.text()
  if (!r.ok) throw new Error(`Gemini proxy ${r.status}: ${raw.slice(0, 1000)}`)
  const json = JSON.parse(raw)
  return json?.choices?.[0]?.message?.content || ''
}

async function runGeminiJob(job) {
  const input = job.input || {}
  appendJobLog(job.id, 'Запуск Gemini Web задачи')
  setJobPatch(job.id, { status: 'running', progress: 10 })
  const typeLabel = job.type === 'gemini_video' ? 'Создай видео/анимацию' : 'Выполни задачу'
  const prompt = `${typeLabel}. ${input.prompt || ''}`.trim()
  setJobPatch(job.id, { progress: 25 })
  const content = await callGeminiProxy({ prompt, model: input.model || DEFAULT_GEMINI_MODEL, attachments: input.attachments || [] })
  appendJobLog(job.id, 'Ответ Gemini получен')
  setJobPatch(job.id, { progress: 75 })
  const dataUrls = extractDataUrls(content)
  const files = await saveDataUrlsToWorkspace(job.chatId, dataUrls)
  setJobPatch(job.id, {
    status: 'succeeded',
    progress: 100,
    result: { content, files, dataUrlsCount: dataUrls.length },
    finishedAt: now(),
  })
}

async function runLocalDocumentJob(job) {
  const input = job.input || {}
  appendJobLog(job.id, 'Создание документа локально')
  setJobPatch(job.id, { status: 'running', progress: 20 })
  const title = input.title || input.prompt || 'Document'
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><pre>${String(input.prompt || '').replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre></body></html>`
  const b64 = Buffer.from(html).toString('base64')
  const file = { path: `generated-${Date.now()}.html`, name: `generated-${Date.now()}.html`, content: b64, type: 'text/html' }
  await withWorkspaceScope(job.chatId, async () => uploadFiles('generated', [file]))
  setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { content: `Файл создан: generated/${file.name}`, files: [`generated/${file.name}`] }, finishedAt: now() })
}

export function startJob(id) {
  const job = getJob(id)
  if (!job || running.has(id)) return job
  running.add(id)
  ;(async () => {
    try {
      if (job.type.startsWith('gemini_')) await runGeminiJob(job)
      else if (job.type.startsWith('generate_')) await runLocalDocumentJob(job)
      else throw new Error(`Unknown job type: ${job.type}`)
    } catch (e) {
      appendJobLog(id, `Ошибка: ${e.message || String(e)}`)
      setJobPatch(id, { status: 'failed', error: e.message || String(e), finishedAt: now() })
    } finally {
      running.delete(id)
    }
  })()
  return getJob(id)
}
