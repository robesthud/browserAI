import { describe, expect, it } from 'vitest'
import { getRecoveryAction, getRecoveryHint } from '../server/recoveryEngine.js'

describe('recovery engine', () => {
  it('recovers ENOENT by listing the parent directory', () => {
    const r = getRecoveryAction({ tool: 'read_file', error: 'ENOENT no such file', args: { path: 'src/Missing.jsx' }, recentToolHistory: [] })
    expect(r?.recoverable).toBe(true)
    expect(r?.action).toEqual({ tool: 'list_files', args: { path: 'src' } })
  })

  it('recovers failed edit matches by re-reading the file', () => {
    const r = getRecoveryAction({ tool: 'edit_file', error: 'old_text not found in src/App.jsx', args: { path: 'src/App.jsx' }, recentToolHistory: [] })
    expect(r?.action).toEqual({ tool: 'read_file', args: { path: 'src/App.jsx' } })
  })

  it('asks for credentials on auth failures', () => {
    const r = getRecoveryAction({ tool: 'web_fetch', error: 'HTTP 403 forbidden', args: {} })
    expect(r?.recoverable).toBe(false)
    expect(r?.action?.tool).toBe('ask_user')
  })

  it('provides recovery playbook hints', () => {
    const hint = getRecoveryHint({ tool: 'bash', error: 'timeout' })
    expect(hint).toContain('[failure_playbook]')
    expect(hint).toContain('Timeout/long command')
  })
})
