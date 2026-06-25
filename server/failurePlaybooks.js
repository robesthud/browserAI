function text(v = '') { return String(v || '') }
function combined({ error = '', result = null, args = {} } = {}) {
  const r = typeof result === 'string' ? result : JSON.stringify(result || {}, null, 2)
  return `${error || ''}\n${r}\n${args?.command || ''}`
}

export function classifyToolFailure({ tool = '', error = '', result = null, args = {} } = {}) {
  const raw = combined({ error, result, args })
  const command = text(args?.command || '')
  const categories = []
  const add = (id, severity = 'medium', title = id) => { if (!categories.some((c) => c.id === id)) categories.push({ id, severity, title }) }

  if (/node_modules|vitest:\s*not found|jest:\s*not found|vite:\s*not found|sh:\s*\d+:\s*\w+:\s*not found|npm error missing script|cannot find package/i.test(raw)) add('missing_dependencies', 'high', 'Dependencies are not installed')
  if (/cannot find module|module not found|err_module_not_found|no module named|can't resolve/i.test(raw)) add('missing_module', 'medium', 'Missing module/import')
  if (/syntaxerror|unexpected token|unterminated|string literal|parse error|ts\d{4}/i.test(raw)) add('syntax_or_type_error', 'high', 'Syntax/type error')
  if (/test failed|failed tests|\bfailed\b.*\btest|expect\(|assertionerror|vitest|jest|pytest/i.test(raw) || /npm\s+test|vitest|jest|pytest/i.test(command)) add('test_failure', 'high', 'Test failure')
  if (/npm run build|vite build|next build|build failed|failed to compile|rollup|webpack|vite/i.test(raw) || /\b(build|compile)\b/i.test(command)) add('build_failure', 'high', 'Build failure')
  if (/eslint|prettier|lint/i.test(raw) || /\blint\b/i.test(command)) add('lint_failure', 'medium', 'Lint/format failure')
  if (/fatal:|git@github|could not read from remote|permission denied \(publickey\)|authentication failed|unable to access|rejected|non-fast-forward/i.test(raw)) add('git_failure', 'high', 'Git failure')
  if (/401|403|unauthorized|forbidden|invalid token|bad credentials|permission denied/i.test(raw)) add('credentials_or_permissions', 'high', 'Credentials/permissions')
  if (/docker|container|compose|health|connection refused|502|503|504|unhealthy|exited \(|restart/i.test(raw) || /docker|curl .*health|deploy/i.test(command)) add('deploy_or_runtime_failure', 'high', 'Deploy/runtime failure')
  if (/EACCES|permission denied|exit.*243|failed to build due to|railway.*error|railway up/i.test(raw) && /railway|vercel|netlify|fly\.io|render|digitalocean/i.test(raw)) add('platform_cli_failure', 'high', 'Platform CLI failed — use API instead')
  if (/git.*push.*failed|rejected.*remote|fatal.*push|authentication failed.*push|could not read from remote/i.test(raw)) add('git_push_failure', 'high', 'Git push failed')
  if (/timeout|timed out|killed after|exitCode":\s*124|\[killed/i.test(raw)) add('timeout', 'medium', 'Timeout/long command')
  if (/enoent|no such file|not found/i.test(raw)) add('path_not_found', 'medium', 'Path not found')
  if (!categories.length) add('generic_failure', 'medium', 'Generic tool failure')

  return {
    schema: 'browserai.failure_classification.v2',
    tool,
    command,
    primary: categories[0],
    categories,
    rawPreview: raw.slice(0, 4000),
  }
}

export function buildFailurePlaybook(classification = {}) {
  const ids = new Set((classification.categories || []).map((c) => c.id))
  const steps = []
  const add = (tool, args, why) => steps.push({ tool, args, why })

  if (ids.has('path_not_found')) {
    add('list_files', { path: '' }, 'Recover exact path/casing from the real workspace tree')
    add('search_files', { query: classification.command?.split(/\s+/).slice(-1)[0] || '' }, 'Search likely filename/symbol if parent path is unknown')
  }
  if (ids.has('syntax_or_type_error')) {
    add('read_file', { path: '<file from error>' }, 'Open the file and line mentioned by the syntax/type error')
    add('verify_code', { path: '<edited file>' }, 'Run a focused syntax check after the fix')
  }
  if (ids.has('missing_dependencies')) {
    add('project_profile', {}, 'Find the project root and package manager before installing dependencies')
    add('shell_session_run', { command: 'npm ci --include=dev', timeout_sec: 300 }, 'Install project dependencies automatically inside the sandbox/workspace')
    add('verify_task', { task_type: 'coding_change' }, 'Rerun verification after dependencies are installed')
  }
  if (ids.has('missing_module')) {
    add('search_files', { query: 'import require package.json' }, 'Find the import and package metadata')
    add('read_file', { path: 'package.json' }, 'Check whether the dependency exists or the import is wrong')
    add('shell_session_run', { command: 'npm ls <package> || true', timeout_sec: 120 }, 'Verify dependency presence before installing or changing import')
  }
  if (ids.has('test_failure')) {
    add('bash', { command: 'npm test -- --runInBand', timeout_sec: 120 }, 'Re-run/focus tests to get deterministic output if needed')
    add('search_files', { query: '<failing test or symbol>' }, 'Find the failing test/source pair')
    add('verify_task', { task_type: 'coding_change' }, 'Run the project verification plan after the fix')
  }
  if (ids.has('build_failure') || ids.has('lint_failure')) {
    add('project_profile', {}, 'Identify stack/scripts before choosing a focused build/lint command')
    add('search_files', { query: '<error symbol/path>' }, 'Locate the source of the compiler/linter error')
    add('bash', { command: 'npm run build', timeout_sec: 180 }, 'Re-run build after focused fixes')
  }
  if (ids.has('git_failure')) {
    add('bash', { command: 'git status --short && git remote -v && git branch --show-current', timeout_sec: 30 }, 'Inspect repo/branch/remote before retrying git')
    add('secret_scan', {}, 'Ensure no secrets are staged before any retry')
  }
  if (ids.has('deploy_or_runtime_failure')) {
    add('bash', { command: 'curl -fsS http://127.0.0.1/api/health || true', timeout_sec: 30 }, 'Check local health endpoint')
    add('docker_ps', {}, 'Inspect container health/status')
    add('docker_logs', { container: 'browserai', tail: 120 }, 'Read recent app logs for root cause')
  }
  if (ids.has('timeout')) {
    add('shell_background_start', { command: classification.command || '<long command>' }, 'Move long-running command to background and poll logs instead of blocking')
    add('shell_background_read', { task_id: '<task id>' }, 'Read background command output')
  }
  if (ids.has('platform_cli_failure')) {
    add('bash', { command: 'echo "Using API instead of CLI"' }, 'Platform CLI failed — switch to API approach')
    add('bash', { command: 'git status --short && git remote -v' }, 'Check git state before pushing to GitHub')
    add('bash', { command: 'git remote set-url origin https://TOKEN@github.com/USER/REPO.git && git push origin main' }, 'Push to GitHub with HTTPS token — replace TOKEN/USER/REPO')
    add('bash', { command: 'curl -s -X POST https://backboard.railway.app/graphql/v2 -H "Authorization: Bearer RAILWAY_TOKEN" -H "Content-Type: application/json" -d \'{"query":"{ me { workspaces { id name } } "}\'' }, 'Connect platform via API after GitHub push — see AGENTS.md for full Railway API sequence')
  }
  if (ids.has('git_push_failure')) {
    add('bash', { command: 'git remote -v && git status --short' }, 'Check current remote and branch state')
    add('bash', { command: 'git remote set-url origin https://TOKEN@github.com/USER/REPO.git' }, 'Switch to HTTPS with token — replace TOKEN/USER/REPO with real values from user')
    add('bash', { command: 'git push -f origin main 2>&1' }, 'Retry push with token-based HTTPS remote')
  }
  if (ids.has('credentials_or_permissions')) {
    add('ask_user', { question: 'Нужен актуальный доступ/подтверждение для продолжения. Обновить credentials или пропустить этот шаг?', options: ['Обновить доступ', 'Пропустить'] }, 'Credentials/permissions cannot be safely guessed')
  }
  if (!steps.length) add('bash', { command: 'pwd && ls -la', timeout_sec: 30 }, 'Regain workspace context before retrying')

  return {
    schema: 'browserai.failure_playbook.v1',
    classification,
    summary: `Failure playbook: ${classification.primary?.title || 'Generic failure'}`,
    steps: steps.slice(0, 8),
    instruction: renderFailurePlaybookInstruction({ classification, steps }),
  }
}

export function renderFailurePlaybookInstruction({ classification = {}, steps = [] } = {}) {
  return [
    '[failure_playbook]',
    `Primary failure: ${classification.primary?.title || 'Generic failure'} (${classification.primary?.id || 'generic'}).`,
    'Use the real stdout/stderr. Do not guess. Take the next safe diagnostic/fix step, then rerun the relevant verification.',
    'Recommended next steps:',
    ...steps.slice(0, 8).map((s, i) => `${i + 1}. ${s.tool} ${JSON.stringify(s.args)} — ${s.why}`),
    'If credentials/approval are required, ask_user. If production risk is involved, respect approval/policy gates.',
    '[/failure_playbook]',
  ].join('\n')
}

export function buildToolStrategyDirective(agentContext = {}) {
  const type = agentContext?.task?.type || 'general_agent_task'
  const complexity = agentContext?.task?.complexity || 'medium'
  if (complexity === 'low') return ''
  return [
    '[tool_strategy]',
    `Task type: ${type}.`,
    'Prefer the smallest reliable tool that gives evidence.',
    '- Start with project_profile/read_project_rules/list_files/search_files before broad file reads.',
    '- Use shell_session_run for multi-step terminal work; use bash for short stateless commands.',
    '- After edits, run focused checks first when possible, then broader verify_task/npm test/build if appropriate.',
    '- Before git commit/push/deploy: git status/diff + secret_scan + verification evidence.',
    '- For failures: classify stdout/stderr, inspect the referenced file/symbol, fix, and rerun the failing command.',
    '- If tests/build fail because dependencies are missing, install them yourself with shell_session_run (npm ci/install) when allowed; do not tell the user to run it manually.',
    '- For deploy/ops: health + docker ps/logs are mandatory evidence after changes.',
    '[/tool_strategy]',
  ].join('\n')
}

export default { classifyToolFailure, buildFailurePlaybook, renderFailurePlaybookInstruction, buildToolStrategyDirective }
