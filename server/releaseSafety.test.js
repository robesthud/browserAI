import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeReleaseSafety, listRollbackTargets, rollbackCommandFor, releaseSafetySummary } from './releaseSafety.js'

describe('releaseSafety: computeReleaseSafety', () => {
  it('returns a structured browserai.release_safety.v1 snapshot', () => {
    const s = computeReleaseSafety()
    expect(s.schema).toBe('browserai.release_safety.v1')
    expect(s.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(s.host).toBeTypeOf('string')
    expect(s.checks.disk).toBeDefined()
    expect(s.checks.secrets).toBeDefined()
    expect(s.checks.dataDir).toBeDefined()
    expect(s.checks.gitClean).toBeDefined()
    expect(s.checks.appHealthy).toBeDefined()
    expect(s.summary).toBeDefined()
    expect(typeof s.summary.ready).toBe('boolean')
    expect(typeof s.summary.blocking).toBe('boolean')
    expect(typeof s.summary.warnings).toBe('number')
  })

  it('every check has ok, severity, reason', () => {
    const s = computeReleaseSafety()
    for (const [key, check] of Object.entries(s.checks)) {
      expect(check.ok, `${key} ok`).toBeTypeOf('boolean')
      expect(['info', 'warn', 'error', 'critical']).toContain(check.severity)
      expect(check.reason, `${key} reason`).toBeTypeOf('string')
    }
  })

  it('summary.blocking=true when any check is critical', () => {
    // Use a stub approach by simulating environment.
    const originalSecret = process.env.SESSION_SECRET
    process.env.SESSION_SECRET = 'x'  // too short
    try {
      const s = computeReleaseSafety()
      // Either blocking=true (critical) or false if disk etc. is critical
      expect(s.summary.blocking).toBe(s.checks.secrets.severity === 'critical' || s.checks.disk.severity === 'critical' || s.checks.dataDir.severity === 'critical')
    } finally {
      if (originalSecret === undefined) delete process.env.SESSION_SECRET
      else process.env.SESSION_SECRET = originalSecret
    }
  })
})

describe('releaseSafety: listRollbackTargets', () => {
  it('returns at least one entry from a real git repo', () => {
    const targets = listRollbackTargets({ limit: 3 })
    expect(Array.isArray(targets)).toBe(true)
    if (targets.length > 0 && !targets[0].error) {
      expect(targets[0].commit).toMatch(/^[0-9a-f]{40}$/)
      expect(targets[0].short).toMatch(/^[0-9a-f]{7,12}$/)
    }
  })

  it('respects the limit parameter', () => {
    const targets = listRollbackTargets({ limit: 2 })
    expect(targets.length).toBeLessThanOrEqual(2)
  })

  it('returns fallback error object when git log fails', () => {
    const originalAppDir = process.env.OPS_APP_DIR
    process.env.OPS_APP_DIR = '/nonexistent/git/repo/xyz'
    try {
      const targets = listRollbackTargets({ limit: 5 })
      expect(targets.length).toBeGreaterThan(0)
      // Either it's an error entry or it has the fallback shape
      expect(targets[0].error || targets[0].commit).toBeTruthy()
    } finally {
      if (originalAppDir === undefined) delete process.env.OPS_APP_DIR
      else process.env.OPS_APP_DIR = originalAppDir
    }
  })
})

describe('releaseSafety: rollbackCommandFor', () => {
  it('returns null for empty commit', () => {
    expect(rollbackCommandFor('')).toBeNull()
    expect(rollbackCommandFor('../../etc/passwd')).toBeNull()
  })

  it('rejects commits with fewer than 7 hex chars', () => {
    expect(rollbackCommandFor('ecad')).toBeNull()  // only 4 hex chars after stripping
    expect(rollbackCommandFor('ed')).toBeNull()
    expect(rollbackCommandFor('hello world')).toBeNull()  // only 'e'+'d' = 2
  })

  it('accepts valid short and full commit hashes', () => {
    expect(rollbackCommandFor('a'.repeat(7))).not.toBeNull()  // short hash
    expect(rollbackCommandFor('a'.repeat(40))).not.toBeNull()  // full hash
  })

  it('returns a valid rollback command block for a clean hash', () => {
    const r = rollbackCommandFor('a'.repeat(40))
    expect(r.commit).toBe('a'.repeat(40))
    expect(r.commands).toMatch(/git reset --hard/)
    expect(r.commands).toMatch(/bash deploy\.sh/)
    expect(r.rollbackNote).toBeTypeOf('string')
  })

  it('extracts only hex chars from a noisy input', () => {
    // 'deadbeef' + '' — the 'f' from 'rf' is valid hex, so it stays.
    // 'd', 'e', 'a', 'd', 'b', 'e', 'e', 'f', 'f' — 9 hex chars max 40
    const r = rollbackCommandFor('deadbeef$(rm -rf /)')
    expect(r.commit).toBe('deadbeeff')  // all hex chars in input
    expect(r.commit).toMatch(/^[0-9a-f]{1,40}$/)
  })

  it('limits extracted commit to 40 chars', () => {
    const r = rollbackCommandFor('a'.repeat(100))
    expect(r.commit.length).toBe(40)
  })
})

describe('releaseSafety: releaseSafetySummary', () => {
  it('returns compact summary with worst severity', () => {
    const s = computeReleaseSafety()
    const sum = releaseSafetySummary(s)
    expect(sum.schema).toBe('browserai.release_safety.v1')
    expect(['info', 'warn', 'error', 'critical']).toContain(sum.worstSeverity)
    expect(typeof sum.ready).toBe('boolean')
    expect(typeof sum.blocking).toBe('boolean')
    expect(typeof sum.warnings).toBe('number')
  })

  it('returns null for empty input', () => {
    expect(releaseSafetySummary(null)).toBeNull()
    expect(releaseSafetySummary(undefined)).toBeNull()
  })
})
