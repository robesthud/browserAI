import { describe, expect, it } from 'vitest'
import { categoryOf, requiresApproval } from './approvalGate.js'

/**
 * Approach 2 — Runtime Unification parity for approval categories.
 *
 * Consolidated tool calls (file/shell/verify/git/docker/ops/web/browser)
 * must be categorized identically to their legacy equivalents so that
 * approval policies don't behave differently depending on which form the
 * model emits.
 */
describe('approvalGate: categoryOf parity (consolidated vs legacy)', () => {
  it('file family — read actions map to read, write/edit map to write', () => {
    // legacy read-side
    expect(categoryOf('read_file')).toBe('read')
    expect(categoryOf('list_files')).toBe('read')
    expect(categoryOf('search_files')).toBe('read')
    expect(categoryOf('workspace_snapshot_list')).toBe('read')
    // consolidated read-side
    expect(categoryOf('file', { action: 'list' })).toBe('read')
    expect(categoryOf('file', { action: 'read', path: 'x' })).toBe('read')
    expect(categoryOf('file', { action: 'search', query: 'foo' })).toBe('read')
    // legacy write-side
    expect(categoryOf('write_file')).toBe('write')
    expect(categoryOf('edit_file')).toBe('write')
    expect(categoryOf('delete_file')).toBe('write')
    expect(categoryOf('create_folder')).toBe('write')
    // consolidated write-side
    expect(categoryOf('file', { action: 'write', path: 'x' })).toBe('write')
    expect(categoryOf('file', { action: 'edit', path: 'x' })).toBe('write')
    expect(categoryOf('file', { action: 'delete', path: 'x' })).toBe('write')
  })

  it('shell family maps to bash category for both consolidated and legacy', () => {
    expect(categoryOf('bash')).toBe('bash')
    expect(categoryOf('shell_session_run')).toBe('bash')
    expect(categoryOf('shell', { action: 'run' })).toBe('bash')
    expect(categoryOf('shell', { action: 'background_start' })).toBe('bash')
    expect(categoryOf('shell', { action: 'reset' })).toBe('bash')
  })

  it('verify family maps to bash category for both forms', () => {
    expect(categoryOf('verify_code')).toBe('bash')
    expect(categoryOf('verify_task')).toBe('bash')
    expect(categoryOf('npm_test')).toBe('bash')
    expect(categoryOf('verify', { action: 'code' })).toBe('bash')
    expect(categoryOf('verify', { action: 'task' })).toBe('bash')
    expect(categoryOf('verify', { action: 'npm_test' })).toBe('bash')
  })

  it('git family maps to git category for both forms', () => {
    expect(categoryOf('git_status')).toBe('git')
    expect(categoryOf('git_commit')).toBe('git')
    expect(categoryOf('git_clone')).toBe('git')
    expect(categoryOf('git', { action: 'status' })).toBe('git')
    expect(categoryOf('git', { action: 'commit' })).toBe('git')
    expect(categoryOf('git', { action: 'clone' })).toBe('git')
  })

  it('docker family maps to deploy category', () => {
    expect(categoryOf('docker_ps')).toBe('deploy')
    expect(categoryOf('docker_logs')).toBe('deploy')
    expect(categoryOf('docker', { action: 'ps' })).toBe('deploy')
    expect(categoryOf('docker', { action: 'logs', container: 'web' })).toBe('deploy')
  })

  it('ops family maps to deploy category', () => {
    expect(categoryOf('ops_run_action')).toBe('deploy')
    expect(categoryOf('ops_list_services')).toBe('read')   // read action → 'read'
    expect(categoryOf('ops', { action: 'run', service: 'web' })).toBe('deploy')
    expect(categoryOf('ops', { action: 'list' })).toBe('read')
  })

  it('web family maps to net category', () => {
    expect(categoryOf('web_search')).toBe('net')
    expect(categoryOf('web_fetch')).toBe('net')
    expect(categoryOf('web', { action: 'search' })).toBe('net')
    expect(categoryOf('web', { action: 'fetch' })).toBe('net')
  })

  it('browser family maps to net category', () => {
    expect(categoryOf('browser_open')).toBe('net')
    expect(categoryOf('browser_screenshot')).toBe('net')
    expect(categoryOf('browser', { action: 'open' })).toBe('net')
    expect(categoryOf('browser', { action: 'screenshot' })).toBe('net')
  })

  it('mcp__ prefix maps to mcp category regardless of family dispatch', () => {
    expect(categoryOf('mcp__my_server_tool')).toBe('mcp')
  })

  it('unknown tools default to net', () => {
    expect(categoryOf('weird_unregistered_tool')).toBe('net')
  })
})

describe('approvalGate: requiresApproval parity', () => {
  // Default policy is 'auto' for all categories, so most calls do NOT require approval.
  // We just need to verify parity: if legacy form does/does not require approval,
  // consolidated form must do the same.

  it('ask_user never requires approval regardless of name', () => {
    expect(requiresApproval('ask_user', 'u1', {})).toBe(false)
  })

  it('catastrophic bash command requires approval', () => {
    expect(requiresApproval('bash', 'u1', { command: 'rm -rf /' })).toBe(true)
    expect(requiresApproval('shell_session_run', 'u1', { command: 'rm -rf /' })).toBe(true)
  })

  it('deploy/git/docker bash commands do not require approval under default auto policy', () => {
    expect(requiresApproval('bash', 'u1', { command: 'docker compose up -d --build browserai' })).toBe(false)
    expect(requiresApproval('bash', 'u1', { command: 'git push origin main' })).toBe(false)
    expect(requiresApproval('shell_session_run', 'u1', { command: 'systemctl restart browserai' })).toBe(false)
  })

  it('safe bash commands do not require approval under default policy', () => {
    expect(requiresApproval('bash', 'u1', { command: 'ls -la' })).toBe(false)
    expect(requiresApproval('shell_session_run', 'u1', { command: 'ls -la' })).toBe(false)
  })
})
