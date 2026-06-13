import { createIncident, createIncidentWorkflow, resolveIncident, listIncidents } from './incidents.js'

let timer = null
let failStreak = 0
let okStreak = 0
let lastIncidentId = ''
let lastWorkflowAt = 0

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000
const DEFAULT_HEALTH_URL = process.env.PRODUCTION_WATCHDOG_URL || 'http://127.0.0.1:8080/api/health'

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

export function startProductionWatchdog() {
  if (timer) return
  const enabled = process.env.PRODUCTION_WATCHDOG_ENABLED !== '0'
  if (!enabled) {
    console.log('[watchdog] disabled (PRODUCTION_WATCHDOG_ENABLED=0)')
    return
  }
  const intervalMs = Math.max(30_000, Number(process.env.PRODUCTION_WATCHDOG_INTERVAL_MS || DEFAULT_INTERVAL_MS))
  timer = setInterval(() => { watchdogTick().catch((e) => console.warn('[watchdog] tick failed:', e?.message || e)) }, intervalMs)
  timer.unref?.()
  setTimeout(() => { watchdogTick().catch((e) => console.warn('[watchdog] initial tick failed:', e?.message || e)) }, 20_000).unref?.()
  console.log(`[watchdog] started: ${DEFAULT_HEALTH_URL}, interval=${intervalMs}ms`)
}

export function stopProductionWatchdog() {
  if (timer) clearInterval(timer)
  timer = null
}

export default { startProductionWatchdog, stopProductionWatchdog }
