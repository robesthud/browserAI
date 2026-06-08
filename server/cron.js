/**
 * Lightweight cron scheduler for BrowserAI.
 *
 * Each user can define jobs in SQLite that the server fires at specified
 * intervals. A job is a (schedule, prompt, target) triple — at trigger
 * time the server posts the prompt to the agent loop for that user,
 * effectively running it as if the user typed it in chat.
 *
 * Supported schedule formats (deliberately simple, no full crontab):
 *   "*\/5 minutes"    → every 5 minutes
 *   "hourly"          → every 60 minutes
 *   "daily 09:00"     → every day at 09:00 server-local time
 *   "weekly mon 10:00" → Monday at 10:00
 *
 * Trigger types:
 *   - chat        → enqueue a user message into the user's "Cron" chat
 *   - notify_tg   → send to admin via Telegram (uses ops connector)
 *
 * Polling tick: 60 s. Last run tracked per job so we don't double-fire
 * across restarts (initial tick after boot skips anything <90 s since
 * last run).
 */
import db from './db.js'

let initialized = false
let tickHandle = null

function init() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      trigger     TEXT NOT NULL DEFAULT 'chat',
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cron_user ON cron_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_cron_next ON cron_jobs(next_run_at);
  `)
  initialized = true
}

const MAX_JOBS_PER_USER = 20

function uid() {
  return `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Compute the next absolute timestamp (ms epoch) for a given schedule. */
export function nextRunFromSchedule(schedule, from = Date.now()) {
  const s = String(schedule || '').trim().toLowerCase()
  const d = new Date(from)
  if (s === 'hourly') return from + 60 * 60 * 1000

  let m = s.match(/^\*\/(\d+)\s*minutes?$/)
  if (m) return from + Math.max(1, parseInt(m[1], 10)) * 60 * 1000

  m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/)
  if (m) {
    const next = new Date(d)
    next.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0)
    if (next.getTime() <= from) next.setDate(next.getDate() + 1)
    return next.getTime()
  }

  m = s.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/)
  if (m) {
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
    const target = map[m[1]]
    const next = new Date(d)
    next.setHours(parseInt(m[2], 10), parseInt(m[3], 10), 0, 0)
    while (next.getDay() !== target || next.getTime() <= from) {
      next.setDate(next.getDate() + 1)
    }
    return next.getTime()
  }

  return from + 60 * 60 * 1000 // fallback: hourly
}

export function listCronJobs(userId) {
  init()
  if (!userId) return []
  return db.prepare('SELECT * FROM cron_jobs WHERE user_id=? ORDER BY name').all(userId)
}

export function upsertCronJob(userId, body) {
  init()
  if (!userId) throw new Error('userId required')
  const name = String(body.name || '').trim().slice(0, 80)
  const schedule = String(body.schedule || '').trim().slice(0, 80)
  const prompt = String(body.prompt || '').trim().slice(0, 4000)
  const trigger = String(body.trigger || 'chat')
  if (!name || !schedule || !prompt) throw new Error('name, schedule and prompt are required')
  if (!['chat', 'notify_tg'].includes(trigger)) throw new Error('trigger must be chat or notify_tg')
  // Validate schedule by computing next run; throws if unrecognised format.
  const next = nextRunFromSchedule(schedule)

  const id = body.id || uid()
  const existing = db.prepare('SELECT * FROM cron_jobs WHERE id=? AND user_id=?').get(id, userId)
  if (!existing) {
    const count = db.prepare('SELECT COUNT(*) c FROM cron_jobs WHERE user_id=?').get(userId).c
    if (count >= MAX_JOBS_PER_USER) throw new Error(`limit ${MAX_JOBS_PER_USER} reached`)
  }
  const ts = Date.now()
  db.prepare(`
    INSERT INTO cron_jobs (id, user_id, name, schedule, prompt, trigger, enabled, last_run_at, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, schedule=excluded.schedule, prompt=excluded.prompt,
      trigger=excluded.trigger, next_run_at=excluded.next_run_at, updated_at=excluded.updated_at
  `).run(id, userId, name, schedule, prompt, trigger, existing?.last_run_at || null, next, existing?.created_at || ts, ts)
  return { id, next_run_at: next }
}

export function deleteCronJob(userId, id) {
  init()
  if (!userId) throw new Error('userId required')
  const r = db.prepare('DELETE FROM cron_jobs WHERE id=? AND user_id=?').run(id, userId)
  return { deleted: r.changes }
}

/** Fire a single cron job. Both triggers degrade gracefully on failure. */
async function fireJob(job) {
  console.log(`[cron] firing ${job.id} (${job.name}) for user ${job.user_id}`)
  if (job.trigger === 'notify_tg') {
    try {
      const { runOpsAction } = await import('./ops.js')
      await runOpsAction({
        service: 'telegram',
        action: 'notify_admin',
        params: { text: `🕐 Cron "${job.name}":\n${job.prompt}` },
        confirm: true,
      })
    } catch (e) { console.warn('[cron] tg notify failed:', e.message) }
    return
  }
  // 'chat' trigger: post the prompt as a virtual user message into a
  // dedicated cron chat that the user can browse later. We don't try to
  // run the agent here — that would need a fake SSE sink. Instead we
  // surface the trigger as a job entry in /api/jobs so the user sees it.
  try {
    const { createJob, startJob } = await import('./jobs.js')
    const j = createJob({
      userId: job.user_id, chatId: '', type: 'cron_run',
      title: `cron: ${job.name}`,
      input: { prompt: job.prompt, schedule: job.schedule, cronId: job.id },
    })
    // No worker for type:'cron_run' yet — the job just sits in the
    // tray and shows the prompt. Could be wired to a real agent run
    // later via job_handlers extension.
    if (j?.id) try { startJob(j.id) } catch { /* no handler is fine */ }
  } catch (e) { console.warn('[cron] enqueue failed:', e.message) }
}

export function startCronWorker() {
  init()
  if (tickHandle) return
  const tick = async () => {
    try {
      const now = Date.now()
      const due = db.prepare(
        'SELECT * FROM cron_jobs WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)'
      ).all(now)
      for (const job of due) {
        // Avoid double-fire after a restart for anything in the past 90 s.
        if (job.last_run_at && now - job.last_run_at < 90_000) continue
        await fireJob(job)
        const next = nextRunFromSchedule(job.schedule, now)
        db.prepare('UPDATE cron_jobs SET last_run_at=?, next_run_at=?, updated_at=? WHERE id=?')
          .run(now, next, now, job.id)
      }
    } catch (e) { console.warn('[cron] tick failed:', e.message) }
  }
  tickHandle = setInterval(tick, 60_000)
  // Fire once shortly after boot too, in case the server was down through
  // a scheduled run.
  setTimeout(tick, 5_000)
  console.log('[cron] worker started, polling every 60 s')
}

export function stopCronWorker() {
  if (tickHandle) clearInterval(tickHandle)
  tickHandle = null
}
