import { classifyToolFailure, buildFailurePlaybook } from './failurePlaybooks.js'

function parentDir(path = '') {
  const parts = String(path || '').split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

export function getRecoveryAction({ tool, error, result = null, args = {}, recentToolHistory = [] } = {}) {
  const err = String(error || '').toLowerCase()
  const path = args.path || args.file || args.file_path
  const recent = (recentToolHistory || []).slice(-6).map((h) => `${h.tool}:${h.ok ? 'ok' : 'fail'}`).join('|')
  const classification = classifyToolFailure({ tool, error, result, args })
  const playbook = buildFailurePlaybook(classification)

  if (tool === 'edit_file' && (err.includes('old_text not found') || err.includes('not found in')) && path) {
    if (!recent.includes('read_file:ok')) {
      return {
        recoverable: true,
        message: `Patch did not match ${path}. Re-reading file before retry.`,
        action: { tool: 'read_file', args: { path } },
      }
    }
  }

  if ((err.includes('not found') || err.includes('enoent') || err.includes('no such file')) && path) {
    const parent = parentDir(path)
    if (!recent.includes('list_files:ok')) {
      return {
        recoverable: true,
        message: `Path not found: ${path}. Listing parent directory to recover exact name/casing.`,
        action: { tool: 'list_files', args: { path: parent } },
      }
    }
  }

  if (tool === 'git_clone' && (err.includes('already exists') || err.includes('destination path'))) {
    return {
      recoverable: true,
      message: 'Destination already exists. Inspecting files instead of cloning again.',
      action: { tool: 'list_files', args: { path: args.dest || '' } },
    }
  }

  if ((tool === 'npm_test' || tool === 'bash' || tool === 'shell_session_run') && /(test failed|failed tests|npm err|exit code|exit=1|command failed|syntaxerror|cannot find module|failed to compile|build failed)/i.test(String(error || '') + ' ' + String(result?.stderr || '') + ' ' + String(result?.stdout || ''))) {
    return {
      recoverable: true,
      message: playbook.instruction,
      action: playbook.steps?.[0] || null,
      classification,
      playbook,
    }
  }

  if (/401|403|unauthorized|forbidden|invalid token|permission denied/.test(err)) {
    return {
      recoverable: false,
      message: 'Credential or permission problem. Ask the user for a valid token/permission before retrying.',
      action: { tool: 'ask_user', args: { question: 'Нужен актуальный токен/доступ. Обновить доступ?', options: ['Да', 'Нет'] } },
    }
  }

  if (/timeout|timed out|killed after/.test(err)) {
    return {
      recoverable: true,
      message: playbook.instruction,
      action: playbook.steps?.[0] || null,
      classification,
      playbook,
    }
  }

  if (classification.primary?.id && classification.primary.id !== 'generic_failure') {
    return { recoverable: true, message: playbook.instruction, action: playbook.steps?.[0] || null, classification, playbook }
  }

  return null
}

export function getRecoveryHint({ tool, error, args = {}, recentToolHistory = [] } = {}) {
  const r = getRecoveryAction({ tool, error, args, recentToolHistory })
  return r?.message || null
}

export default { getRecoveryAction, getRecoveryHint }
