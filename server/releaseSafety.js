/**
 * releaseSafety.js
 *
 * Approach 7 — Trust UX + Prod Readiness. Pre-deploy safety + post-deploy
 * rollback helpers.
 *
 * Computes a structured safety snapshot for an operator before they push
 * a new release. Each check has:
 *   - ok: boolean
 *   - severity: 'info' | 'warn' | 'error' | 'critical'
 *   - reason: short string
 *   - detail: optional longer string
 *
 * Operator UI surfaces the snapshot at GET /api/operator/release-safety
 * and refuses to deploy if any check is severity=critical.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'

// RS-1: sanitize APP_DIR — strip shell metacharacters before using in execSync
const APP_DIR = String(process.env.OPS_APP_DIR || '/opt/browserai').replace(/[;&|`$(){}!]/g, '').trim() || '/opt/browserai'
const DATA_DIR = process.env.DATA_DIR || '/data'

const DEPLOY_DISK_WARN_PCT = 80
const DEPLOY_DISK_BLOCK_PCT = 92

function checkDiskUsage() {
  try {
    const out = execSync('df -P / | tail -1', { encoding: 'utf8', timeout: 5_000 })
    const parts = out.trim().split(/\s+/)
    const usedPct = Number(String(parts[5] || '0').replace('%', ''))
    if (Number.isNaN(usedPct)) return { ok: true, severity: 'info', reason: 'df output unparseable', detail: out.trim() }
    if (usedPct >= DEPLOY_DISK_BLOCK_PCT) {
      return { ok: false, severity: 'critical', reason: `Disk ${usedPct}% used — above block threshold ${DEPLOY_DISK_BLOCK_PCT}%`, detail: out.trim() }
    }
    if (usedPct >= DEPLOY_DISK_WARN_PCT) {
      return { ok: true, severity: 'warn', reason: `Disk ${usedPct}% used — above warn threshold ${DEPLOY_DISK_WARN_PCT}%`, detail: out.trim() }
    }
    return { ok: true, severity: 'info', reason: `Disk ${usedPct}% used` }
  } catch (e) {
    return { ok: true, severity: 'warn', reason: 'Disk usage check failed', detail: String(e.message || e).slice(0, 240) }
  }
}

function checkSecretsPresent() {
  const required = ['SESSION_SECRET', 'AUTH_SECRET']
  const missing = []
  for (const key of required) {
    if (!process.env[key] || String(process.env[key]).length < 16) missing.push(key)
  }
  // SESSION_SECRET='change-me' is the dev fallback — fail in prod.
  if (process.env.NODE_ENV === 'production' && process.env.SESSION_SECRET === 'change-me') {
    missing.push('SESSION_SECRET (still dev default)')
  }
  if (missing.length) {
    return { ok: false, severity: 'critical', reason: 'Required secrets missing or too short', detail: missing.join(', ') }
  }
  return { ok: true, severity: 'info', reason: 'All required secrets present' }
}

function checkDataDirWritable() {
  try {
    const probe = path.join(DATA_DIR, `.release_safety_probe_${Date.now()}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { ok: true, severity: 'info', reason: 'DATA_DIR writable' }
  } catch (e) {
    return { ok: false, severity: 'critical', reason: 'DATA_DIR not writable', detail: String(e.message || e).slice(0, 240) }
  }
}

function checkGitClean() {
  try {
    const out = execSync(`git -C ${APP_DIR} status --porcelain 2>&1`, { encoding: 'utf8', timeout: 5_000 })
    if (out && out.trim()) {
      return { ok: false, severity: 'warn', reason: 'Working tree has uncommitted changes', detail: out.trim().slice(0, 600) }
    }
    return { ok: true, severity: 'info', reason: 'Working tree clean' }
  } catch (e) {
    return { ok: true, severity: 'warn', reason: 'Git status check failed', detail: String(e.message || e).slice(0, 240) }
  }
}

function checkAppHealthy() {
  try {
    const out = execSync('curl -fsS http://127.0.0.1:8080/api/health', { encoding: 'utf8', timeout: 5_000 })
    const j = JSON.parse(out || '{}')
    return { ok: true, severity: 'info', reason: 'Health OK', detail: JSON.stringify(j) }
  } catch (e) {
    return { ok: false, severity: 'error', reason: 'App health check failed', detail: String(e.message || e).slice(0, 240) }
  }
}

export function computeReleaseSafety() {
  const checks = {
    disk: checkDiskUsage(),
    secrets: checkSecretsPresent(),
    dataDir: checkDataDirWritable(),
    gitClean: checkGitClean(),
    appHealthy: checkAppHealthy(),
  }
  const severities = Object.values(checks).map((c) => c.severity)
  const blocking = severities.includes('critical')
  const warnings = severities.filter((s) => s === 'warn' || s === 'error').length
  return {
    schema: 'browserai.release_safety.v1',
    computedAt: new Date().toISOString(),
    host: os.hostname(),
    checks,
    summary: {
      blocking,
      warnings,
      ready: !blocking,
    },
  }
}

export function listRollbackTargets({ limit = 10 } = {}) {
  try {
    const out = execSync(`git -C ${APP_DIR} log --pretty=format:"%H%x09%h%x09%s%x09%ai" -n ${Math.max(1, Math.min(100, Number(limit) || 10))}`, { encoding: 'utf8', timeout: 5_000 })
    const lines = (out || '').split('\n').filter(Boolean)
    return lines.map((line) => {
      const [hash, short, subject, date] = line.split('\t')
      return { commit: hash, short, subject, date }
    })
  } catch (e) {
    return [{ error: 'git_log_failed', message: String(e.message || e).slice(0, 240) }]
  }
}

export function rollbackCommandFor(commitHash = '') {
  // Accept only commits that LOOK like git hashes after sanitization.
  // A real short hash is 7+ hex chars; a full hash is 40. Anything else
  // (path traversal characters, accidental substrings) is too dangerous
  // to feed to git reset --hard.
  const stripped = String(commitHash || '').replace(/[^0-9a-f]/g, '')
  if (stripped.length < 7) return null
  const safe = stripped.slice(0, 40)
  // RS-2: APP_DIR is already sanitized at module level; safe is hex-only
  return {
    commit: safe,
    commands: [
      `cd ${JSON.stringify(APP_DIR)}`,
      `git fetch origin main`,
      `git reset --hard ${safe}`,
      `bash deploy.sh`,
    ].join('\n'),
    rollbackNote: 'Verify /api/health after deploy. If broken, restore from backup.',
  }
}

export function releaseSafetySummary(snapshot = null) {
  if (!snapshot) return null
  return {
    schema: snapshot.schema,
    computedAt: snapshot.computedAt,
    ready: snapshot.summary?.ready,
    warnings: snapshot.summary?.warnings,
    blocking: snapshot.summary?.blocking,
    worstSeverity: Object.values(snapshot.checks || {}).reduce(
      (acc, c) => {
        const order = ['info', 'warn', 'error', 'critical']
        return order.indexOf(c?.severity) > order.indexOf(acc) ? c.severity : acc
      },
      'info',
    ),
  }
}

export default { computeReleaseSafety, listRollbackTargets, rollbackCommandFor, releaseSafetySummary }
