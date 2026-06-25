function parseDigestArgs(s = '') {
  try {
    const parsed = JSON.parse(String(s || '{}'))
    // Если s был '[]' → массив, не объект args
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
  } catch { return {} }
}

export const LOCAL_TEST_COMMAND_RE = /((npm|pnpm|yarn)\s+test|node\s+.*test|node\s+smoke-test\.js|python\s+-m\s+pytest|pytest|go\s+test|cargo\s+test|jest|vitest|mvn\s+test|gradle\s+test|ctest|phpunit|dotnet\s+test)/i
const INSPECT_COMMAND_RE = /(^|\s)(pwd|ls|find|grep|rg|cat)\b/i
const BUILD_OR_VERIFY_COMMAND_RE = /(npm|pnpm|yarn)\s+(test|run\s+test|run\s+build|build)|vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test/i
const DEPLOY_COMMAND_RE = /(deploy\.sh|\bdeploy\b|docker\s+compose\s+up|docker-compose\s+up|systemctl\s+restart|kubectl\s+apply|git\s+pull|git\s+reset)/i
const HEALTH_COMMAND_RE = /(curl|wget|http|health|docker logs|docker ps|compose ps|journalctl|logs)/i
const LOGS_COMMAND_RE = /(docker\s+logs|docker\s+ps|journalctl|tail\s+.*log)/i
const GIT_COMMIT_COMMAND_RE = /git\s+commit\b/i
const GIT_PUSH_COMMAND_RE = /git\s+push\b(?!.*--dry-run)/i

export function historyArgs(h = {}) {
  return h?.semantic?.args || parseDigestArgs(h.args)
}

export function historyAction(h = {}) {
  if (h?.semantic?.action) return String(h.semantic.action)
  return String(historyArgs(h).action || '').trim()
}

export function historyPath(h = {}) {
  if (h?.semantic?.path) return String(h.semantic.path)
  const args = historyArgs(h)
  return String(args.path || args.file_path || '')
}

export function toolCommand(h = {}) {
  if (h?.semantic?.command) return String(h.semantic.command)
  return String(historyArgs(h).command || '')
}

export function commandLooksLikeHealthCheck(argsText = '') {
  return HEALTH_COMMAND_RE.test(String(argsText || ''))
}

export function commandMatches(h = {}, re) {
  const tool = String(h?.tool || '')
  return ['bash', 'shell', 'shell_session_run', 'shell_background_start'].includes(tool) && re.test(toolCommand(h))
}

export function isCodeLikePath(path = '') {
  return /\.(js|mjs|cjs|jsx|ts|tsx|json|css|html|yml|yaml)$/i.test(String(path || ''))
}

function inferAction(tool = '', args = {}) {
  if (args.action) return String(args.action).trim()
  const mapping = {
    list_files: 'list',
    read_file: 'read',
    write_file: 'write',
    edit_file: 'edit',
    search_files: 'search',
    verify_code: 'code',
    verify_task: 'task',
    npm_test: 'npm_test',
    git_commit: 'commit',
    git_clone: 'clone',
    docker_logs: 'logs',
    docker_ps: 'ps',
    ops_run_action: 'run',
    ops_list_services: 'list',
    browser_open: 'open',
    browser_screenshot: 'screenshot',
  }
  return mapping[tool] || ''
}

function inferFamily(tool = '') {
  if (['file', 'list_files', 'read_file', 'write_file', 'edit_file', 'search_files', 'zip_files', 'workspace_snapshot_create', 'workspace_snapshot_restore'].includes(tool)) return 'file'
  if (['verify', 'verify_code', 'verify_task', 'npm_test', 'run_tests'].includes(tool)) return 'verify'
  if (['bash', 'shell', 'shell_session_run', 'shell_background_start', 'shell_background_read', 'shell_background_stop'].includes(tool)) return 'shell'
  if (tool === 'git' || tool.startsWith('git_')) return 'git'
  if (tool === 'ops' || tool.startsWith('ops_')) return 'ops'
  if (tool === 'docker' || tool.startsWith('docker_')) return 'docker'
  if (tool === 'web' || tool.startsWith('web_')) return 'web'
  if (tool === 'browser' || tool.startsWith('browser_')) return 'browser'
  return tool
}

export function runtimeSemantics(entry = {}) {
  if (entry?.semantic) return entry.semantic
  const tool = String(entry?.tool || '')
  const args = parseDigestArgs(entry?.args)
  const action = inferAction(tool, args)
  const family = inferFamily(tool)
  const path = String(args.path || args.file_path || '')
  const command = String(args.command || '')
  const outcome = String(entry?.outcome || '')
  const isList = (family === 'file' && action === 'list') || tool === 'list_files'
  const isRead = (family === 'file' && action === 'read') || tool === 'read_file'
  const isSearch = (family === 'file' && action === 'search') || tool === 'search_files'
  const isWrite = (family === 'file' && action === 'write') || tool === 'write_file'
  const isEdit = (family === 'file' && action === 'edit') || tool === 'edit_file'
  const isInspect = isList || isRead || isSearch || INSPECT_COMMAND_RE.test(command)
  const verificationKind =
    family === 'verify' ? action
      : tool === 'verify_code' ? 'code'
        : tool === 'verify_task' ? 'task'
          : tool === 'npm_test' ? 'npm_test'
            : tool === 'run_tests' ? 'run_tests'
              : LOCAL_TEST_COMMAND_RE.test(command) ? 'test_command'
                : BUILD_OR_VERIFY_COMMAND_RE.test(command) ? 'verify_command'
                  : ''
  const isVerify = ['code', 'task', 'npm_test', 'run_tests', 'test_command', 'verify_command'].includes(verificationKind)
  const isLocalTest = verificationKind === 'task' || verificationKind === 'npm_test' || verificationKind === 'run_tests' || verificationKind === 'test_command'
  const isCommit = (family === 'git' && action === 'commit') || GIT_COMMIT_COMMAND_RE.test(command)
  const isPush = /pushed=true/i.test(outcome) || GIT_PUSH_COMMAND_RE.test(command)
  const isDeploy = (family === 'ops' && action === 'run') || DEPLOY_COMMAND_RE.test(command)
  // Approach 2: parity between consolidated (docker(action:"ps")) and legacy (docker_ps).
  const isHealthCheck = (family === 'docker' && action === 'ps')
    || (family === 'ops' && action === 'list')
    || ['docker_ps', 'ops_list_services'].includes(tool)
    || commandLooksLikeHealthCheck(command)
  const isLogsCheck = (family === 'docker' && ['logs', 'ps'].includes(action))
    || ['docker_logs', 'docker_ps'].includes(tool)
    || LOGS_COMMAND_RE.test(command)

  const evidenceTags = [
    isInspect ? 'inspect' : '',
    isRead ? 'read' : '',
    (isWrite || isEdit) ? 'change' : '',
    isVerify ? 'verify' : '',
    isLocalTest ? 'local_test' : '',
    isCommit ? 'commit' : '',
    isPush ? 'push' : '',
    isDeploy ? 'deploy' : '',
    isHealthCheck ? 'health' : '',
    isLogsCheck ? 'logs' : '',
  ].filter(Boolean)

  return {
    tool,
    family,
    action,
    args,
    path,
    command,
    outcome,
    verificationKind,
    evidenceTags,
    isList,
    isRead,
    isSearch,
    isWrite,
    isEdit,
    isInspect,
    isVerify,
    isLocalTest,
    isCommit,
    isPush,
    isDeploy,
    isHealthCheck,
    isLogsCheck,
  }
}

export function normalizeRuntimeHistoryEntry(entry = {}) {
  return { ...entry, semantic: runtimeSemantics(entry) }
}

export function isFileToolAction(h = {}, ...actions) {
  const semantic = runtimeSemantics(h)
  if (semantic.family !== 'file') return false
  if (!actions.length) return true
  return actions.includes(semantic.action)
}

export function isVerifyToolAction(h = {}, ...actions) {
  const semantic = runtimeSemantics(h)
  if (semantic.family !== 'verify') return false
  if (!actions.length) return true
  return actions.includes(semantic.action)
}

export function isCodeEditHistoryEntry(h = {}) {
  if (!h?.ok) return false
  const semantic = runtimeSemantics(h)
  if ((semantic.isWrite || semantic.isEdit) && isCodeLikePath(semantic.path)) return true
  // Bash/session commands can change files without going through file tools.
  // The bash tool result summarizer emits `codeChanged=true` when the
  // workspace-change tracker detects code-like files touched by the command.
  if (semantic.family === 'shell' && /codeChanged=true/i.test(String(h?.outcome || semantic.outcome || ''))) return true
  return false
}

export function isVerificationHistoryEntry(h = {}) {
  return Boolean(h?.ok && runtimeSemantics(h).isVerify)
}

export function needsVerificationSinceLastEdit(recentToolHistory = []) {
  let lastEdit = -1
  for (let i = 0; i < recentToolHistory.length; i += 1) {
    if (isCodeEditHistoryEntry(recentToolHistory[i])) lastEdit = i
  }
  if (lastEdit < 0) return false
  return !recentToolHistory.slice(lastEdit + 1).some((h) => isVerificationHistoryEntry(h))
}

export function askedForExplicitLocalTest(text = '') {
  return /(smoke[- ]test|npm test|pytest|go test|cargo test|jest|vitest|run tests?|run the tests?|unit tests?|integration tests?|локальн\w*\s+проверк|проверь\s+локально|протестируй|прогони\s+тест|запусти\s+тест|запусти\s+проверку|test\s+it)/i.test(String(text || ''))
}

export function hasLocalTestAttempt(recentToolHistory = []) {
  return recentToolHistory.some((h) => runtimeSemantics(h).isLocalTest)
}

export function hasSuccessfulLocalTest(recentToolHistory = []) {
  return recentToolHistory.some((h) => h?.ok && runtimeSemantics(h).isLocalTest)
}

export function hasStrongLocalTestSuccessClaim(text = '') {
  return /(all tests passed|tests?\s+passed|passed:\s*\d+\/\d+|все тесты пройдены|все проверки пройдены|локальн\w*\s+тест\w*\s+пройден|успешно протестир|smoke[- ]test.*passed|тест:\s*pass)/i.test(String(text || ''))
}

export function hasUnsupportedEnvironmentClaim(text = '') {
  return /(не удалось проверить|невозможно проверить|ограничен\w*\s+сред|среда не разрешает|исходящ\w*\s+http|не может выполнять сетевые запросы|environment.*cannot|cannot run locally|sandbox.*does not allow|деплой.*невозможн|невозможно.*задеплоить|среда.*не.*позволяет.*деплой|cannot deploy.*sandbox|deployment.*not possible|нет.*возможности.*деплой|нельзя.*задеплоить.*среде)/i.test(String(text || ''))
}

export function unmetDoneCriteria(taskType = '', recentToolHistory = []) {
  const ok = recentToolHistory.filter((h) => h?.ok)
  const has = (predicate) => ok.some(predicate)
  if (taskType === 'repo_analysis') {
    if (!has((h) => runtimeSemantics(h).isList)) return 'Нужно сначала посмотреть дерево проекта через list_files.'
    if (!has((h) => runtimeSemantics(h).isRead || runtimeSemantics(h).isSearch)) return 'Нужно прочитать/поискать реальные файлы проекта перед анализом.'
  }
  if (taskType === 'research') {
    if (!has((h) => ['web_search', 'web_fetch', 'web'].includes(String(h.tool || '')))) return 'Нужно использовать web_search/web_fetch для research-задачи.'
  }
  if (taskType === 'browser_task') {
    const opened = has((h) => String(h.tool || '') === 'browser_open' || (String(h.tool || '') === 'browser' && historyAction(h) === 'open'))
    const shot = has((h) => String(h.tool || '') === 'browser_screenshot' || (String(h.tool || '') === 'browser' && historyAction(h) === 'screenshot'))
    if (opened && !shot) return 'После открытия страницы нужен browser_screenshot/визуальная проверка.'
  }
  if (taskType === 'deploy_ops') {
    const changedDeploy = recentToolHistory.some((h) => h?.ok && runtimeSemantics(h).isDeploy)
    if (changedDeploy) {
      const checked = recentToolHistory.some((h) => h?.ok && (runtimeSemantics(h).isHealthCheck || runtimeSemantics(h).isLogsCheck))
      if (!checked) return 'После deploy/restart/git изменения нужен health/log check (curl/docker logs/docker ps).'
    }
  }
  return ''
}

export function obligationCompletionStatus(obligations = {}, recentToolHistory = []) {
  const ok = recentToolHistory.filter((h) => h?.ok)
  const status = {
    inspect: ok.some((h) => (h.semantic || runtimeSemantics(h)).isInspect),
    codeChange: ok.some((h) => {
      const semantic = (h.semantic || runtimeSemantics(h))
      return semantic.isWrite || semantic.isEdit || semantic.isCommit || (semantic.family === 'shell' && /codeChanged=true/i.test(String(h?.outcome || semantic.outcome || '')))
    }),
    verify: ok.some((h) => (h.semantic || runtimeSemantics(h)).isVerify),
    commit: ok.some((h) => (h.semantic || runtimeSemantics(h)).isCommit),
    push: ok.some((h) => (h.semantic || runtimeSemantics(h)).isPush),
    pr: ok.some((h) => ['github_pr_create'].includes(String(h.tool || ''))) ||
      // filter(Boolean) — убираем undefined outcomes перед join
      /pull request|\/pull\//i.test(ok.map((h) => h.outcome).filter(Boolean).join('\n')) ||
      ok.some((h) => /gh\s+pr\s+create/i.test((h.semantic || (h.semantic || runtimeSemantics(h))).command)),
    deploy: ok.some((h) => (h.semantic || runtimeSemantics(h)).isDeploy),
    healthCheck: ok.some((h) => (h.semantic || runtimeSemantics(h)).isHealthCheck),
    logsCheck: ok.some((h) => (h.semantic || runtimeSemantics(h)).isLogsCheck),
    finalReport: true,
  }
  if (obligations.codeChange && !status.codeChange && recentToolHistory.some((h) => h?.ok && ['git_clone', 'zip_files'].includes(h.tool))) status.codeChange = true
  return status
}

export default runtimeSemantics
