import PDFDocument from 'pdfkit'
import pptxgen from 'pptxgenjs'
import ExcelJS from 'exceljs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import db from './db.js'
import { withWorkspaceScope, uploadFiles } from './workspace.js'
import { callLLM } from './llmClient.js'

let initialized = false
const running = new Set()
const cancelled = new Set()  // job ids the user asked to cancel

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
  // On boot, mark any job that was 'running'/'queued' as failed — the worker
  // that owned it died with the previous process, so it'll never finish.
  // Without this users see ghost "Выполняется" cards forever after a deploy.
  const orphaned = db.prepare(`
    UPDATE jobs
       SET status = 'failed',
           error  = COALESCE(NULLIF(error, ''), 'Серверный процесс был перезапущен во время выполнения этой задачи.'),
           progress = 100,
           updated_at = ?,
           finished_at = COALESCE(finished_at, ?)
     WHERE status IN ('running', 'queued')
  `).run(Date.now(), Date.now())
  if (orphaned.changes > 0) {
    console.log(`[jobs] marked ${orphaned.changes} orphaned job(s) as failed on boot`)
  }
  initialized = true
}

// Treat any job that hasn't been touched for > ORPHAN_TIMEOUT_MS as dead
// (worker crashed without updating status). Bumps the row to 'failed' so
// the UI stops showing a phantom progress bar.
const ORPHAN_TIMEOUT_MS = Number(process.env.JOB_ORPHAN_TIMEOUT_MS || 10 * 60 * 1000)
function reapStaleJob(row) {
  if (!row) return row
  if (row.status !== 'running' && row.status !== 'queued') return row
  const idle = Date.now() - Number(row.updated_at || row.created_at || 0)
  if (idle <= ORPHAN_TIMEOUT_MS) return row
  // Mark stale.
  db.prepare(`
    UPDATE jobs
       SET status = 'failed',
           error  = COALESCE(NULLIF(error, ''), 'Задача не обновляла статус более 10 минут — вероятно, воркер упал.'),
           progress = 100,
           updated_at = ?,
           finished_at = ?
     WHERE id = ?
  `).run(Date.now(), Date.now(), row.id)
  return { ...row, status: 'failed', error: 'Задача не обновляла статус более 10 минут — вероятно, воркер упал.', progress: 100, finished_at: Date.now() }
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
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  return rowToJob(reapStaleJob(row))
}

export function listJobs({ chatId = '', userId = '', limit = 50 } = {}) {
  initJobs()
  const max = Math.min(100, Math.max(1, Number(limit) || 50))
  let rows
  if (chatId) rows = db.prepare('SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, max)
  else if (userId) rows = db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, max)
  else rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(max)
  return rows.map(reapStaleJob).map(rowToJob)
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

// Mark a job for cancellation. The runner checks this between steps and stops.
export function cancelJob(id) {
  const job = getJob(id)
  if (!job) return null
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job
  cancelled.add(id)
  return setJobPatch(id, { status: 'cancelled', error: 'Отменено пользователем', finishedAt: now() })
}

function isCancelled(id) {
  return cancelled.has(id)
}

export function appendJobLog(id, message) {
  const job = getJob(id)
  if (!job) return null
  const logs = [...(job.logs || []), { ts: new Date().toISOString(), message: String(message || '') }].slice(-200)
  return setJobPatch(id, { logs })
}


function stripCodeFence(text = '') {
  const s = String(text || '').trim()
  const m = s.match(/^```(?:json|markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return m ? m[1].trim() : s
}

function parseJsonLoose(text = '', fallback = null) {
  const raw = stripCodeFence(text)
  try { return JSON.parse(raw) } catch { /* try loose object parse */ }
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)) } catch { /* fallback below */ }
  }
  return fallback
}

function uploadFileFromBuffer(name, mime, buffer) {
  return { path: name, name, type: mime, content: Buffer.from(buffer).toString('base64') }
}

async function saveGeneratedFile(chatId, file) {
  await withWorkspaceScope(chatId, async () => uploadFiles('generated', [file]))
  return `generated/${file.name}`
}

// Find ANY active LLM key in the DB and use it for short text-generation
// tasks (PDF / DOCX / XLSX / PPTX document body generation). Picks the
// first active row; falls back to the first row if none active.
// Returns the fallback string on any failure (network, no keys, etc.) so
// callers can degrade gracefully — these jobs aren't worth crashing for.
async function callAnyLLM(prompt, fallback = '') {
  try {
    const row =
      db.prepare("SELECT base_url, api_key, model, auth_type, auth_header, extra_headers FROM keys WHERE is_active = 1 LIMIT 1").get()
      || db.prepare("SELECT base_url, api_key, model, auth_type, auth_header, extra_headers FROM keys LIMIT 1").get()
    if (!row || !row.base_url || !row.api_key) return fallback
    const extraHeaders = (() => { try { return JSON.parse(row.extra_headers || '{}') } catch { return {} } })()
    const reply = await callLLM({
      baseUrl:      row.base_url,
      apiKey:       row.api_key,
      authType:     row.auth_type || 'bearer',
      authHeader:   row.auth_header || '',
      extraHeaders,
      model:        row.model,
      messages:     [{ role: 'user', content: String(prompt || '') }],
      temperature:  0.3,
    })
    const text = (reply?.text || '').trim()
    return text || fallback
  } catch (e) {
    console.warn('[jobs] callAnyLLM failed:', e?.message || e)
    return fallback
  }
}

// Backwards-compat alias — older code (or future restored gemini-proxy)
// can keep calling geminiText() without knowing it's now provider-agnostic.
const geminiText = callAnyLLM

function markdownToPlainBlocks(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/)
  const blocks = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('# ')) blocks.push({ type: 'h1', text: t.replace(/^#\s+/, '') })
    else if (t.startsWith('## ')) blocks.push({ type: 'h2', text: t.replace(/^##\s+/, '') })
    else if (/^[-*]\s+/.test(t)) blocks.push({ type: 'bullet', text: t.replace(/^[-*]\s+/, '') })
    else blocks.push({ type: 'p', text: t.replace(/[*_`]/g, '') })
  }
  return blocks.length ? blocks : [{ type: 'p', text: String(markdown || 'Document') }]
}

async function createPdf({ title, markdown }) {
  const chunks = []
  const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true })
  doc.on('data', (c) => chunks.push(c))
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))
  try { doc.font('/usr/share/fonts/TTF/DejaVuSans.ttf') } catch { /* font may be unavailable in dev */ }
  doc.fontSize(22).text(title || 'Document', { underline: false })
  doc.moveDown()
  for (const block of markdownToPlainBlocks(markdown)) {
    if (block.type === 'h1') doc.moveDown(0.4).fontSize(18).text(block.text).moveDown(0.3)
    else if (block.type === 'h2') doc.moveDown(0.3).fontSize(15).text(block.text).moveDown(0.2)
    else if (block.type === 'bullet') doc.fontSize(11).text(`• ${block.text}`, { indent: 14 }).moveDown(0.15)
    else doc.fontSize(11).text(block.text, { lineGap: 3 }).moveDown(0.35)
  }
  doc.end()
  return done
}

async function createDocx({ title, markdown }) {
  const children = [new Paragraph({ text: title || 'Document', heading: HeadingLevel.TITLE })]
  for (const block of markdownToPlainBlocks(markdown)) {
    if (block.type === 'h1') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 }))
    else if (block.type === 'h2') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 }))
    else if (block.type === 'bullet') children.push(new Paragraph({ text: block.text, bullet: { level: 0 } }))
    else children.push(new Paragraph({ children: [new TextRun(block.text)] }))
  }
  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}

async function createPresentation({ title, slides }) {
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'BrowserAI'
  const first = pptx.addSlide()
  first.background = { color: '111827' }
  first.addText(title || 'Presentation', { x: 0.7, y: 1.6, w: 11.8, h: 0.7, fontSize: 34, bold: true, color: 'F8FAFC' })
  first.addText('Generated by BrowserAI', { x: 0.75, y: 2.5, w: 8, h: 0.3, fontSize: 14, color: 'CBD5E1' })
  for (const slideData of slides.slice(0, 30)) {
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addText(slideData.title || 'Slide', { x: 0.6, y: 0.35, w: 12, h: 0.5, fontSize: 26, bold: true, color: '111827' })
    const bullets = Array.isArray(slideData.bullets) ? slideData.bullets : []
    slide.addText(bullets.map((b) => ({ text: String(b), options: { bullet: { indent: 18 }, hanging: 4 } })), {
      x: 0.9, y: 1.2, w: 11.3, h: 4.9, fontSize: 18, color: '1F2937', breakLine: false, fit: 'shrink'
    })
  }
  return pptx.write({ outputType: 'nodebuffer' })
}

async function createWorkbook({ title, sheets }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'BrowserAI'
  wb.created = new Date()
  const safeSheets = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', rows: [[title || 'BrowserAI'], ['No structured data was provided']] }]
  for (const s of safeSheets.slice(0, 10)) {
    const ws = wb.addWorksheet(String(s.name || 'Sheet').slice(0, 31))
    for (const row of (s.rows || []).slice(0, 1000)) ws.addRow(Array.isArray(row) ? row : [String(row)])
    ws.columns?.forEach((col) => { col.width = Math.min(40, Math.max(12, col.values?.reduce((m, v) => Math.max(m, String(v || '').length), 0) || 12)) })
  }
  return wb.xlsx.writeBuffer()
}

async function runLocalDocumentJob(job) {
  const input = job.input || {}
  const prompt = input.prompt || ''
  const title = input.title || prompt.slice(0, 80) || 'BrowserAI document'
  appendJobLog(job.id, 'Генерирую содержимое документа')
  setJobPatch(job.id, { status: 'running', progress: 15 })

  if (job.type === 'generate_presentation') {
    const raw = await geminiText(
      `Создай структуру презентации по запросу пользователя. Верни ТОЛЬКО JSON вида {"title":"...","slides":[{"title":"...","bullets":["...","..."]}]}. 5-10 слайдов. Запрос: ${prompt}`,
      '',
    )
    const parsed = parseJsonLoose(raw, null) || {
      title,
      slides: [
        { title: 'Цель', bullets: [prompt || 'Презентация создана BrowserAI'] },
        { title: 'Ключевые идеи', bullets: ['Основная мысль', 'Подробности', 'Следующие шаги'] },
      ],
    }
    setJobPatch(job.id, { progress: 55 })
    const buffer = await createPresentation({ title: parsed.title || title, slides: parsed.slides || [] })
    const name = `presentation-${Date.now()}.pptx`
    const saved = await saveGeneratedFile(job.chatId, uploadFileFromBuffer(name, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer))
    setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { content: `Презентация создана: ${saved}`, files: [saved] }, finishedAt: now() })
    return
  }

  if (job.type === 'generate_xlsx') {
    const raw = await geminiText(
      `Создай данные для XLSX по запросу. Верни ТОЛЬКО JSON вида {"title":"...","sheets":[{"name":"...","rows":[["A","B"],["..."]]}]}. Запрос: ${prompt}`,
      '',
    )
    const parsed = parseJsonLoose(raw, null) || { title, sheets: [{ name: 'Data', rows: [['Запрос', prompt || title], ['Создано', new Date().toISOString()]] }] }
    setJobPatch(job.id, { progress: 55 })
    const buffer = await createWorkbook({ title: parsed.title || title, sheets: parsed.sheets || [] })
    const name = `table-${Date.now()}.xlsx`
    const saved = await saveGeneratedFile(job.chatId, uploadFileFromBuffer(name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer))
    setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { content: `Таблица создана: ${saved}`, files: [saved] }, finishedAt: now() })
    return
  }

  const markdown = await geminiText(
    `Напиши содержательный документ в Markdown по запросу пользователя. Без JSON. Запрос: ${prompt}`,
    `# ${title}\n\n${prompt || 'Документ создан BrowserAI.'}`,
  )
  setJobPatch(job.id, { progress: 55 })

  if (job.type === 'generate_docx') {
    const buffer = await createDocx({ title, markdown })
    const name = `document-${Date.now()}.docx`
    const saved = await saveGeneratedFile(job.chatId, uploadFileFromBuffer(name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer))
    setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { content: `DOCX создан: ${saved}`, files: [saved] }, finishedAt: now() })
    return
  }

  // default: PDF
  const buffer = await createPdf({ title, markdown })
  const name = `document-${Date.now()}.pdf`
  const saved = await saveGeneratedFile(job.chatId, uploadFileFromBuffer(name, 'application/pdf', buffer))
  setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { content: `PDF создан: ${saved}`, files: [saved] }, finishedAt: now() })
}


export function startJob(id) {
  const job = getJob(id)
  if (!job || running.has(id)) return job
  running.add(id)
  ;(async () => {
    try {
      if (job.type.startsWith('generate_')) await runLocalDocumentJob(job)
      else if (job.type.startsWith('gemini_')) {
        // gemini_image / gemini_video были у нас завязаны на снесённый
        // gemini-web-proxy. Возвращаемся честно: видишь — провайдер удалён,
        // используй tool generate_image (через настоящий API ключ).
        throw new Error(
          `Тип "${job.type}" больше не поддерживается: gemini-web-proxy удалён. ` +
          `Подключи прямой Gemini API key (aistudio.google.com/apikey) или используй другой провайдер.`
        )
      }
      else throw new Error(`Unknown job type: ${job.type}`)
    } catch (e) {
      appendJobLog(id, `Ошибка: ${e.message || String(e)}`)
      setJobPatch(id, { status: 'failed', error: e.message || String(e), finishedAt: now() })
    } finally {
      running.delete(id)
      cancelled.delete(id)
    }
  })()
  return getJob(id)
}
