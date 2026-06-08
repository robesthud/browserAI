import PDFDocument from 'pdfkit'
import pptxgen from 'pptxgenjs'
import ExcelJS from 'exceljs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import db from './db.js'
import { withWorkspaceScope, uploadFiles } from './workspace.js'

const DEFAULT_GEMINI_URL = process.env.GEMINI_WEB_PROXY_URL || 'http://host.docker.internal:8080/v1'
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_WEB_MODEL || 'gemini-2.5-pro'
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 10 * 60 * 1000)

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

function extractDataUrls(text = '') {
  const out = []
  const re = /data:(image|video|audio|application)\/[^)\s"']+/g
  let m
  while ((m = re.exec(String(text || '')))) {
    if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

// Gemini sometimes inlines video as a googleusercontent / lh3 / fbsbx link
// instead of a data: URL. The proxy will then fail to attach it because the
// URL is short-lived and bound to the headless Chrome's cookies. We capture
// such links so the runner can ask the proxy (which still owns the session)
// to download them through its native download-button flow on the next poll.
function extractRemoteMediaUrls(text = '') {
  const out = []
  const re = /https?:\/\/[^\s)"'<>]*(?:googleusercontent\.com|gstatic\.com|fbsbx\.com|googleapis\.com)[^\s)"'<>]*/gi
  let m
  while ((m = re.exec(String(text || '')))) {
    const url = m[0]
    if (!out.includes(url)) out.push(url)
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

async function callGeminiProxy({
  prompt,
  model = DEFAULT_GEMINI_MODEL,
  attachments = [],
} = {}) {
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

// ── Non-destructive video poll via the upstream proxy's
// `/v1/sessions/{id}/poll-media` endpoint (added by
// scripts/gemini-web-proxy-poll-media.py). Re-reads the SAME existing
// Gemini reply without sending another chat message, so Gemini can
// actually surface the finished Veo file inside its original reply.
const PROXY_ROOT = DEFAULT_GEMINI_URL.replace(/\/v1\/?$/, '').replace(/\/$/, '')

async function listGeminiSessions() {
  try {
    const r = await fetch(`${PROXY_ROOT}/v1/sessions`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return []
    const j = await r.json().catch(() => null)
    return Array.isArray(j?.sessions) ? j.sessions : []
  } catch { return [] }
}

/**
 * Ask the proxy to re-extract media from the LAST assistant reply for
 * a given session. Returns the parsed JSON or null on error.
 *
 *   { ready, videos:[data:video/...], images:[data:image/...],
 *     remote_links:[...], via_download_button:[...] }
 */
async function pollMediaForSession(sessionId) {
  try {
    const r = await fetch(`${PROXY_ROOT}/v1/sessions/${encodeURIComponent(sessionId)}/poll-media`, {
      method: 'POST',
      signal: AbortSignal.timeout(45_000),
    })
    if (!r.ok) {
      if (r.status === 404) return { notFound: true }
      return { error: `HTTP ${r.status}` }
    }
    return await r.json().catch(() => null)
  } catch (e) {
    return { error: e?.message || String(e) }
  }
}

// Video jobs use a dedicated isolated Gemini chat opened via our patched
// proxy endpoint POST /v1/sessions/new (returns an id like "ba-xxxxxxxx").
// The first message + image attach go through POST /v1/sessions/{id}/send,
// which bypasses chat_completions' session-id derivation entirely, so the
// call is GUARANTEED to land in our tab and not in the user's "default" chat.
/**
 * Allocate a brand-new, isolated Gemini chat tab via our patched proxy.
 * Returns a sessionId ("ba-xxxxxxxx") guaranteed not to clash with the
 * shared 'default' user chat. The tab is pre-warmed (upload-button waited
 * to appear), so the very next /send call can attach images reliably.
 */
async function createVideoSession() {
  const r = await fetch(`${PROXY_ROOT}/v1/sessions/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`new-session failed: HTTP ${r.status} ${t.slice(0, 400)}`)
  }
  const j = await r.json()
  if (!j?.session_id) throw new Error('proxy returned empty session_id')
  return j
}

/**
 * Send the FIRST message (text + images) into a pre-allocated session.
 * Uses our patched endpoint /v1/sessions/{id}/send which forwards to
 * upstream send_to_gemini() but bypasses chat_completions' session-id
 * derivation, so the call always lands in OUR headless tab.
 */
async function sendIntoVideoSession(sessionId, { prompt, attachments = [] }) {
  const images = (attachments || [])
    .filter((a) => a?.dataUrl && (String(a.type || '').startsWith('image/') || String(a.dataUrl).startsWith('data:image/')))
    .map((a) => a.dataUrl)
  const body = { prompt: String(prompt || ''), images }
  const r = await fetch(`${PROXY_ROOT}/v1/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
  })
  const raw = await r.text()
  if (!r.ok) throw new Error(`session-send failed: HTTP ${r.status}: ${raw.slice(0, 800)}`)
  let json
  try { json = JSON.parse(raw) } catch {
    throw new Error('session-send: non-JSON response')
  }
  return { reply: json?.reply || '', imageCount: json?.image_count || 0 }
}

/**
 * Delete the underlying Gemini conversation on gemini.google.com so the
 * user's left sidebar doesn't fill up, AND close the headless tab.
 * Best-effort: never throws.
 */
async function deleteVideoSession(sessionId) {
  if (!sessionId || sessionId === 'default' || !sessionId.startsWith('ba-')) return
  try {
    await fetch(`${PROXY_ROOT}/v1/sessions/${encodeURIComponent(sessionId)}/delete-chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* best-effort */ }
  // Fall-through DELETE just in case delete-chat couldn't navigate menus.
  try {
    await fetch(`${PROXY_ROOT}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    })
  } catch { /* best-effort */ }
}

// Gemini video generation (Veo) is asynchronous: the first reply is a
// "creating video, come back later" placeholder with no media. The finished
// <video> appears INSIDE that SAME reply 8–18 minutes later. Sending a new
// chat message ("готово?") just creates a new reply where Gemini answers
// "уже работаю" — we never see the file.
//
// Fix: use the non-destructive `POST /v1/sessions/{id}/poll-media` endpoint
// (added to gemini-web-proxy by scripts/gemini-web-proxy-poll-media.py).
// It re-reads the SAME reply, runs the same <video>/<img>/download-button
// extraction, and returns ready media without disturbing Gemini.
const VIDEO_PENDING_RE = /создаю видео|создание видео|вернитесь позже|может занять|generating video|creating video|come back|готовлю видео|in progress|идёт генерация|пожалуйста подождите/i
// Poll every 20s (matches the chef's request). Cheap because no Gemini round-trip.
const VIDEO_POLL_INTERVAL_MS = Number(process.env.GEMINI_VIDEO_POLL_INTERVAL_MS || 20_000)
// Veo can take 12-18 min on busy hours — keep 25 min ceiling.
const VIDEO_POLL_MAX_MS = Number(process.env.GEMINI_VIDEO_POLL_MAX_MS || 25 * 60 * 1000)

async function pollGeminiVideo(job, model, sessionId) {
  const deadline = Date.now() + VIDEO_POLL_MAX_MS
  let attempt = 0
  let lastRemoteUrls = []
  appendJobLog(job.id, `Опрашиваю Gemini-сессию: ${sessionId} (интервал ${Math.round(VIDEO_POLL_INTERVAL_MS / 1000)}с)`)

  // Compute how many ticks we have left and how to grow the progress bar.
  const totalTicks = Math.max(1, Math.floor(VIDEO_POLL_MAX_MS / VIDEO_POLL_INTERVAL_MS))

  while (Date.now() < deadline) {
    if (isCancelled(job.id)) return { content: '', dataUrls: [], cancelled: true }
    attempt += 1
    await new Promise((res) => setTimeout(res, VIDEO_POLL_INTERVAL_MS))
    if (isCancelled(job.id)) return { content: '', dataUrls: [], cancelled: true }

    // Progress 75 → 96 evenly across the polling window.
    const pct = Math.min(96, 75 + Math.round(((attempt / totalTicks) * 21)))
    setJobPatch(job.id, { progress: pct })

    const data = await pollMediaForSession(sessionId)
    if (!data) {
      appendJobLog(job.id, `Опрос #${attempt}: пустой ответ от прокси`)
      continue
    }
    if (data.notFound) {
      // Session was closed (Gemini tab crashed / OS killed Chrome / etc).
      // No point reassigning — we'd land in some other user's chat. Abort.
      appendJobLog(job.id, `Сессия ${sessionId} исчезла, дальнейший опрос невозможен`)
      return { content: '', dataUrls: [], remoteUrls: lastRemoteUrls, sessionLost: true }
    }
    if (data.error) {
      appendJobLog(job.id, `Опрос #${attempt}: ошибка прокси (${data.error})`)
      continue
    }

    const videos = Array.isArray(data.videos) ? data.videos : []
    const images = Array.isArray(data.images) ? data.images : []
    const links = Array.isArray(data.remote_links) ? data.remote_links : []
    if (links.length) lastRemoteUrls = links

    if (videos.length) {
      const viaBtn = (data.via_download_button || []).some((x) => x.kind === 'video') ? ' (через кнопку Download)' : ' (inline)'
      appendJobLog(job.id, `Видео готово, получено ${videos.length} файл(ов)${viaBtn}`)
      // Clean content: NO markdown data:URL link (the file is shown inline
      // by JobCard via the saved workspace file). Just a friendly status.
      return { content: 'Ваше видео готово!', dataUrls: videos }
    }
    if (images.length && !videos.length) {
      // Gemini sometimes regenerates a still poster while encoding the video.
      appendJobLog(job.id, `Опрос #${attempt}: пока есть только poster (${images.length}), жду видео`)
    } else {
      appendJobLog(job.id, `Опрос #${attempt}: видео ещё не готово`)
    }
  }
  return { content: '', dataUrls: [], remoteUrls: lastRemoteUrls, timedOut: true }
}

async function runGeminiJob(job) {
  const input = job.input || {}
  appendJobLog(job.id, 'Запуск Gemini Web задачи')
  setJobPatch(job.id, { status: 'running', progress: 10 })
  const isVideo = job.type === 'gemini_video'
  const typeLabel = isVideo ? 'Создай видео/анимацию' : 'Выполни задачу'
  const prompt = `${typeLabel}. ${input.prompt || ''}`.trim()
  const model = input.model || DEFAULT_GEMINI_MODEL
  setJobPatch(job.id, { progress: 20 })

  let content = ''
  let jobSessionId = ''

  if (isVideo) {
    // 1. Allocate a brand-new headless Gemini tab dedicated to this job.
    //    The patched proxy waits until the upload control is in the DOM
    //    before returning, so set_input_files in step 2 actually works.
    try {
      const sess = await createVideoSession()
      jobSessionId = sess.session_id
      appendJobLog(job.id, `Открыл отдельную Gemini-сессию: ${jobSessionId}${sess.attach_button_present ? '' : ' (⚠ upload-кнопка не появилась за 15с — попробую всё равно)'}`)
      setJobPatch(job.id, { progress: 30 })
    } catch (e) {
      setJobPatch(job.id, {
        status: 'failed', progress: 100,
        error: `Не удалось открыть отдельный Gemini-чат: ${e.message || e}`,
        result: { kind: 'video', retryable: true },
        finishedAt: now(),
      })
      return
    }

    // 2. Send the prompt + image into THAT session via /v1/sessions/{id}/send.
    try {
      const sent = await sendIntoVideoSession(jobSessionId, {
        prompt,
        attachments: input.attachments || [],
      })
      content = sent.reply
      appendJobLog(job.id, `Запрос отправлен в Gemini (картинок прикреплено: ${sent.imageCount})`)
      if ((input.attachments || []).some((a) => String(a?.type || '').startsWith('image/')) && sent.imageCount === 0) {
        appendJobLog(job.id, '⚠ Картинка не прикрепилась — Gemini, скорее всего, попросит её ещё раз')
      }
    } catch (e) {
      appendJobLog(job.id, `Ошибка отправки в Gemini: ${e.message || e}`)
      // Don't abort — proxy may still have queued the message; let polling try.
      content = ''
    }
    setJobPatch(job.id, { progress: 70 })
  } else {
    // Non-video Gemini jobs: keep the old shared-session behaviour.
    try {
      content = await callGeminiProxy({ prompt, model, attachments: input.attachments || [] })
    } catch (e) {
      setJobPatch(job.id, {
        status: 'failed', progress: 100,
        error: `Не удалось отправить запрос в Gemini: ${e.message || e}`,
        result: { kind: 'doc', retryable: false },
        finishedAt: now(),
      })
      return
    }
    setJobPatch(job.id, { progress: 70 })
  }

  appendJobLog(job.id, 'Ответ Gemini получен')

  let dataUrls = extractDataUrls(content)
  let remoteUrls = []

  // Async video: if no usable video came back on the first call, poll the
  // SAME chat reply via the proxy's /poll-media endpoint until Veo finishes.
  // We no longer gate on the "creating video…" wording because Gemini also
  // sometimes returns just a poster image or an empty placeholder.
  if (isVideo && dataUrls.filter((u) => u.startsWith('data:video/')).length === 0) {
    if (VIDEO_PENDING_RE.test(content)) {
      appendJobLog(job.id, 'Видео генерируется асинхронно — ожидаю готовности…')
    } else {
      appendJobLog(job.id, 'Видео не пришло в первом ответе — переключаюсь на passive polling')
    }
    const polled = await pollGeminiVideo(job, model, jobSessionId)
    if (polled.cancelled) {
      appendJobLog(job.id, 'Задача отменена пользователем во время ожидания видео')
      await deleteVideoSession(jobSessionId)
      return
    }
    if (polled.sessionLost) {
      setJobPatch(job.id, {
        status: 'failed', progress: 100,
        error: 'Выделенная Gemini-сессия закрылась раньше времени (headless Chrome перезапустился?). Нажми «Повторить запрос видео».',
        result: { content: polled.content || content, kind: 'video', retryable: true },
        finishedAt: now(),
      })
      // Session is already gone; no chat to delete.
      return
    }
    if (polled.dataUrls.length) {
      content = polled.content
      dataUrls = polled.dataUrls
    } else if (polled.timedOut) {
      appendJobLog(job.id, 'Видео не успело сгенерироваться за отведённое время (25 мин лимит)')
      remoteUrls = polled.remoteUrls || []
      const errMsg = remoteUrls.length
        ? 'Видео сгенерировано, но скачать его автоматически не удалось. Нажми «Повторить запрос видео» — попробую снова в новом чате.'
        : 'Gemini не вернул готовое видео за отведённое время. Попробуйте ещё раз позже или нажмите «Повторить запрос видео» в карточке.'
      if (remoteUrls.length) {
        appendJobLog(job.id, `Получены ${remoteUrls.length} ссылок на видео — UI предложит докачать в новой попытке`)
      }
      setJobPatch(job.id, {
        status: 'failed', progress: 100, error: errMsg,
        result: { content, remoteUrls, retryable: true, kind: 'video' },
        finishedAt: now(),
      })
      // Trash the abandoned Gemini chat so it doesn't pollute the sidebar.
      // The retry button creates a fresh job → fresh session anyway.
      await deleteVideoSession(jobSessionId)
      return
    } else if (polled.content) {
      content = polled.content
    }
  }

  setJobPatch(job.id, { progress: 90 })
  const files = await saveDataUrlsToWorkspace(job.chatId, dataUrls)

  // For media jobs, an empty file list means we produced nothing usable.
  if (isVideo && files.length === 0) {
    setJobPatch(job.id, {
      status: 'failed',
      progress: 100,
      error: 'Не удалось получить файл видео из Gemini. Нажми «Повторить запрос видео» в карточке.',
      result: { content, files, dataUrlsCount: dataUrls.length, retryable: true, kind: 'video' },
      finishedAt: now(),
    })
    await deleteVideoSession(jobSessionId)
    return
  }

  setJobPatch(job.id, {
    status: 'succeeded',
    progress: 100,
    result: {
      content,
      files,
      dataUrlsCount: dataUrls.length,
      kind: isVideo ? 'video' : (files.some((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)) ? 'image' : 'doc'),
    },
    finishedAt: now(),
  })
  // Free the headless Gemini tab now that the video is safely in workspace.
  if (isVideo) await deleteVideoSession(jobSessionId)

  // Web Push: ping the owner that their long-running media job is done.
  // No-op when push isn't configured (web-push missing, no subscriptions).
  try {
    if (job.userId) {
      const { notifyUser } = await import('./push.js')
      await notifyUser(job.userId, {
        title: 'BrowserAI',
        body: isVideo ? '🎬 Видео готово!' : '🖼 Изображение готово!',
        data: { url: '/' },
        tag: `job-${job.id}`,
      })
    }
  } catch { /* push optional */ }
}

// Re-run a video job that previously timed out or produced no usable file.
// Reuses the same chat session / model / attachments as the original.
export async function retryVideoJob(originalJobId) {
  const orig = getJob(originalJobId)
  if (!orig) throw new Error('original job not found')
  if (orig.type !== 'gemini_video') throw new Error('not a video job')
  const newJob = createJob({
    userId: orig.userId || '',
    chatId: orig.chatId || '',
    type: 'gemini_video',
    title: orig.title || 'gemini video (retry)',
    input: orig.input || {},
  })
  void startJob(newJob.id)
  return newJob
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

async function geminiText(prompt, fallback = '') {
  try {
    const out = await callGeminiProxy({ prompt, model: DEFAULT_GEMINI_MODEL, attachments: [] })
    return out || fallback
  } catch {
    return fallback
  }
}

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
      if (job.type.startsWith('gemini_')) await runGeminiJob(job)
      else if (job.type.startsWith('generate_')) await runLocalDocumentJob(job)
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
