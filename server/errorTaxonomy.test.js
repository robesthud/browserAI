import { describe, expect, it } from 'vitest'
import { classifyError, ERROR_CATEGORIES, SEVERITIES, groupByFingerprint, isCritical } from './errorTaxonomy.js'

describe('errorTaxonomy: classifyError', () => {
  it('classifies auth errors', () => {
    const r = classifyError({ err: new Error('401 Unauthorized: invalid api key'), tool: 'bash' })
    expect(r.category).toBe('auth')
    expect(r.severity).toBe('error')
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('classifies provider rate-limit errors', () => {
    const r = classifyError({ reason: '429 Too Many Requests', tool: 'openai_compat' })
    expect(r.category).toBe('provider')
    expect(r.severity).toBe('error')
  })

  it('classifies route errors (404/400)', () => {
    const r = classifyError({ reason: '400 Bad Request: missing field', route: '/api/agent/chat' })
    expect(r.category).toBe('route')
  })

  it('classifies workspace_scope errors', () => {
    const r = classifyError({ reason: 'workspace_scope: invalid scope' })
    expect(r.category).toBe('workspace_scope')
  })

  it('classifies tool_schema errors', () => {
    const r = classifyError({ reason: 'unknown action "z" for tool "file"' })
    expect(r.category).toBe('tool_schema')
  })

  it('classifies loop_stuck from exitReason', () => {
    const r = classifyError({ exitReason: 'max-steps' })
    expect(r.category).toBe('loop_stuck')
    expect(r.severity).toBe('warn')
  })

  it('classifies llm_runtime from exitReason', () => {
    const r = classifyError({ exitReason: 'crash', err: new Error('boom') })
    expect(r.category).toBe('llm_runtime')
  })

  it('classifies provider failures from no-provider', () => {
    const r = classifyError({ exitReason: 'no-provider' })
    expect(r.category).toBe('provider')
    expect(r.severity).toBe('error')
  })

  it('classifies verification_missing blockers', () => {
    const r = classifyError({ reason: 'missing_verification: code changed but no verify' })
    expect(r.category).toBe('verification_missing')
  })

  it('classifies false_finalization / fabrication', () => {
    const r = classifyError({ reason: 'fabrication: cited imaginary/path.js' })
    expect(r.category).toBe('false_finalization')
    expect(r.severity).toBe('error')
  })

  it('classifies deploy_runtime', () => {
    const r = classifyError({ reason: 'deploy.sh failed: docker compose up returned 1' })
    expect(r.category).toBe('deploy_runtime')
  })

  it('returns unknown for unrecognized reasons', () => {
    const r = classifyError({ reason: 'something completely arbitrary' })
    expect(r.category).toBe('unknown')
    expect(r.severity).toBe('warn')
  })

  it('fingerprint is stable across same-shape errors', () => {
    const a = classifyError({ err: new Error('401 unauthorized'), tool: 'bash' })
    const b = classifyError({ err: new Error('401 Unauthorized'), tool: 'bash' })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.category).toBe(b.category)
  })

  it('fingerprint differs when tool differs', () => {
    const a = classifyError({ reason: 'rate limit', tool: 'openai' })
    const b = classifyError({ reason: 'rate limit', tool: 'anthropic' })
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('does NOT leak api keys / secrets into reason', () => {
    const r = classifyError({ err: new Error('call to https://api.example?key=sk-secret-123 failed') })
    expect(r.reason).not.toContain('sk-secret-123')
  })
})

describe('errorTaxonomy: helpers', () => {
  it('ERROR_CATEGORIES contains the canonical 12', () => {
    expect(ERROR_CATEGORIES).toContain('auth')
    expect(ERROR_CATEGORIES).toContain('provider')
    expect(ERROR_CATEGORIES).toContain('workspace_scope')
    expect(ERROR_CATEGORIES).toContain('tool_schema')
    expect(ERROR_CATEGORIES).toContain('tool_execution')
    expect(ERROR_CATEGORIES).toContain('loop_stuck')
    expect(ERROR_CATEGORIES).toContain('llm_runtime')
    expect(ERROR_CATEGORIES).toContain('verification_missing')
    expect(ERROR_CATEGORIES).toContain('false_finalization')
    expect(ERROR_CATEGORIES).toContain('deploy_runtime')
    expect(ERROR_CATEGORIES).toContain('unknown')
  })

  it('SEVERITIES is info|warn|error|critical', () => {
    expect(SEVERITIES).toEqual(['info', 'warn', 'error', 'critical'])
  })

  it('groupByFingerprint collapses identical errors', () => {
    const errors = [
      { fingerprint: 'aaa', category: 'auth', reason: 'x', ts: 't1' },
      { fingerprint: 'aaa', category: 'auth', reason: 'y', ts: 't2' },
      { fingerprint: 'bbb', category: 'provider', reason: 'z', ts: 't3' },
    ]
    const groups = groupByFingerprint(errors)
    expect(groups).toHaveLength(2)
    expect(groups[0].fingerprint).toBe('aaa')
    expect(groups[0].count).toBe(2)
    expect(groups[1].fingerprint).toBe('bbb')
    expect(groups[1].count).toBe(1)
  })

  it('isCritical is true for critical severity or false_finalization/deploy_runtime', () => {
    expect(isCritical('auth', 'critical')).toBe(true)
    expect(isCritical('false_finalization', 'error')).toBe(true)
    expect(isCritical('deploy_runtime', 'error')).toBe(true)
    expect(isCritical('auth', 'error')).toBe(false)
    expect(isCritical('provider', 'warn')).toBe(false)
  })
})
