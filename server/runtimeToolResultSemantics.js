import { runtimeSemantics } from './agentRuntimeSemantics.js'

/**
 * runtimeToolResultSemantics.js
 *
 * Approach 2 — Runtime Unification. Dispatch by semantic family+action,
 * NOT by raw tool name. This guarantees that consolidated `file(action:"write")`
 * and legacy `write_file` produce the same toolSucceeded() / summarizeToolOutcome()
 * result, and likewise for all other consolidated↔legacy pairs.
 */

export function toolSucceeded(tool, resultEnvelope, args = {}) {
  if (!resultEnvelope?.ok) return false
  const result = resultEnvelope.result || {}
  const semantic = runtimeSemantics({ tool, args: JSON.stringify(args || {}), outcome: '' })
  const family = semantic.family
  const action = semantic.action
  const exitCode = result.exitCode != null ? Number(result.exitCode) : null

  if (family === 'shell') {
    if (exitCode != null) return exitCode === 0
    return true
  }

  if (family === 'verify') {
    if (action === 'code') return result.valid !== false && result.ok !== false
    if (action === 'task') return result.passed === true
    if (action === 'npm_test') return result.passed === true || exitCode === 0
    if (action === 'run_tests') return result.passed !== false
    if (action === 'test_command') return exitCode === 0 || result.passed === true
    if (action === 'verify_command') return exitCode === 0 || result.valid !== false
    return true
  }

  if (family === 'file') {
    return true
  }

  if (family === 'git') {
    return result.committed !== false && result.cloned !== false
  }

  if (family === 'docker') {
    if (action === 'ps') return Array.isArray(result.containers) || Array.isArray(result) || true
    if (action === 'logs') return typeof result.logs === 'string' || typeof result.stdout === 'string' || true
    return true
  }

  if (family === 'ops') {
    if (action === 'run' && exitCode != null) return exitCode === 0
    if (action === 'list') return Array.isArray(result.services) || Array.isArray(result) || true
    return true
  }

  if (family === 'web') {
    if (action === 'search') return Array.isArray(result.results) || Array.isArray(result) || true
    if (action === 'fetch') return typeof result.markdown === 'string' || typeof result.text === 'string' || true
    return true
  }

  if (family === 'browser') {
    return true
  }

  return true
}

export function summarizeToolOutcome(tool, resultEnvelope, args = {}) {
  if (!resultEnvelope?.ok) return String(resultEnvelope?.error || 'failed').slice(0, 180)
  const result = resultEnvelope.result
  const semantic = runtimeSemantics({ tool, args: JSON.stringify(args || {}), outcome: '' })
  const family = semantic.family
  const action = semantic.action

  if (family === 'file') {
    if (action === 'read') return `${result?.content?.length || result?.text?.length || 0} chars`
    if (action === 'write') return `${result?.bytes || 0} bytes written`
    if (action === 'edit') return `replaced=${result?.replaced ?? 1}`
    if (action === 'list') return `${result?.tree?.children?.length || 0} entries`
    if (action === 'search') return `${result?.matches?.length || 0} matches`
    if (action === 'delete') return `deleted=${Boolean(result?.deleted)}`
    if (action === 'create_folder') return `created=${Boolean(result?.created)}`
    if (action === 'rename') return `renamed=${Boolean(result?.renamed)}`
    if (action === 'zip') return `path=${result?.file_path || ''} entries=${result?.entries || 0}`
    if (action === 'snapshot_create') return `id=${result?.id || ''} entries=${result?.entries || 0}`
    if (action === 'snapshot_restore') return `id=${result?.id || ''} restored=${Boolean(result?.restored)}`
    if (action === 'snapshot_list') return `${result?.snapshots?.length || 0} snapshots`
    return String(result?.message || 'ok').slice(0, 180)
  }

  if (family === 'shell') {
    if (action === 'background_start') return `task=${result?.taskId || ''}`
    if (action === 'background_read') return `running=${Boolean(result?.running)} exit=${result?.exitCode ?? ''}`
    if (action === 'background_stop') return `stopped=${Boolean(result?.stopped)}`
    if (action === 'background_list') return `${result?.tasks?.length || 0} tasks`
    if (action === 'reset') return `reset=${Boolean(result?.reset)}`
    const changed = result?.changedFiles
    const changedPart = changed?.total ? ` changed=${changed.total} codeChanged=${Boolean(changed.codeChanged)} paths=${(changed.all || []).slice(0, 8).join(',')}` : ''
    return `exit=${result?.exitCode ?? '?'} duration=${result?.durationMs || 0}ms${changedPart}`
  }

  if (family === 'verify') {
    if (action === 'code') return result?.valid === false ? 'invalid' : 'valid/skipped'
    if (action === 'npm_test') return result?.passed ? 'passed' : `failed exit=${result?.exitCode ?? '?'}`
    if (action === 'task') return result?.passed ? `passed ${result?.results?.length || 0} checks` : `failed ${result?.results?.length || 0} checks`
    if (action === 'npm_install') return `installed=${Boolean(result?.installed)} exit=${result?.exitCode ?? '?'}`
    if (action === 'secret_scan') return result?.ok ? `ok scanned=${result?.scannedFiles || 0}` : `findings high=${result?.high || 0} medium=${result?.medium || 0}`
    if (action === 'run_tests') return result?.passed ? 'passed' : 'failed'
    return String(result?.message || 'verified').slice(0, 180)
  }

  if (family === 'git') {
    if (action === 'clone') return `path=${result?.path || ''}`
    if (action === 'commit') return `committed=${result?.committed !== false} pushed=${Boolean(result?.pushed)} ${String(result?.stderr || '').slice(0, 80)}`
    if (action === 'status') return `${result?.files?.length || 0} files changed`
    return String(result?.message || 'ok').slice(0, 180)
  }

  if (family === 'docker') {
    if (action === 'ps') return `${result?.containers?.length || (Array.isArray(result) ? result.length : 0)} containers`
    if (action === 'logs') return `lines=${result?.lines || (typeof result?.logs === 'string' ? result.logs.split('\n').length : 0)}`
    return String(result?.message || 'ok').slice(0, 180)
  }

  if (family === 'ops') {
    if (action === 'run') return `exit=${result?.exitCode ?? '?'} ${String(result?.stdout || result?.message || '').slice(0, 120)}`
    if (action === 'list') return `${result?.services?.length || 0} services`
    return String(result?.message || 'ok').slice(0, 180)
  }

  if (family === 'web') {
    if (action === 'search') return `${result?.results?.length || 0} results`
    if (action === 'fetch') return `${(result?.markdown || result?.text || '').length} chars`
    return String(result?.message || 'ok').slice(0, 180)
  }

  if (family === 'browser') {
    if (action === 'screenshot') return `path=${result?.path || ''} ${result?.bytes || 0} bytes`
    if (action === 'open') return `url=${result?.url || ''}`
    return String(result?.message || 'ok').slice(0, 180)
  }

  return String(result?.message || result?.path || result?.file_path || 'ok').slice(0, 180)
}

export default toolSucceeded
