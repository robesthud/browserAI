import { describe, expect, it } from 'vitest'
import { getRecoveryAction, getRecoveryHint } from './recoveryEngine.js'

/**
 * Approach 2 — Runtime Unification parity for recovery heuristics.
 *
 * Recovery actions for edit_file/git_clone/etc. must trigger identically
 * for the consolidated equivalents (file(action: edit), git(action: clone)).
 */
describe('recoveryEngine parity (consolidated vs legacy)', () => {
  it('edit_file "old_text not found" suggests read_file', () => {
    const r1 = getRecoveryAction({ tool: 'edit_file', args: { path: 'src/app.js' }, error: 'old_text not found in file' })
    const r2 = getRecoveryAction({ tool: 'file', args: { action: 'edit', path: 'src/app.js' }, error: 'old_text not found in file' })
    expect(r1?.recoverable).toBe(true)
    expect(r1?.action?.tool).toBe('read_file')
    expect(r2?.recoverable).toBe(true)
    expect(r2?.action?.tool).toBe('read_file')
  })

  it('git_clone "already exists" suggests list_files', () => {
    const r1 = getRecoveryAction({ tool: 'git_clone', args: { url: 'x', dest: 'repo' }, error: 'destination path already exists' })
    const r2 = getRecoveryAction({ tool: 'git', args: { action: 'clone', url: 'x', dest: 'repo' }, error: 'destination path already exists' })
    expect(r1?.recoverable).toBe(true)
    expect(r2?.recoverable).toBe(true)
  })

  it('unrelated errors return null for both forms', () => {
    const r1 = getRecoveryAction({ tool: 'edit_file', args: {}, error: 'something else' })
    const r2 = getRecoveryAction({ tool: 'file', args: { action: 'edit' }, error: 'something else' })
    expect(r1).toBeNull()
    expect(r2).toBeNull()
  })

  it('getRecoveryHint returns same message for consolidated and legacy', () => {
    const h1 = getRecoveryHint({ tool: 'edit_file', args: { path: 'a.js' }, error: 'old_text not found' })
    const h2 = getRecoveryHint({ tool: 'file', args: { action: 'edit', path: 'a.js' }, error: 'old_text not found' })
    expect(h1).toBe(h2)
  })
})
