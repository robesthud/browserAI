import { describe, expect, it } from 'vitest'
import {
  runtimeSemantics,
  normalizeRuntimeHistoryEntry,
  isFileToolAction,
  isVerifyToolAction,
  isCodeEditHistoryEntry,
  isVerificationHistoryEntry,
  needsVerificationSinceLastEdit,
  hasLocalTestAttempt,
  hasSuccessfulLocalTest,
} from './agentRuntimeSemantics.js'

/**
 * Consolidated vs legacy parity tests — Approach 2.
 *
 * The runtime MUST treat `file(action:'read')` and `read_file` as semantically
 * equivalent. Same for `file(action:'write')` ≡ `write_file`,
 * `verify(action:'code')` ≡ `verify_code`, `verify(action:'npm_test')` ≡ `npm_test`,
 * `shell(action:'run')` ≡ `bash`, `git(action:'commit')` ≡ `git_commit`.
 *
 * If these tests fail, the agent runtime is regressing into path-dependent
 * behavior, which is exactly what Approach 2 is meant to prevent.
 */
describe('semantic parity (consolidated vs legacy tool names)', () => {
  it('read: file(action:read) ≡ read_file', () => {
    const consolidated = runtimeSemantics({ tool: 'file', args: JSON.stringify({ action: 'read', path: 'src/app.js' }) })
    const legacy = runtimeSemantics({ tool: 'read_file', args: JSON.stringify({ path: 'src/app.js' }) })
    expect(consolidated.family).toBe(legacy.family)
    expect(consolidated.action).toBe(legacy.action)
    expect(consolidated.isRead).toBe(true)
    expect(legacy.isRead).toBe(true)
    expect(consolidated.path).toBe(legacy.path)
  })

  it('write: file(action:write) ≡ write_file', () => {
    const consolidated = runtimeSemantics({ tool: 'file', args: JSON.stringify({ action: 'write', path: 'src/app.js', content: 'x' }) })
    const legacy = runtimeSemantics({ tool: 'write_file', args: JSON.stringify({ path: 'src/app.js', content: 'x' }) })
    expect(consolidated.isWrite).toBe(true)
    expect(legacy.isWrite).toBe(true)
    expect(consolidated.evidenceTags).toContain('change')
    expect(legacy.evidenceTags).toContain('change')
  })

  it('edit: file(action:edit) ≡ edit_file', () => {
    const consolidated = runtimeSemantics({ tool: 'file', args: JSON.stringify({ action: 'edit', path: 'src/app.js', old_text: 'a', new_text: 'b' }) })
    const legacy = runtimeSemantics({ tool: 'edit_file', args: JSON.stringify({ path: 'src/app.js', old_text: 'a', new_text: 'b' }) })
    expect(consolidated.isEdit).toBe(true)
    expect(legacy.isEdit).toBe(true)
  })

  it('list: file(action:list) ≡ list_files', () => {
    const consolidated = runtimeSemantics({ tool: 'file', args: JSON.stringify({ action: 'list' }) })
    const legacy = runtimeSemantics({ tool: 'list_files', args: JSON.stringify({}) })
    expect(consolidated.isList).toBe(true)
    expect(legacy.isList).toBe(true)
    expect(consolidated.isInspect).toBe(true)
    expect(legacy.isInspect).toBe(true)
  })

  it('search: file(action:search) ≡ search_files', () => {
    const consolidated = runtimeSemantics({ tool: 'file', args: JSON.stringify({ action: 'search', query: 'foo' }) })
    const legacy = runtimeSemantics({ tool: 'search_files', args: JSON.stringify({ query: 'foo' }) })
    expect(consolidated.isSearch).toBe(true)
    expect(legacy.isSearch).toBe(true)
  })

  it('shell run: shell(action:run) ≡ bash', () => {
    const consolidated = runtimeSemantics({ tool: 'shell', args: JSON.stringify({ action: 'run', command: 'ls -la' }) })
    const legacy = runtimeSemantics({ tool: 'bash', args: JSON.stringify({ command: 'ls -la' }) })
    expect(consolidated.family).toBe('shell')
    expect(legacy.family).toBe('shell')
    expect(consolidated.command).toBe(legacy.command)
  })

  it('verify code: verify(action:code) ≡ verify_code', () => {
    const consolidated = runtimeSemantics({ tool: 'verify', args: JSON.stringify({ action: 'code', path: 'src/app.js' }) })
    const legacy = runtimeSemantics({ tool: 'verify_code', args: JSON.stringify({ path: 'src/app.js' }) })
    expect(consolidated.family).toBe('verify')
    expect(legacy.family).toBe('verify')
    expect(consolidated.verificationKind).toBe('code')
    expect(legacy.verificationKind).toBe('code')
    expect(consolidated.isVerify).toBe(true)
    expect(legacy.isVerify).toBe(true)
  })

  it('verify npm_test: verify(action:npm_test) ≡ npm_test', () => {
    const consolidated = runtimeSemantics({ tool: 'verify', args: JSON.stringify({ action: 'npm_test' }) })
    const legacy = runtimeSemantics({ tool: 'npm_test', args: JSON.stringify({}) })
    expect(consolidated.verificationKind).toBe('npm_test')
    expect(legacy.verificationKind).toBe('npm_test')
    expect(consolidated.isLocalTest).toBe(true)
    expect(legacy.isLocalTest).toBe(true)
  })

  it('verify task: verify(action:task) ≡ verify_task', () => {
    const consolidated = runtimeSemantics({ tool: 'verify', args: JSON.stringify({ action: 'task' }) })
    const legacy = runtimeSemantics({ tool: 'verify_task', args: JSON.stringify({}) })
    expect(consolidated.verificationKind).toBe('task')
    expect(legacy.verificationKind).toBe('task')
    expect(consolidated.isLocalTest).toBe(true)
    expect(legacy.isLocalTest).toBe(true)
  })

  it('git commit: git(action:commit) ≡ git_commit', () => {
    const consolidated = runtimeSemantics({ tool: 'git', args: JSON.stringify({ action: 'commit', message: 'fix' }) })
    const legacy = runtimeSemantics({ tool: 'git_commit', args: JSON.stringify({ message: 'fix' }) })
    expect(consolidated.family).toBe('git')
    expect(legacy.family).toBe('git')
    expect(consolidated.isCommit).toBe(true)
    expect(legacy.isCommit).toBe(true)
  })

  it('docker ps: docker(action:ps) ≡ docker_ps', () => {
    const consolidated = runtimeSemantics({ tool: 'docker', args: JSON.stringify({ action: 'ps' }) })
    const legacy = runtimeSemantics({ tool: 'docker_ps', args: JSON.stringify({}) })
    expect(consolidated.family).toBe('docker')
    expect(legacy.family).toBe('docker')
    expect(consolidated.isHealthCheck).toBe(true)
    expect(legacy.isHealthCheck).toBe(true)
  })

  it('docker logs: docker(action:logs) ≡ docker_logs', () => {
    const consolidated = runtimeSemantics({ tool: 'docker', args: JSON.stringify({ action: 'logs', container: 'web' }) })
    const legacy = runtimeSemantics({ tool: 'docker_logs', args: JSON.stringify({ container: 'web' }) })
    expect(consolidated.isLogsCheck).toBe(true)
    expect(legacy.isLogsCheck).toBe(true)
  })

  it('ops run: ops(action:run) ≡ ops_run_action', () => {
    const consolidated = runtimeSemantics({ tool: 'ops', args: JSON.stringify({ action: 'run', service: 'web', op: 'restart' }) })
    const legacy = runtimeSemantics({ tool: 'ops_run_action', args: JSON.stringify({ service: 'web', op: 'restart' }) })
    expect(consolidated.family).toBe('ops')
    expect(legacy.family).toBe('ops')
    expect(consolidated.isDeploy).toBe(true)
    expect(legacy.isDeploy).toBe(true)
  })

  it('history predicates treat consolidated and legacy identically', () => {
    const consolidatedWrite = { tool: 'file', ok: true, args: JSON.stringify({ action: 'write', path: 'src/x.js', content: 'a' }), outcome: '120 bytes written' }
    const legacyWrite = { tool: 'write_file', ok: true, args: JSON.stringify({ path: 'src/x.js', content: 'a' }), outcome: '120 bytes written' }
    expect(isCodeEditHistoryEntry(consolidatedWrite)).toBe(true)
    expect(isCodeEditHistoryEntry(legacyWrite)).toBe(true)
    expect(isFileToolAction(consolidatedWrite, 'write')).toBe(true)
    expect(isFileToolAction(legacyWrite, 'write')).toBe(true)
    expect(isFileToolAction(legacyWrite, 'read')).toBe(false)
  })

  it('verification-after-edit triggers identically for consolidated and legacy', () => {
    const consolidatedEdit = { tool: 'file', ok: true, args: JSON.stringify({ action: 'edit', path: 'src/x.js', old_text: 'a', new_text: 'b' }) }
    const legacyEdit = { tool: 'edit_file', ok: true, args: JSON.stringify({ path: 'src/x.js', old_text: 'a', new_text: 'b' }) }
    const consolidatedVerify = { tool: 'verify', ok: true, args: JSON.stringify({ action: 'code', path: 'src/x.js' }) }
    const legacyVerify = { tool: 'verify_code', ok: true, args: JSON.stringify({ path: 'src/x.js' }) }

    expect(needsVerificationSinceLastEdit([consolidatedEdit])).toBe(true)
    expect(needsVerificationSinceLastEdit([legacyEdit])).toBe(true)
    expect(needsVerificationSinceLastEdit([consolidatedEdit, consolidatedVerify])).toBe(false)
    expect(needsVerificationSinceLastEdit([legacyEdit, legacyVerify])).toBe(false)
    expect(needsVerificationSinceLastEdit([consolidatedEdit, legacyVerify])).toBe(false)
    expect(needsVerificationSinceLastEdit([legacyEdit, consolidatedVerify])).toBe(false)
  })

  it('local-test detection works identically for shell command vs npm_test tool', () => {
    const shellNpm = { tool: 'shell', ok: true, args: JSON.stringify({ action: 'run', command: 'npm test' }) }
    const npmTest = { tool: 'npm_test', ok: true, args: JSON.stringify({}) }
    expect(hasLocalTestAttempt([shellNpm])).toBe(true)
    expect(hasLocalTestAttempt([npmTest])).toBe(true)
    expect(hasSuccessfulLocalTest([shellNpm])).toBe(true)
    expect(hasSuccessfulLocalTest([npmTest])).toBe(true)
  })

  it('verifyCodeAction helper unifies action across tool families', () => {
    const codeEdit = { tool: 'file', ok: true, args: JSON.stringify({ action: 'edit', path: 'src/x.js', old_text: 'a', new_text: 'b' }) }
    const codeVerify = { tool: 'verify', ok: true, args: JSON.stringify({ action: 'code', path: 'src/x.js' }) }
    const codeVerifyLegacy = { tool: 'verify_code', ok: true, args: JSON.stringify({ path: 'src/x.js' }) }
    expect(isVerificationHistoryEntry(codeVerify)).toBe(true)
    expect(isVerificationHistoryEntry(codeVerifyLegacy)).toBe(true)
    expect(isVerifyToolAction(codeVerify, 'code')).toBe(true)
    expect(isVerifyToolAction(codeVerifyLegacy, 'code')).toBe(true)
    expect(isVerifyToolAction(codeVerifyLegacy, 'task')).toBe(false)
  })

  it('normalizeRuntimeHistoryEntry attaches identical semantic shape', () => {
    const consolidatedEntry = normalizeRuntimeHistoryEntry({ tool: 'file', ok: true, args: JSON.stringify({ action: 'write', path: 'a.js', content: 'x' }), outcome: '120 bytes written' })
    const legacyEntry = normalizeRuntimeHistoryEntry({ tool: 'write_file', ok: true, args: JSON.stringify({ path: 'a.js', content: 'x' }), outcome: '120 bytes written' })
    expect(consolidatedEntry.semantic.isWrite).toBe(true)
    expect(legacyEntry.semantic.isWrite).toBe(true)
    expect(consolidatedEntry.semantic.action).toBe(legacyEntry.semantic.action)
    expect(consolidatedEntry.semantic.family).toBe(legacyEntry.semantic.family)
  })
})
