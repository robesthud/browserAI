import PDFDocument from 'pdfkit'
import pptxgen from 'pptxgenjs'
import ExcelJS from 'exceljs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import db, { getActiveKeyDecrypted } from './db.js'
import { createAgentSseCapture } from './agentSseCapture.js'
import { resolveProviderFromInput } from './providerResolution.js'
import { withWorkspaceScope, uploadFiles } from './workspace.js'
import { callLLM } from './llmClient.js'

let initialized = false
const running = new Set()
const cancelled = new Set()  // job ids the user asked to cancel
const runtimeInputs = new Map() // non-persisted sensitive job data (provider api keys)

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
  // Lightweight schema migration for structured background traces.
  try { db.prepare(`ALTER TABLE jobs ADD COLUMN trace_json TEXT NOT NULL DEFAULT '[]'`).run() } catch { /* already exists */ }
  try { db.prepare(`ALTER TABLE jobs ADD COLUMN parent_job_id TEXT NOT NULL DEFAULT ''`).run() } catch { /* already exists */ }

  const bootTs = Date.now()
  // On boot, most in-memory workers are gone and cannot continue. Background
  // agent jobs are special: their input is persisted and can be resumed using
  // the currently active provider key, so keep them queued instead of turning
  // them into ghost failures after a deploy/restart.
  const resumable = db.prepare(`
    SELECT id, logs, trace_json
      FROM jobs
     WHERE type = 'agent_run' AND status IN ('running', 'queued')
     ORDER BY created_at ASC
  `).all()
  for (const row of resumable) {
    const logs = safeJsonParse(row.logs, []) || []
    logs.push({ ts: new Date(bootTs).toISOString(), message: 'Сервер перезапущен — фоновый агент поставлен на resume.' })
    const trace = safeJsonParse(row.trace_json, []) || []
    trace.push({ ts: bootTs, event: 'job_resume_after_restart', payload: { status: 'queued' } })
    db.prepare(`
      UPDATE jobs
         SET status = 'queued',
             error = '',
             progress = CASE WHEN progress >= 100 THEN 5 ELSE MAX(progress, 5) END,
             logs = ?,
             trace_json = ?,
             updated_at = ?,
             finished_at = NULL
       WHERE id = ?
    `).run(JSON.stringify(logs.slice(-200)), JSON.stringify(trace.slice(-500)), bootTs, row.id)
  }

  const orphaned = db.prepare(`
    UPDATE jobs
       SET status = 'failed',
           error  = COALESCE(NULLIF(error, ''), 'Серверный процесс был перезапущен во время выполнения этой задачи.'),
           progress = 100,
           updated_at = ?,
           finished_at = COALESCE(finished_at, ?)
     WHERE status IN ('running', 'queued') AND type <> 'agent_run'
  `).run(bootTs, bootTs)
  if (orphaned.changes > 0) {
    console.log(`[jobs] marked ${orphaned.changes} orphaned non-agent job(s) as failed on boot`)
  }
  initialized = true
  if (resumable.length > 0) {
    console.log(`[jobs] resuming ${resumable.length} background agent job(s) after restart`)
    setTimeout(() => {
      for (const row of resumable) startJob(row.id)
    }, 1500).unref?.()
  }
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
  const staleTs = Date.now()
  db.prepare(`
    UPDATE jobs
       SET status = 'failed',
           error  = COALESCE(NULLIF(error, ''), 'Задача не обновляла статус — вероятно, воркер упал.'),
           progress = 100,
           updated_at = ?,
           finished_at = ?
     WHERE id = ?
  `).run(staleTs, staleTs, row.id)
  return { ...row, status: 'failed', error: 'Задача не обновляла статус — вероятно, воркер упал.', progress: 100, finished_at: staleTs }
}

function sanitizeJobInput(value, depth = 0) {
  if (depth > 5) return '[truncated]'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => sanitizeJobInput(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/api[_-]?key|token|password|secret|cookie|authorization|credentials?|private[_-]?key|client[_-]?secret|refresh[_-]?token/i.test(k)) {
        if (k === 'useStoredSecret') out[k] = Boolean(v)
        else continue
      } else {
        out[k] = sanitizeJobInput(v, depth + 1)
      }
    }
    return out
  }
  return String(value)
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
    input: sanitizeJobInput(safeJsonParse(row.input_json, {})),
    result: safeJsonParse(row.result_json, {}),
    error: row.error || '',
    progress: row.progress || 0,
    logs: safeJsonParse(row.logs, []),
    trace: safeJsonParse(row.trace_json, []),
    parentJobId: row.parent_job_id || '',
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

export function listJobs({ chatId = '', userId = '', limit = 50, parentJobId = '' } = {}) {
  initJobs()
  const max = Math.min(100, Math.max(1, Number(limit) || 50))
  let rows
  if (parentJobId) rows = db.prepare('SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY created_at ASC LIMIT ?').all(parentJobId, max)
  else if (chatId) rows = db.prepare('SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, max)
  else if (userId) rows = db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, max)
  else rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(max)
  return rows.map(reapStaleJob).map(rowToJob)
}

export function createJob({ userId = '', chatId = '', type, title = '', input = {}, parentJobId = '' } = {}) {
  initJobs()
  if (!type) throw new Error('job type required')
  const id = uid('job')
  const ts = now()
  const inputJson = (() => {
    try { return JSON.stringify(input || {}) }
    catch { return JSON.stringify({ _serializeError: 'input contained non-serializable values' }) }
  })()
  db.prepare(`
    INSERT INTO jobs (id, user_id, chat_id, type, status, title, input_json, result_json, logs, trace_json, parent_job_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, '{}', '[]', '[]', ?, ?, ?)
  `).run(id, userId || '', chatId || '', type, title || type, inputJson, String(parentJobId || ''), ts, ts)
  return getJob(id)
}

export function registerRuntimeInput(id, data = {}) {
  if (id && typeof id === 'string' && id.length > 0) runtimeInputs.set(id, data || {})
}

function setJobPatch(id, patch = {}) {
  // Используем прямой SELECT без reapStaleJob — иначе reap может перезаписать
  // статус на 'failed' прямо перед тем как мы записываем 'succeeded'.
  const rawRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  const current = rowToJob(rawRow)
  if (!current) throw new Error('job not found')
  const next = { ...current, ...patch, updatedAt: now() }
  db.prepare(`
    UPDATE jobs
    SET status = ?, result_json = ?, error = ?, progress = ?, logs = ?, trace_json = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
  `).run(
    next.status,
    JSON.stringify(next.result || {}),
    next.error || '',
    Math.max(0, Math.min(100, Number(next.progress) || 0)),
    JSON.stringify(next.logs || []),
    JSON.stringify(next.trace || current.trace || []),
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

// Runners poll this between long steps to stop work the user cancelled.
export function isCancelled(id) {
  return cancelled.has(id)
}

export function appendJobLog(id, message) {
  // Прямой UPDATE logs без SELECT всего job — экономия round-trip.
  try {
    const row = db.prepare('SELECT logs FROM jobs WHERE id = ?').get(id)
    if (!row) return null
    const logs = [...(safeJsonParse(row.logs, []) || []),
      { ts: new Date().toISOString(), message: String(message || '') },
    ].slice(-200)
    db.prepare('UPDATE jobs SET logs = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(logs), Date.now(), id)
    return true
  } catch { return null }
}

function clipTraceValue(value, max = 2400) {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => clipTraceValue(v, Math.floor(max / 2)))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      if (/api[_-]?key|token|password|secret|authorization|cookie/i.test(k)) out[k] = '[redacted]'
      else out[k] = clipTraceValue(v, max)
    }
    return out
  }
  return value
}

export function appendJobTrace(id, event, payload = {}) {
  // Прямой UPDATE без SELECT всего job — экономия round-trip на каждое SSE событие.
  // json_patch + json_insert не поддерживается в SQLite < 3.38, используем read-modify-write
  // но только trace_json и updated_at, не весь job.
  try {
    const row = db.prepare('SELECT trace_json FROM jobs WHERE id = ?').get(id)
    if (!row) return null
    const trace = [...(safeJsonParse(row.trace_json, []) || []),
      { ts: Date.now(), iso: new Date().toISOString(), event: String(event || 'event'), payload: clipTraceValue(payload || {}) },
    ].slice(-500)
    db.prepare('UPDATE jobs SET trace_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(trace), Date.now(), id)
    return true
  } catch { return null }
}


function stripCodeFence(text = '') {
  const s = String(text || '').trim()
  const m = s.match(/^```(?:json|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i)
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
  if (!buffer) throw new Error(`uploadFileFromBuffer: buffer is empty for '${name}'`)
  return { path: name, name, type: mime, content: Buffer.from(buffer).toString('base64') }
}

async function saveGeneratedFile(chatId, file) {
  if (!chatId) console.warn('[jobs] saveGeneratedFile: chatId empty — file saved to shared workspace')
  await withWorkspaceScope(chatId || '', async () => uploadFiles('generated', [file]))
  return `generated/${file.name}`
}

function createJobSseRes(job) {
  let deltaSeq = 0
  return createAgentSseCapture({
    onEvent: ({ event, payload }) => {
      if (event === 'assistant_delta') {
        deltaSeq += 1
        if (deltaSeq % 25 === 0) appendJobTrace(job.id, event, { chunkLength: String(payload.chunk || '').length, deltaSeq })
        return
      }
      appendJobTrace(job.id, event, payload)
      if (event === 'tool_start') appendJobLog(job.id, `tool_start: ${payload.name || ''}`)
      else if (event === 'tool_result') appendJobLog(job.id, `tool_result: ${payload.name || ''} ${payload.ok ? 'ok' : 'fail'}`)
      else if (event === 'thought') appendJobLog(job.id, `thought: ${String(payload.text || '').slice(0, 180)}`)
      else if (event === 'error') appendJobLog(job.id, `error: ${payload.message || ''}`)
      else if (event === 'done') { try { setJobPatch(job.id, { progress: 95, result: { ...(getJob(job.id)?.result || {}), done: payload } }) } catch { /* job may have been deleted */ } }
    },
  })
}

async function runAgentJob(job) {
  const runtime = runtimeInputs.get(job.id) || {}
  const input = job.input || {}
  const runtimeProvider = runtime.provider || {}
  const provider = (runtimeProvider?.apiKey != null && runtimeProvider?.apiKey !== '') || runtimeProvider?.useStoredSecret
    ? resolveProviderFromInput(runtimeProvider, { requireBearer: true })
    : resolveProviderFromInput(input.provider || input || {}, { requireBearer: true })
  if (!provider?.baseUrl || !provider?.apiKey || !provider?.model) throw new Error('No provider available for background agent job')
  setJobPatch(job.id, { status: 'running', progress: 5 })
  appendJobLog(job.id, 'Запускаю фонового агента')
  const { runAgent } = await import('./agentLoop.js')
  const res = createJobSseRes(job)
  if (isCancelled(job.id)) return
  // Опрашиваем cancelled set каждые 2с и эмитим 'close' на res чтобы
  // agentLoop прервал своё выполнение через AbortController.
  const cancelPoller = setInterval(() => {
    if (isCancelled(job.id)) {
      clearInterval(cancelPoller)
      try { res.emitClose?.() || res.emit?.('close') } catch { /* ignore */ }
    }
  }, 2000)
  try {
    await runAgent({
      provider: { ...provider, forceAgent: true },
      history: input.history || [{ role: 'user', content: input.prompt || 'continue' }],
      extraSystem: input.extraSystem || '[background-agent-job] Run as a background task. Persist progress in the job trace. If this is a resumed job after restart, continue from the persisted history/summary and avoid repeating completed destructive actions when possible. If blocked by approval or user input, stop and report what is needed.',
      workspaceScope: job.chatId,
      userId: job.userId,
      res,
    })
  } finally {
    clearInterval(cancelPoller)
  }
  // Не ставим succeeded если задача была отменена пока агент работал
  if (isCancelled(job.id)) return
  const text = res.getAssistantText()
  setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { content: text || 'Agent job completed' }, finishedAt: now() })
}

async function runToolJob(job) {
  const { invokeTool } = await import('./agentTools.js')
  const input = job.input || {}
  const tool = input.tool || job.type.replace(/^tool_/, '')
  const args = input.args || {}
  appendJobLog(job.id, `Запускаю tool: ${tool}`)
  setJobPatch(job.id, { status: 'running', progress: 10 })
  if (isCancelled(job.id)) return
  // Создаём AbortController чтобы прервать долгие tools при cancel
  const toolAbort = new AbortController()
  // Немедленная проверка до старта tool
  if (isCancelled(job.id)) { toolAbort.abort('job cancelled') }
  const toolCancelPoller = setInterval(() => {
    if (isCancelled(job.id)) { clearInterval(toolCancelPoller); toolAbort.abort('job cancelled') }
  }, 1000)
  let result
  try {
    result = await withWorkspaceScope(job.chatId, () => invokeTool(tool, args, { userId: job.userId, chatId: job.chatId, signal: toolAbort.signal }))
  } finally {
    clearInterval(toolCancelPoller)
  }
  if (isCancelled(job.id)) return
  if (!result?.ok) {
    appendJobLog(job.id, `Ошибка tool ${tool}: ${result?.error || 'unknown error'}`)
    setJobPatch(job.id, { status: 'failed', progress: 100, error: result?.error || 'tool failed', result: { tool, raw: result }, finishedAt: now() })
    return
  }
  appendJobLog(job.id, `Tool ${tool} завершён успешно`)
  setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { tool, ...(result.result || {}) }, finishedAt: now() })
}

// Find ANY active LLM key in the DB and use it for short text-generation
// tasks (PDF / DOCX / XLSX / PPTX document body generation).
// Uses getActiveKeyDecrypted() to support vault-encrypted keys.
// Returns the fallback string on any failure so callers degrade gracefully.
async function callAnyLLM(prompt, fallback = '') {
  try {
    // getActiveKeyDecrypted handles vault decryption; falls back to first key if none active
    // getActiveKeyDecrypted(null) — без vault пароля, расшифровывает если vault открыт
    const row = getActiveKeyDecrypted(null)
      || db.prepare('SELECT base_url, api_key, model, auth_type, auth_header, extra_headers FROM keys ORDER BY is_active DESC LIMIT 1').get()
    if (!row || !row.base_url || !row.api_key) return fallback
    // Если api_key выглядит как зашифрованный blob (не начинается с обычных префиксов) —
    // vault заблокирован, не передаём ciphertext в API
    const apiKey = row.api_key || row.apiKey || ''
    if (apiKey.startsWith('{') || apiKey.startsWith('enc:') || apiKey.length > 512) {
      console.warn('[jobs] callAnyLLM: api_key appears encrypted (vault locked) — skipping')
      return fallback
    }
    const extraHeaders = (() => { try { return JSON.parse(row.extra_headers || row.extraHeaders || '{}') } catch { return {} } })()
    const reply = await callLLM({
      baseUrl:      row.base_url   || row.baseUrl,
      apiKey:       row.api_key    || row.apiKey,
      authType:     row.auth_type  || row.authType  || 'bearer',
      authHeader:   row.auth_header|| row.authHeader || '',
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
    if (t.startsWith('### ')) blocks.push({ type: 'h2', text: t.replace(/^###\s+/, '') })
    else if (t.startsWith('## ')) blocks.push({ type: 'h2', text: t.replace(/^##\s+/, '') })
    else if (t.startsWith('# ')) blocks.push({ type: 'h1', text: t.replace(/^#\s+/, '') })
    else if (/^[-*+]\s+/.test(t)) blocks.push({ type: 'bullet', text: t.replace(/^[-*+]\s+/, '') })
    else blocks.push({ type: 'p', text: t.replace(/[*_`]/g, '') })
  }
  return blocks.length ? blocks : [{ type: 'p', text: String(markdown || 'Document') }]
}

async function createPdf({ title, markdown }) {
  const chunks = []
  const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true })
  doc.on('data', (c) => chunks.push(c))
  let docEnded = false
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => { docEnded = true; resolve(Buffer.concat(chunks)) })
    doc.on('error', (e) => { docEnded = true; reject(e) })
  })
  try { doc.font('/usr/share/fonts/TTF/DejaVuSans.ttf') } catch { console.warn('[jobs] DejaVuSans.ttf not found — PDF will lack Cyrillic support') }
  try {
    doc.fontSize(22).text(title || 'Document', { underline: false })
    doc.moveDown()
    for (const block of markdownToPlainBlocks(markdown)) {
      if (block.type === 'h1') doc.moveDown(0.4).fontSize(18).text(block.text).moveDown(0.3)
      else if (block.type === 'h2') doc.moveDown(0.3).fontSize(15).text(block.text).moveDown(0.2)
      else if (block.type === 'bullet') doc.fontSize(11).text(`• ${block.text}`, { indent: 14 }).moveDown(0.15)
      else doc.fontSize(11).text(block.text, { lineGap: 3 }).moveDown(0.35)
    }
  } finally {
    // Всегда закрываем документ — иначе Promise `done` зависнет
    if (!docEnded) doc.end()
  }
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

  // default: PDF (generate_pdf или любой другой generate_* тип)
  const knownGenerateTypes = ['generate_pdf', 'generate_docx', 'generate_xlsx', 'generate_presentation']
  if (!knownGenerateTypes.includes(job.type)) {
    console.warn(`[jobs] Unknown generate type '${job.type}' — falling back to PDF`)
  }
  const buffer = await createPdf({ title, markdown })
  const name = `document-${Date.now()}.pdf`
  const saved = await saveGeneratedFile(job.chatId, uploadFileFromBuffer(name, 'application/pdf', buffer))
  setJobPatch(job.id, { status: 'succeeded', progress: 100, result: { content: `PDF создан: ${saved}`, files: [saved] }, finishedAt: now() })
}


export function retryJob(id) {
  const old = getJob(id)
  if (!old) return null
  const next = createJob({ userId: old.userId, chatId: old.chatId, type: old.type, title: old.title || old.type, input: old.input || {} })
  // Копируем runtimeInputs (provider keys) — иначе retry agent_run без сохранённого ключа упадёт
  const prevRuntime = runtimeInputs.get(id)
  if (prevRuntime) runtimeInputs.set(next.id, { ...prevRuntime })
  startJob(next.id)
  return getJob(next.id)
}

export function startJob(id) {
  const job = getJob(id)
  if (!job || running.has(id)) return job
  // Не перезапускать завершённые задачи
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job
  running.add(id)
  ;(async () => {
    try {
      if (job.type.startsWith('generate_')) await runLocalDocumentJob(job)
      else if (job.type === 'agent_run') await runAgentJob(job)
      else if (job.type.startsWith('tool_')) await runToolJob(job)
      else throw new Error(`Unknown job type: ${job.type}`)
    } catch (e) {
      appendJobLog(id, `Ошибка: ${e.message || String(e)}`)
      let failed = null
      try { failed = setJobPatch(id, { status: 'failed', error: e.message || String(e), finishedAt: now() }) } catch { /* job may already be deleted */ }
      try {
        const { routeFailure } = await import('./autonomousFailureRouter.js')
        const routed = routeFailure({
          userId: failed?.userId || job.userId || '',
          source: 'job',
          title: `Job failed: ${failed?.title || job.title || job.type}`,
          error: e.message || String(e),
          entityType: 'job',
          entityId: id,
          data: { job: failed || job },
          incident: job.type === 'agent_run' || job.type.startsWith('tool_'),
        })
        if (routed?.classification) setJobPatch(id, { result: { ...(failed?.result || {}), failure: routed } })
      } catch { /* best-effort failure routing */ }
    } finally {
      running.delete(id)
      cancelled.delete(id)
      runtimeInputs.delete(id)
    }
  })()
  return getJob(id)
}
