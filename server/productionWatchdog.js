import { createIncident, createIncidentWorkflow, resolveIncident, listIncidents } from './incidents.js'
import log from './logger.js'
import { execSync } from 'node:child_process'

let timer = null
let failStreak = 0
let okStreak = 0
let lastIncidentId = ''
let lastWorkflowAt = 0

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000
const DEFAULT_HEALTH_URL = process.env.PRODUCTION_WATCHDOG_URL || 'http://127.0.0.1:8080/api/health'

// Disk usage monitor — alerts via Telegram when disk > threshold
const DISK_WARN_PCT  = Number(process.env.WATCHDOG_DISK_WARN_PCT  || 80)
const DISK_CRIT_PCT  = Number(process.env.WATCHDOG_DISK_CRIT_PCT  || 92)
let lastDiskAlertAt  = 0
const DISK_ALERT_COOLDOWN_MS = 60 * 60 * 1000  // max 1 alert/hour

function checkDiskUsage() {
  try {
    const out = execSync('df -P / | tail -1', { encoding: 'utf8', timeout: 5_000 })
    const usedPct = Number(String(out.trim().split(/\s+/)[4] || '0').replace('%', ''))
    return { usedPct, ok: usedPct < DISK_CRIT_PCT }
  } catch { return { usedPct: 0, ok: true } }
}

async function notifyWatchdog(text) {
  const token  = process.env.TG_BOT_TOKEN || ''
  const chatId = process.env.TG_ADMIN_CHAT_ID || process.env.TG_CHAT_ID || ''
  if (!token || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3500) }),
      signal: AbortSignal.timeout(8000),
    })
  } catch { /* best-effort */ }
}

async function checkHealth(url = DEFAULT_HEALTH_URL) {
  const started = Date.now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(Number(process.env.PRODUCTION_WATCHDOG_TIMEOUT_MS || 5000)) })
    const text = await r.text().catch(() => '')
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - started, body: text.slice(0, 500) }
  } catch (e) {
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: e?.message || String(e) }
  }
}

async function watchdogTick() {
  const url = DEFAULT_HEALTH_URL
  const result = await checkHealth(url)
  if (result.ok) {
    okStreak += 1
    failStreak = 0
    if (okStreak >= 2 && lastIncidentId) {
      try { resolveIncident(lastIncidentId, { note: `watchdog recovered: ${url}` }) } catch { /* best-effort */ }
      lastIncidentId = ''
    }
    return result
  }

  failStreak += 1
  okStreak = 0
  const threshold = Math.max(1, Number(process.env.PRODUCTION_WATCHDOG_FAIL_THRESHOLD || 2))
  if (failStreak < threshold) return result

  const incident = createIncident({
    source: 'production.watchdog',
    severity: 'high',
    title: `Production health failed: ${url}`,
    fingerprint: `production-health-${url}`,
    details: { url, result, failStreak, checkedAt: new Date().toISOString() },
  })
  lastIncidentId = incident.id

  const cooldownMs = Math.max(60_000, Number(process.env.PRODUCTION_WATCHDOG_WORKFLOW_COOLDOWN_MS || 15 * 60 * 1000))
  const hasRecentOpen = listIncidents({ status: 'investigating', limit: 20 }).some((i) => i.source === 'production.watchdog' && i.workflowId && Date.now() - Number(i.updatedAt || 0) < cooldownMs)
  if (!hasRecentOpen && Date.now() - lastWorkflowAt > cooldownMs) {
    try {
      createIncidentWorkflow({ incident, recipeId: 'browserai_full_diagnostic', input: { watchdog: true, health: result, notifyTelegram: true } })
      lastWorkflowAt = Date.now()
    } catch (e) {
      console.warn('[watchdog] diagnostic workflow failed:', e?.message || e)
    }
  }
  return result
}

async function diskWatchdogTick() {
  const disk = checkDiskUsage()
  if (disk.usedPct < DISK_WARN_PCT) return
  const now = Date.now()
  if (now - lastDiskAlertAt < DISK_ALERT_COOLDOWN_MS) return
  lastDiskAlertAt = now
  const emoji = disk.usedPct >= DISK_CRIT_PCT ? '🔴' : '🟡'
  const msg = `${emoji} BrowserAI disk alert\nUsage: ${disk.usedPct}% / ${disk.usedPct >= DISK_CRIT_PCT ? 'CRITICAL' : 'WARNING'}\nThreshold: warn=${DISK_WARN_PCT}% crit=${DISK_CRIT_PCT}%\n\nFree space: run \`du -sh /opt/browserai-data/*\` to find large dirs.`
  await notifyWatchdog(msg)
  console.warn(`[watchdog] disk alert: ${disk.usedPct}%`)
  if (disk.usedPct >= DISK_CRIT_PCT) {
    try {
      createIncident({
        source: 'production.watchdog.disk',
        severity: 'critical',
        title: `Disk ${disk.usedPct}% — CRITICAL`,
        fingerprint: 'disk-critical',
        details: { usedPct: disk.usedPct },
      })
    } catch { /* best-effort */ }
  }
}

export function startProductionWatchdog() {
  if (timer) return
  const enabled = process.env.PRODUCTION_WATCHDOG_ENABLED !== '0'
  if (!enabled) {
    console.log('[watchdog] disabled (PRODUCTION_WATCHDOG_ENABLED=0)')
    return
  }
  const intervalMs = Math.max(30_000, Number(process.env.PRODUCTION_WATCHDOG_INTERVAL_MS || DEFAULT_INTERVAL_MS))
  timer = setInterval(() => {
    watchdogTick().catch((e) => console.warn('[watchdog] tick failed:', e?.message || e))
    diskWatchdogTick().catch((e) => console.warn('[watchdog] disk tick failed:', e?.message || e))
  }, intervalMs)
  timer.unref?.()
  setTimeout(() => { watchdogTick().catch((e) => console.warn('[watchdog] initial tick failed:', e?.message || e)) }, 20_000).unref?.()
  console.log(`[watchdog] started: ${DEFAULT_HEALTH_URL}, interval=${intervalMs}ms`)
}

export function stopProductionWatchdog() {
  if (timer) clearInterval(timer)
  timer = null
}

export default { startProductionWatchdog, stopProductionWatchdog }
