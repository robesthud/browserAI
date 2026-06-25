import { describe, expect, it } from 'vitest'
import {
  historyAction,
  historyPath,
  isFileToolAction,
  isVerificationHistoryEntry,
  hasLocalTestAttempt,
  hasSuccessfulLocalTest,
  needsVerificationSinceLastEdit,
  obligationCompletionStatus,
  normalizeRuntimeHistoryEntry,
  runtimeSemantics,
} from './agentRuntimeSemantics.js'

const digest = (args) => JSON.stringify(args)

describe('agentRuntimeSemantics', () => {
  it('normalizes consolidated tool metadata through history args', () => {
    const entry = { tool: 'file', ok: true, args: digest({ action: 'write', path: 'src/app.js' }) }
    expect(historyAction(entry)).toBe('write')
    expect(historyPath(entry)).toBe('src/app.js')
    expect(isFileToolAction(entry, 'write')).toBe(true)
  })

  it('creates normalized semantic entries with evidence tags', () => {
    const entry = normalizeRuntimeHistoryEntry({
      tool: 'shell',
      ok: true,
      args: digest({ action: 'run', command: 'cd app && npm test' }),
      outcome: 'exit=0 duration=40ms',
    })
    expect(entry.semantic.family).toBe('shell')
    expect(entry.semantic.isLocalTest).toBe(true)
    expect(entry.semantic.evidenceTags).toContain('verify')
    expect(entry.semantic.evidenceTags).toContain('local_test')
    expect(runtimeSemantics(entry).command).toContain('npm test')
  })

  it('recognizes consolidated verification and local test attempts', () => {
    const verifyEntry = { tool: 'verify', ok: true, args: digest({ action: 'task' }), outcome: 'passed 3 checks' }
    const shellEntry = { tool: 'shell', ok: true, args: digest({ action: 'run', command: 'cd app && npm test' }), outcome: 'exit=0 duration=50ms' }
    expect(isVerificationHistoryEntry(verifyEntry)).toBe(true)
    expect(hasLocalTestAttempt([verifyEntry, shellEntry])).toBe(true)
    expect(hasSuccessfulLocalTest([verifyEntry, shellEntry])).toBe(true)
  })

  it('requires post-edit verification using the unified semantics layer', () => {
    const edited = [{ tool: 'file', ok: true, args: digest({ action: 'write', path: 'src/app.js' }) }]
    const verified = [...edited, { tool: 'verify', ok: true, args: digest({ action: 'code', path: 'src/app.js' }) }]
    expect(needsVerificationSinceLastEdit(edited)).toBe(true)
    expect(needsVerificationSinceLastEdit(verified)).toBe(false)
  })

  it('computes obligations from consolidated history without legacy-only assumptions', () => {
    const history = [
      { tool: 'file', ok: true, args: digest({ action: 'list', path: '' }), outcome: '2 entries' },
      { tool: 'file', ok: true, args: digest({ action: 'read', path: 'README.md' }), outcome: '120 chars' },
      { tool: 'file', ok: true, args: digest({ action: 'write', path: 'src/app.js' }), outcome: '80 bytes written' },
      { tool: 'verify', ok: true, args: digest({ action: 'task' }), outcome: 'passed 2 checks' },
      { tool: 'shell', ok: true, args: digest({ action: 'run', command: 'git commit -m "ok" && git push' }), outcome: 'exit=0 duration=30ms pushed=true' },
    ]
    const status = obligationCompletionStatus({ inspect: true, codeChange: true, verify: true, commit: true, push: true }, history)
    expect(status.inspect).toBe(true)
    expect(status.codeChange).toBe(true)
    expect(status.verify).toBe(true)
    expect(status.commit).toBe(true)
    expect(status.push).toBe(true)
  })
})
