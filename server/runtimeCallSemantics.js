import { runtimeSemantics } from './agentRuntimeSemantics.js'

export function normalizeRuntimeCall(call = {}) {
  const tool = String(call?.tool || '')
  const args = call?.args && typeof call.args === 'object' ? call.args : {}
  const semantic = runtimeSemantics({ tool, args: JSON.stringify(args), outcome: '' })
  return { ...call, semantic }
}

export function narrateRuntimeCall(call = {}, agentContext = {}) {
  const semantic = call.semantic || normalizeRuntimeCall(call).semantic
  const cmd = String(semantic.command || '')
  const type = agentContext?.task?.type || 'task'

  if (semantic.family === 'shell') {
    if (semantic.tool === 'shell_session_run') return 'Выполняю команду в постоянной shell-сессии: так сохраняются cwd/env и удобнее вести длинную разработческую работу.'
    if (semantic.tool === 'shell_background_start') return 'Запускаю долгую команду в фоне, чтобы можно было читать вывод и не блокировать Agent Mode.'
    if (semantic.tool === 'shell_background_read') return 'Читаю текущий stdout/stderr фоновой команды.'
    if (semantic.tool === 'shell_background_stop') return 'Останавливаю фоновую shell-команду.'
    if (semantic.tool === 'shell_session_reset') return 'Сбрасываю постоянную shell-сессию, чтобы восстановить чистое состояние.'
    if (/npm\s+(test|run test)|pnpm\s+test|yarn\s+test|vitest|jest/i.test(cmd)) return 'Запускаю тесты через shell, чтобы подтвердить изменения реальным выводом.'
    if (/npm\s+run\s+build|pnpm\s+build|yarn\s+build|vite build/i.test(cmd)) return 'Запускаю сборку через shell, чтобы проверить production-готовность.'
    if (/git\s+status/i.test(cmd)) return 'Проверяю состояние git перед следующими действиями.'
    if (/git\s+diff/i.test(cmd)) return 'Смотрю diff, чтобы убедиться, что изменения именно те, которые нужны.'
    if (/curl|wget/i.test(cmd)) return 'Проверяю endpoint/health через shell.'
    if (/docker\s+logs|docker\s+ps|docker compose/i.test(cmd)) return 'Проверяю Docker-состояние и логи через shell.'
    if (/grep|rg|find|ls|pwd|cat|sed/i.test(cmd)) return 'Осматриваю проект через shell, чтобы быстро найти нужные файлы и контекст.'
    return 'Выполняю связанный набор команд через shell, чтобы ход работы был компактным и понятным.'
  }

  if (semantic.family === 'file') {
    if (semantic.action === 'list') return 'Сначала смотрю структуру workspace, чтобы работать по реальным путям.'
    if (semantic.action === 'read') return `Читаю файл ${semantic.path || ''}, прежде чем делать выводы или правки.`
    if (semantic.action === 'search') return 'Ищу по проекту релевантные места для задачи.'
    if (semantic.action === 'write' || semantic.action === 'edit') return `Вношу изменение в ${semantic.path || 'файл'} и затем проверю результат.`
  }

  if (semantic.family === 'verify') return 'Запускаю проверку после изменений, чтобы не заявлять успех без evidence.'
  if (semantic.tool === 'secret_scan') return 'Проверяю, что в изменения не попали секреты.'
  if (semantic.family === 'git') return 'Выполняю git-шаг и буду опираться только на результат команды.'
  if (semantic.family === 'ops') return 'Выполняю operator/ops действие с последующей проверкой состояния.'
  if (semantic.tool === 'ask_user') return 'Нужна твоя развилка/подтверждение, без неё безопасно продолжить нельзя.'
  return `Выполняю инструмент ${semantic.tool || call.tool} для шага ${type}.`
}

export function shouldReadBackCall(call = {}) {
  const semantic = call.semantic || normalizeRuntimeCall(call).semantic
  return semantic.family === 'file' && ['write', 'edit'].includes(semantic.action) && Boolean(semantic.path)
}

export function violatesPreDeployVerifyCall(call = {}, recentToolHistory = []) {
  const semantic = call.semantic || normalizeRuntimeCall(call).semantic
  if (!semantic.isCommit) return false
  for (let i = recentToolHistory.length - 1; i >= Math.max(0, recentToolHistory.length - 14); i -= 1) {
    const h = recentToolHistory[i]
    if (h?.ok && (h.semantic?.isVerify || ['verify_code', 'verify_task', 'npm_test', 'run_tests'].includes(h.tool))) return false
    const cmd = String(h?.semantic?.command || '')
    if (h?.ok && /(npm|pnpm|yarn)\s+(test|run\s+test|run\s+build|build)|vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test/i.test(cmd)) return false
  }
  return true
}

export default normalizeRuntimeCall
