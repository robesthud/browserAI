import { useEffect, useMemo, useState } from 'react'
import { highlight, detectLangFromPath } from '../lib/syntaxHighlight.js'

const VERBS = {
  list_files:      { action: 'list', icon: '📂' },
  find_projects:   { action: 'find_projects', icon: '🗂' },
  read_file:       { action: 'read', icon: '📄' },
  write_file:      { action: 'write', icon: '✏️' },
  edit_file:       { action: 'edit', icon: '🔧' },
  delete_file:     { action: 'delete', icon: '🗑️' },
  file_history:    { action: 'history', icon: '🕓' },
  restore_file:    { action: 'restore', icon: '↩️' },
  search_files:    { action: 'search', icon: '🔎' },
  download_url:    { action: 'download', icon: '📥' },
  git_status:      { action: 'git status', icon: '⎇' },
  git_diff:        { action: 'git diff', icon: '⎇' },
  git_commit:      { action: 'git commit', icon: '⎇' },
  git_push:        { action: 'git push', icon: '⎇' },
  git_pull:        { action: 'git pull', icon: '⎇' },
  git_clone:       { action: 'git clone', icon: '⎇' },
  zip_files:       { action: 'zip', icon: '🗜️' },
  github_pr_create:{ action: 'pr_create', icon: '🔀' },
  web_search:      { action: 'web_search', icon: '🌐' },
  web_fetch:       { action: 'web_fetch', icon: '📥' },
  fetch_page:      { action: 'web_fetch', icon: '📥' },
  generate_image:  { action: 'image', icon: '🎨' },
  bash:            { action: 'bash', icon: '>_' },
  shell_session_run: { action: 'bash', icon: '>_' },
  shell_session_reset: { action: 'reset', icon: '↺' },
  shell_background_start: { action: 'bash_bg', icon: '↻' },
  shell_background_read: { action: 'bash_read', icon: '📜' },
  shell_background_stop: { action: 'bash_stop', icon: '◼' },
  shell_background_list: { action: 'bash_list', icon: '☰' },
  bash_bg:         { action: 'bash_bg', icon: '↻' },
  bash_logs:       { action: 'bash_logs', icon: '📜' },
  bash_stop:       { action: 'bash_stop', icon: '◼' },
  bash_list:       { action: 'bash_list', icon: '☰' },
  bash_reset:      { action: 'bash_reset', icon: '↺' },
  verify_code:     { action: 'verify', icon: '✅' },
  run_tests:       { action: 'tests', icon: '🧪' },
  browser_open:    { action: 'browser', icon: '🌐' },
  browser_screenshot:{ action: 'screenshot', icon: '📸' },
  browser_click:   { action: 'click', icon: '🖱' },
  browser_type:    { action: 'type', icon: '⌨' },
  browser_close:   { action: 'close', icon: '✖' },
  analyze_image:   { action: 'analyze', icon: '👁' },
  ops_list_services:{ action:'ops_services', icon: '🛠' },
  ops_run_action:  { action: 'ops', icon: '🛠' },
  plan_set:        { action: 'plan_set', icon: '📋' },
  plan_check:      { action: 'plan_check', icon: '☑️' },
  use_subagents:   { action: 'subagents', icon: '🛰' },
  remember_fact:   { action: 'remember', icon: '🧠' },
  forget_fact:     { action: 'forget', icon: '🧠' },
  recall_facts:    { action: 'recall', icon: '🧠' },
  kb_add:          { action: 'kb_add', icon: '📚' },
  kb_search:       { action: 'kb_search', icon: '📚' },
  kb_list:         { action: 'kb_list', icon: '📚' },
  kb_delete:       { action: 'kb_delete', icon: '📚' },
  replace_across_files: { action: 'replace', icon: '🔄' },
}

const CONSOLIDATED_ACTIONS = {
  file: {
    list: 'list_files',
    read: 'read_file',
    write: 'write_file',
    edit: 'edit_file',
    delete: 'delete_file',
    search: 'search_files',
    zip: 'zip_files',
    create_folder: 'create_folder',
    rename: 'rename_item',
    snapshot_create: 'workspace_snapshot_create',
    snapshot_list: 'workspace_snapshot_list',
    snapshot_restore: 'workspace_snapshot_restore',
  },
  shell: {
    run: 'bash',
    background_start: 'shell_background_start',
    background_read: 'shell_background_read',
    background_stop: 'shell_background_stop',
    background_list: 'shell_background_list',
    reset: 'shell_session_reset',
  },
  verify: {
    code: 'verify_code',
    task: 'verify_task',
    npm_test: 'run_tests',
    npm_install: 'npm_install',
    secret_scan: 'secret_scan',
  },
  plan: { set: 'plan_set', check: 'plan_check' },
  browser: {
    open: 'browser_open',
    screenshot: 'browser_screenshot',
    click: 'browser_click',
    type: 'browser_type',
    close: 'browser_close',
  },
  web: { search: 'web_search', fetch: 'web_fetch' },
  git: { status: 'git_status', clone: 'git_clone', commit: 'git_commit' },
}

function effectiveToolName(name = '', args = {}) {
  const action = String(args?.action || '').trim()
  return CONSOLIDATED_ACTIONS[name]?.[action] || name
}

function displaySpec(name = '', args = {}) {
  const effective = effectiveToolName(name, args)
  if (name === 'file' && args?.action) {
    const spec = VERBS[effective] || { action: String(args.action), icon: '📄' }
    return { ...spec, action: spec.action || String(args.action) }
  }
  if (name === 'shell' && args?.action) return VERBS[effective] || { action: args.action === 'run' ? 'bash' : `shell ${args.action}`, icon: '>_' }
  if (name === 'verify' && args?.action) return VERBS[effective] || { action: args.action === 'code' ? 'verify' : `verify ${args.action}`, icon: '✅' }
  if (name === 'plan' && args?.action) return VERBS[effective] || { action: 'plan', icon: '📋' }
  if (name === 'browser' && args?.action) return VERBS[effective] || { action: `browser ${args.action}`, icon: '🌐' }
  if (name === 'web' && args?.action) return VERBS[effective] || { action: `web ${args.action}`, icon: '🌐' }
  if (name === 'git' && args?.action) return VERBS[effective] || { action: `git ${args.action}`, icon: '⎇' }
  return VERBS[effective] || VERBS[name] || { action: name || 'tool', icon: '⚙️' }
}

function compactRaw(value = '', max = 700) {
  const s = String(value || '').trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}\n… [ещё ${s.length - max} символов]` : s
}

function devtoolsEnabled() {
  try { return localStorage.getItem('browserai.devtools') === '1' }
  catch { return false }
}

function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.round(ms / 1000)}s`
}

function summarizeArgs(name, args = {}) {
  const effective = effectiveToolName(name, args)
  if (name !== effective) return summarizeArgs(effective, args)
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'file_history':
    case 'restore_file':
    case 'create_folder':
    case 'rename_item':
    case 'workspace_snapshot_restore': return args.path || args.file || args.source_path || args.root || ''
    case 'list_files':
    case 'find_projects': return args.path || '/'
    case 'search_files': return `“${args.query || ''}”`
    case 'web_search':  return `“${args.query || ''}”`
    case 'web_fetch':
    case 'fetch_page':
    case 'download_url': return args.url || ''
    case 'browser_open': return args.url || ''
    case 'browser_screenshot':
    case 'browser_close': return args.sessionId || args.session_id || ''
    case 'browser_click': return args.selector || args.text || ''
    case 'browser_type':  return args.selector || ''
    case 'bash':
    case 'shell_session_run':
    case 'shell_background_start': return args.command || ''
    case 'shell_background_read':
    case 'shell_background_stop': return args.task_id || args.taskId || ''
    case 'verify_code': return args.path || args.npm_script || args.node_check || args.command || 'проверка'
    case 'run_tests':   return args.path || args.command || 'tests'
    case 'npm_install': return args.package || args.path || 'npm install'
    case 'secret_scan': return args.root || args.path || '/'
    case 'verify_task': return 'task'
    case 'git_commit':  return args.message || ''
    case 'git_push':    return args.branch || 'текущая ветка'
    case 'github_pr_create': return args.title || ''
    case 'plan_set':    return args.title || 'план'
    case 'plan_check':  return args.indices || ''
    case 'ops_run_action': return `${args.service || ''}.${args.action || ''}`
    default: return ''
  }
}

function editDeltaPill(result) {
  if (!result || typeof result !== 'object') return ''
  const o = Number(result.oldLines)
  const n = Number(result.newLines)
  if (!Number.isFinite(o) || !Number.isFinite(n)) return ''
  const d = n - o
  if (d === 0) return '±0 lines'
  return d > 0 ? `+${d} lines` : `${d} lines`
}

function formatRawResult(name, result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (name === 'read_file' && result.content) return result.content
  if (['bash', 'shell_session_run', 'shell_background_read'].includes(name) && (result.stdout || result.stderr)) {
    let out = ''
    if (result.stdout) out += result.stdout
    if (result.stderr) out += (out ? '\n— stderr —\n' : '') + result.stderr
    if (result.exitCode != null) out += `\n[exit ${result.exitCode}]`
    return out
  }
  if (name === 'web_search' && Array.isArray(result.results)) {
    return result.results.map((r, i) =>
      `${i + 1}. ${r.title || r.url}\n   ${r.url}\n   ${(r.snippet || '').slice(0, 200)}`,
    ).join('\n\n')
  }
  try { return JSON.stringify(result, null, 2) } catch { return String(result) }
}

function friendlyToolError(name, error = '') {
  const raw = String(error || '')
  const lower = raw.toLowerCase()
  if (/path traversal|invalid path|null bytes|absolute paths/i.test(raw)) return 'Путь заблокирован политикой безопасности workspace'
  if (/not found|no such file|enoent|файл .*не найден/i.test(lower)) {
    if (['read_file', 'edit_file', 'delete_file', 'file_history', 'restore_file'].includes(name)) return 'Файл не найден'
    return 'Ресурс не найден'
  }
  if (/permission|eacces|access denied|forbidden|403/i.test(lower)) return 'Недостаточно прав для выполнения действия'
  if (/timeout|timed out|killed after/i.test(lower)) return 'Действие заняло слишком много времени и было остановлено'
  if (/cancelled|canceled/i.test(lower)) return 'Действие отменено'
  if (/old_text not found|not found in/i.test(lower) && name === 'edit_file') return 'Текст для замены не найден в файле'
  if (/syntax|parse|unexpected token|unclosed|unbalanced/i.test(lower)) return 'Обнаружена ошибка синтаксиса'
  if (/exit code|exit \d+|command failed/i.test(lower) || name === 'bash') return 'Команда завершилась с ошибкой'
  if (/network|fetch|enotfound|econnrefused|econnreset/i.test(lower)) return 'Сетевая операция не удалась'
  if (/rate limit|quota|429/i.test(lower)) return 'Провайдер ограничил запросы или квоту'
  if (/unauthorized|invalid api key|401/i.test(lower)) return 'Проблема авторизации или ключа'
  return 'Действие завершилось с ошибкой'
}

function resultSummary(name, result, ok, error) {
  if (ok === false) return friendlyToolError(name, error)
  if (!result) return ''
  if (typeof result === 'string') return result.length ? shortLine(result, 220) : ''
  switch (name) {
    case 'read_file':
      return result.kind === 'image' ? 'Изображение загружено' : `Прочитано ${result.content?.length || result.text?.length || result.size || 0} символов`
    case 'write_file':
      return `Файл записан${result.bytes ? ` · ${result.bytes} байт` : ''}`
    case 'edit_file':
      return `Изменено: ${result.replaced ?? result.edits?.length ?? 1} правк.${result.deltaBytes != null ? ` · Δ ${result.deltaBytes} байт` : ''}`
    case 'delete_file': return `Удалено: ${result.deleted || result.path || ''}`
    case 'list_files': return `Найдено элементов: ${result.children?.length ?? result.files?.length ?? result.count ?? '—'}`
    case 'search_files': return `Найдено совпадений: ${result.count ?? result.matches?.length ?? 0}`
    case 'web_search': return `Найдено результатов: ${result.results?.length ?? 0}`
    case 'web_fetch':
    case 'fetch_page': return result.title ? `Загружено: ${result.title}` : 'Страница загружена'
    case 'download_url': return result.extracted ? `Архив распакован · файлов: ${result.files?.length || 0}` : `Скачано: ${result.filename || result.files?.[0] || ''}`
    case 'zip_files': return `Архив готов: ${result.file_path || result.path || 'workspace.zip'}${result.bytes ? ` · ${Math.round(result.bytes / 1024)} KB` : ''}`
    case 'git_clone': return `Скачано в папку: ${result.path || ''}`
    case 'bash': return `Команда завершилась с кодом ${result.exitCode ?? '—'}`
    case 'shell_session_run': return `Shell-сессия завершила команду с кодом ${result.exitCode ?? '—'}${result.durationMs ? ` · ${Math.round(result.durationMs / 1000)}с` : ''}`
    case 'shell_background_start': return `Фоновая команда запущена: ${result.taskId || ''}`
    case 'shell_background_read': return result.running ? 'Фоновая команда ещё выполняется' : `Фоновая команда завершилась с кодом ${result.exitCode ?? '—'}`
    case 'shell_background_stop': return result.stopped ? 'Фоновая команда остановлена' : 'Фоновая команда не найдена'
    case 'shell_background_list': return `Фоновых команд: ${result.tasks?.length ?? 0}`
    case 'verify_code': return result.allPassed ? 'Проверка прошла' : 'Проверка нашла проблемы'
    case 'run_tests': return result.passed ? 'Тесты прошли' : 'Тесты завершились с ошибками'
    case 'git_status':
    case 'git_diff':
    case 'git_commit':
    case 'git_push':
    case 'git_pull': return result.exitCode === 0 ? 'Git-команда выполнена' : `Git завершился с кодом ${result.exitCode}`
    case 'browser_open': return result.title ? `Открыта страница: ${result.title}` : 'Страница открыта'
    case 'analyze_image': return result.answer ? shortLine(result.answer, 220) : 'Изображение проанализировано'
    default: return result.message || result.note || result.path || ''
  }
}

function shortLine(value = '', max = 140) {
  const s = String(value || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

function summarizeFileChanges(fileChanges = [], fileChangeSummary = null, result = null) {
  const direct = Array.isArray(fileChanges) ? fileChanges : []
  const fromResult = result?.changedFiles && typeof result.changedFiles === 'object'
    ? [
        ...(result.changedFiles.created || []).map((p) => ({ type: 'file_created', path: p })),
        ...(result.changedFiles.modified || []).map((p) => ({ type: 'file_modified', path: p })),
        ...(result.changedFiles.deleted || []).map((p) => ({ type: 'file_deleted', path: p })),
      ]
    : []
  const events = direct.length ? direct : fromResult
  const paths = [...new Set(events.map((e) => e?.path).filter(Boolean))]
  const diffs = events.map((e) => e?.meta?.diff).filter((d) => d?.patch)
  const count = Number(fileChangeSummary?.count || events.length || paths.length || 0)
  return { events, paths, diffs, count }
}

function hasExpandableDetails({ rawBody, summary, stream, screenshotPath, inlineDataUrl, diagnostic, args, isDev, status, fileChangeCount = 0 }) {
  if (status !== 'done') return Boolean(stream)
  return Boolean(rawBody || stream || screenshotPath || inlineDataUrl || diagnostic || fileChangeCount || (isDev && args && Object.keys(args).length > 0) || summary)
}

export default function AgentToolBlock({
  name,
  args,
  status = 'running',
  ok,
  result,
  error,
  step,
  startedAt,
  finishedAt,
  stream,
  diagnostic,
  fileChanges = [],
  fileChangeSummary = null,
  onRetry,
  recovered = false,
}) {
  const [open, setOpen] = useState(false)
  const isDev = devtoolsEnabled()
  const mcpMatch = typeof name === 'string' && name.startsWith('mcp__')
    ? name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
    : null
  const effective = effectiveToolName(name, args)
  const spec = mcpMatch
    ? { action: `MCP: ${mcpMatch[1]}/${mcpMatch[2]}`, icon: '🔌' }
    : displaySpec(name, args)
  const panelId = `tool-${String(step ?? 'x')}-${String(name || 'tool').replace(/[^a-z0-9_-]/gi, '-')}`

  let mark, markCls
  if (status === 'done') {
    if (ok) { mark = '✓'; markCls = 'text-emerald-300' }
    else if (recovered) { mark = '↻'; markCls = 'text-amber-300' }
    else    { mark = '✗'; markCls = 'text-rose-300' }
  } else if (status === 'queued') {
    mark = '◌'; markCls = 'text-violet-300'
  } else {
    mark = '•'; markCls = 'text-amber-300 animate-pulse'
  }

  const duration = startedAt && finishedAt ? fmtDuration(finishedAt - startedAt) : ''
  const argSummary = summarizeArgs(name, args)
  const rawBody = status === 'done'
    ? (ok ? formatRawResult(effective, result) : (error || 'unknown error'))
    : ''
  const summary = status === 'done' ? (recovered && ok === false ? 'Не сработало, агент продолжил другим способом' : resultSummary(effective, result, ok, error, args)) : ''
  const compactBody = compactRaw(rawBody)
  const fileChangeInfo = summarizeFileChanges(fileChanges, fileChangeSummary, result)
  const deltaPill = status === 'done' && ok && (effective === 'edit_file' || effective === 'write_file')
    ? editDeltaPill(result)
    : ''

  const screenshotPath = status === 'done' && ok && result && typeof result === 'object'
    ? (result.screenshotPath || result.screenshot || (typeof result.path === 'string' && /\.(png|jpg|jpeg|webp)$/i.test(result.path) ? result.path : ''))
    : ''
  const inlineDataUrl = status === 'done' && ok && result && typeof result === 'object'
    ? (typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/') ? result.dataUrl : '')
    : ''

  const downloadUrl = status === 'done' && ok && result && typeof result === 'object'
    ? (result.download_url || result.downloadUrl || '')
    : ''
  const downloadName = status === 'done' && ok && result && typeof result === 'object'
    ? (result.file_path || result.path || result.filename || 'download')
    : ''

  const userVisibleOutput = ['bash', 'shell_session_run', 'shell_background_read', 'verify_code', 'verify_task', 'npm_test', 'run_tests'].includes(effective)
  let highlightedHtml = null
  if (status === 'done' && ok && rawBody && (isDev || userVisibleOutput)) {
    let lang = ''
    if (effective === 'write_file' || effective === 'edit_file') lang = detectLangFromPath(args?.path || '')
    else if (effective === 'read_file') lang = detectLangFromPath(args?.path || '')
    else if (['bash', 'shell_session_run', 'shell_background_read'].includes(effective)) lang = 'sh'
    if (lang) highlightedHtml = highlight(rawBody, lang)
  }

  const expandable = hasExpandableDetails({ rawBody, summary, stream, screenshotPath, inlineDataUrl, diagnostic, args, isDev, status, fileChangeCount: fileChangeInfo.count })
  const shouldAutoOpen = status !== 'done' || (ok === false && !recovered)
  const rowSummary = useMemo(() => {
    if (status !== 'done') return stream ? shortLine(String(stream).split('\n').filter(Boolean).slice(-1)[0] || 'выполняется…', 80) : 'выполняется…'
    if (ok === false) return recovered ? 'восстановлено' : friendlyToolError(effective, error)
    return summary || compactRaw(rawBody, 100) || 'готово'
  }, [status, stream, ok, recovered, effective, error, summary, rawBody])

  useEffect(() => {
    if (shouldAutoOpen && expandable) setOpen(true)
    if (!shouldAutoOpen && status === 'done') setOpen(false)
  }, [shouldAutoOpen, expandable, status])

  return (
    <div className="my-1 overflow-hidden bg-transparent text-[11px] md:text-[12px]">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? panelId : undefined}
        className={`flex w-full items-center gap-1.5 py-1 text-left ${expandable ? 'hover:text-cream' : 'cursor-default'}`}
      >
        <span className={`shrink-0 font-mono text-[12px] leading-none ${status !== 'done' ? 'animate-pulse ' : ''}${markCls}`}>{mark}</span>
        <span className="min-w-0 shrink truncate font-mono text-[12px] font-medium text-cream-soft" title={spec.action}>{spec.action}</span>
        {argSummary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream-faint/85" title={argSummary}>
            {argSummary}
          </span>
        )}
        {!argSummary && <span className="flex-1" />}
        {rowSummary && <span className="hidden min-w-0 max-w-[34%] truncate text-[10px] text-cream-faint sm:inline" title={rowSummary}>{rowSummary}</span>}
        {fileChangeInfo.count > 0 && <span className="shrink-0 rounded bg-emerald-500/10 px-1 py-0.2 font-mono text-[9px] text-emerald-200">Δ {fileChangeInfo.count}</span>}
        {deltaPill && <span className="shrink-0 rounded bg-violet-500/10 px-1 py-0.2 font-mono text-[9px] text-violet-200">{deltaPill}</span>}
        {duration && <span className="shrink-0 font-mono text-[10px] text-cream-faint">· {duration}</span>}
        {expandable && (
          <svg width="8" height="8" viewBox="0 0 12 12" className={`shrink-0 opacity-35 transition-transform ${open ? 'rotate-180' : ''}`}>
            <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {status === 'running' && stream && !open && (
        <div className="border-t border-white/5 bg-graphite-900/70 px-2.5 py-1 font-mono text-[10px] leading-tight text-cream-faint md:text-[11px]">
          {(() => {
            const lines = String(stream).split('\n').filter(Boolean)
            const tail = lines.slice(-2).join(' · ')
            return tail.length > 220 ? '…' + tail.slice(-220) : tail
          })()}
          <span className="text-amber-300"> ▌</span>
        </div>
      )}

      {expandable && open && (
        <div id={panelId} className="border-t border-white/10 px-2.5 py-2 md:px-3">
          {summary && (
            <div className={`mb-2 break-words rounded-lg px-2.5 py-1.5 text-[12px] ${ok === false && !recovered ? 'bg-red-500/10 text-red-200' : recovered ? 'bg-amber-500/10 text-amber-100' : 'bg-black/20 text-cream-soft'}`}>
              {summary}
              {ok === false && !isDev && !recovered ? <div className="mt-1 text-[11px] text-red-200/80">Агент может попробовать другой способ или запросить уточнение.</div> : null}

              {ok === false && onRetry && (
                <button
                  type="button"
                  onClick={() => onRetry({ name, args })}
                  className="mt-2 inline-flex items-center gap-1 rounded bg-red-500/20 px-3 py-1 text-[12px] font-medium text-red-200 hover:bg-red-500/30 active:bg-red-500/40"
                >
                  ↻ Retry
                </button>
              )}
            </div>
          )}

          {fileChangeInfo.count > 0 && (
            <div className="mb-2 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-100">
              <div className="mb-1 font-medium">Изменения workspace: {fileChangeInfo.count}</div>
              <ul className="space-y-0.5 font-mono text-[10px] text-emerald-100/90">
                {fileChangeInfo.events.slice(0, 10).map((e, i) => (
                  <li key={`${e.path || i}-${i}`} className="truncate" title={`${e.type || 'file_changed'} ${e.path || ''}`}>
                    {(e.type || 'file_changed').replace(/^file_/, '')}: {e.path || ''}
                  </li>
                ))}
              </ul>
              {fileChangeInfo.events.length > 10 && <div className="mt-1 text-[10px] text-emerald-100/60">…ещё {fileChangeInfo.events.length - 10}</div>}
              {fileChangeInfo.diffs.length > 0 && (
                <details className="mt-2 rounded border border-white/10 bg-black/20">
                  <summary className="cursor-pointer px-2 py-1 text-[10px] text-emerald-100/80">diff preview</summary>
                  <pre className="thin-scroll max-h-60 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-[10px] leading-snug text-cream-soft">
                    {fileChangeInfo.diffs.slice(0, 3).map((d) => d.patch).join('\n\n')}
                  </pre>
                </details>
              )}
            </div>
          )}

          {downloadUrl && (
            <a
              href={downloadUrl}
              download
              className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-medium text-emerald-100 hover:bg-emerald-500/20"
            >
              ⬇ Скачать {String(downloadName).split('/').pop()}
            </a>
          )}

          {isDev && ok === false && error && (
            <details className="mb-1.5 text-[11px] text-cream-faint">
              <summary className="cursor-pointer">raw error</summary>
              <pre className="thin-scroll mt-1 max-h-32 overflow-auto rounded bg-graphite-900 p-2 font-mono text-[11px] text-rose-200">{String(error)}</pre>
            </details>
          )}

          {isDev && args && Object.keys(args).length > 0 && (
            <details className="mb-1.5 text-[11px] text-cream-faint" open={!rawBody}>
              <summary className="cursor-pointer">аргументы</summary>
              <pre className="thin-scroll mt-1 max-h-32 overflow-auto rounded bg-graphite-900 p-2 font-mono text-[11px] text-cream">{JSON.stringify(args, null, 2)}</pre>
            </details>
          )}

          {screenshotPath && (
            <img
              src={`/api/workspace/download?path=${encodeURIComponent(screenshotPath)}&inline=1`}
              alt={`screenshot: ${screenshotPath}`}
              loading="lazy"
              className="mb-2 w-full rounded border border-white/5 bg-graphite-950 object-contain"
              style={{ maxHeight: 360 }}
            />
          )}
          {inlineDataUrl && (
            <img
              src={inlineDataUrl}
              alt={`computer-sandbox screen at ${name}`}
              loading="lazy"
              className="mb-2 w-full rounded border border-violet-500/30 bg-graphite-950 object-contain"
              style={{ maxHeight: 480 }}
            />
          )}
          {diagnostic && (
            <div className="mb-2 break-words rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
              ⚠ После записи <code className="rounded bg-graphite-900/60 px-1 py-0.5 font-mono">{diagnostic.path}</code> синтаксис-чек выдал: {diagnostic.error}
            </div>
          )}

          {status === 'done' && !summary && !compactBody && argSummary ? (
            <div className="rounded bg-graphite-900/80 p-2 font-mono text-[11px] text-cream-soft">{argSummary}</div>
          ) : null}

          {status === 'done' && ok && compactBody && !(isDev || userVisibleOutput) ? (
            <pre className="thin-scroll max-h-40 overflow-auto whitespace-pre-wrap rounded bg-graphite-900/80 p-2 font-mono text-[11px] leading-snug text-cream-soft">
              {compactBody}
            </pre>
          ) : null}

          {status === 'done' && (isDev || userVisibleOutput) ? (
            highlightedHtml ? (
              <pre
                className={`thin-scroll max-h-72 overflow-auto whitespace-pre-wrap rounded bg-graphite-900 p-2 font-mono text-[11px] ${ok ? 'text-cream' : 'text-rose-200'}`}
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            ) : (
              <pre className={`thin-scroll max-h-72 overflow-auto whitespace-pre-wrap rounded bg-graphite-900 p-2 font-mono text-[11px] ${ok ? 'text-cream' : 'text-rose-200'}`}>
                {rawBody || (ok ? '(пустой результат)' : '(нет сообщения об ошибке)')}
              </pre>
            )
          ) : status !== 'done' ? (
            stream ? (
              <pre className="thin-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded bg-graphite-900 p-2 font-mono text-[11px] text-cream-faint">
                {stream}
                <span className="text-amber-300">▌</span>
              </pre>
            ) : (
              <div className="text-cream-faint">выполняется…</div>
            )
          ) : null}

          {isDev && step != null && <div className="mt-1 text-right text-[10px] text-cream-faint">шаг #{step}</div>}
        </div>
      )}
    </div>
  )
}
