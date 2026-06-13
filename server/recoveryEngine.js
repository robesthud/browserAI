function parentDir(path = '') {
  const parts = String(path || '').split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

export function getRecoveryAction({ tool, error, args = {}, recentToolHistory = [] } = {}) {
  const err = String(error || '').toLowerCase()
  const path = args.path || args.file || args.file_path
  const recent = (recentToolHistory || []).slice(-6).map((h) => `${h.tool}:${h.ok ? 'ok' : 'fail'}`).join('|')

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

  if ((tool === 'npm_test' || tool === 'bash') && /(test failed|failed tests|npm err|exit code|exit=1|command failed)/i.test(String(error || ''))) {
    return {
      recoverable: true,
      message: 'Command/test failed. Inspect the stderr/stdout and fix the relevant files before retrying.',
      action: null,
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
      message: 'The action timed out. Retry with a narrower command or ask before running a long job.',
      action: null,
    }
  }

  return null
}

export function getRecoveryHint({ tool, error, args = {}, recentToolHistory = [] } = {}) {
  const r = getRecoveryAction({ tool, error, args, recentToolHistory })
  return r?.message || null
}

export default { getRecoveryAction, getRecoveryHint }
