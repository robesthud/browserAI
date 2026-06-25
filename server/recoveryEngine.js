import { classifyToolFailure, buildFailurePlaybook } from './failurePlaybooks.js'
import { runtimeSemantics } from './agentRuntimeSemantics.js'

// Approach 2 — Runtime Unification parity.
// `getRecoveryAction` historically checked raw tool names (edit_file, git_clone, ...).
// After the move to consolidated tool calls, those checks would miss the
// consolidated equivalents (file(action: edit), git(action: clone), ...).
// We now use semantic family+action dispatch everywhere so both forms match.

function parentDir(path = '') {
  const parts = String(path || '').split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

export function getRecoveryAction({ tool, error, result = null, args = {}, recentToolHistory = [] } = {}) {
  const err = String(error || '').toLowerCase()
  const path = args.path || args.file || args.file_path
  
  // === Circuit Breaker Defense ===
  // If the same tool failed consecutively 3 or more times, trigger an escalation
  // to prevent infinite money/token burning loops.
  const lastThree = (recentToolHistory || []).slice(-3)
  const consecutiveFailures = lastThree.filter(h => !h.ok && h.tool === tool).length
  if (consecutiveFailures >= 3) {
    return {
      recoverable: false,
      message: `[Circuit Breaker] Инструмент ${tool} дал сбой ${consecutiveFailures} раза подряд. Предотвращаю зацикливание и эскалирую проблему пользователю.`,
      action: { 
        tool: 'ask_user', 
        args: { 
          question: `Инструмент ${tool} дал сбой несколько раз подряд. Ошибка: "${err.slice(0, 100)}...". Как продолжить работу?`, 
          options: ['Продолжить попытки', 'Остановить агента'] 
        } 
      }
    }
  }

  const recent = (recentToolHistory || []).slice(-6).map((h) => `${h.tool}:${h.ok ? 'ok' : 'fail'}`).join('|')
  const classification = classifyToolFailure({ tool, error, result, args })
  const playbook = buildFailurePlaybook(classification)

  const _argsJson1 = (() => { try { return JSON.stringify(args || {}) } catch { return '{}' } })()
  if (runtimeSemantics({ tool, args: _argsJson1, outcome: '' }).isEdit && (err.includes('old_text not found') || err.includes('not found in')) && path) {
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

  const _argsJson2 = (() => { try { return JSON.stringify(args || {}) } catch { return '{}' } })()
  if (runtimeSemantics({ tool, args: _argsJson2, outcome: '' }).action === 'clone' && (err.includes('already exists') || err.includes('destination path'))) {
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

  if (err.includes('eaddrinuse') && err.includes('port')) {
    const portMatch = err.match(/:(\d{4,5})\b/) || err.match(/port\s+(\d{4,5})\b/i);
    const port = portMatch ? portMatch[1] : '3000';
    return {
      recoverable: true,
      message: `Порт ${port} занят. Нахожу и принудительно освобождаю порт.`,
      action: { tool: 'bash', args: { command: `fuser -k ${port}/tcp || true` } }
    };
  }

  if (err.includes('command not found') || err.includes('enoent')) {
    const binMatch = err.match(/command not found:\s*(\w+)/i) || err.match(/(\w+):\s*not found/i);
    if (binMatch && binMatch[1]) {
      const bin = binMatch[1];
      return {
        recoverable: true,
        message: `Отсутствует системная утилита ${bin}. Автоматически устанавливаю её в контейнер.`,
        action: { tool: 'bash', args: { command: `apk add --no-cache ${bin} || apt-get install -y ${bin}` } }
      };
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
