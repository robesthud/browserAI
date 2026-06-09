import { useState } from 'react'
import { highlight, detectLangFromPath } from '../lib/syntaxHighlight.js'

const VERBS = {
  list_files:      { action: 'Смотрю файлы', icon: '📂' },
  find_projects:   { action: 'Ищу проекты', icon: '🗂' },
  read_file:       { action: 'Читаю файл', icon: '📄' },
  write_file:      { action: 'Записываю файл', icon: '✏️' },
  edit_file:       { action: 'Изменяю файл', icon: '🔧' },
  delete_file:     { action: 'Удаляю', icon: '🗑️' },
  file_history:    { action: 'Смотрю историю файла', icon: '🕓' },
  restore_file:    { action: 'Восстанавливаю файл', icon: '↩️' },
  search_files:    { action: 'Ищу по файлам', icon: '🔎' },
  download_url:    { action: 'Скачиваю', icon: '📥' },
  git_status:      { action: 'Проверяю git status', icon: '⎇' },
  git_diff:        { action: 'Смотрю git diff', icon: '⎇' },
  git_commit:      { action: 'Создаю git commit', icon: '⎇' },
  git_push:        { action: 'Пушу изменения', icon: '⎇' },
  git_pull:        { action: 'Обновляю репозиторий', icon: '⎇' },
  git_clone:       { action: 'Клонирую репозиторий', icon: '⎇' },
  github_pr_create:{ action: 'Создаю GitHub PR', icon: '🔀' },
  web_search:      { action: 'Ищу в интернете', icon: '🌐' },
  web_fetch:       { action: 'Открываю страницу', icon: '📥' },
  fetch_page:      { action: 'Открываю страницу', icon: '📥' },
  generate_image:  { action: 'Генерирую изображение', icon: '🎨' },
  bash:            { action: 'Запускаю команду', icon: '>_' },
  bash_bg:         { action: 'Запускаю фоновую задачу', icon: '↻' },
  bash_logs:       { action: 'Читаю логи задачи', icon: '📜' },
  bash_stop:       { action: 'Останавливаю задачу', icon: '◼' },
  bash_list:       { action: 'Смотрю фоновые задачи', icon: '☰' },
  bash_reset:      { action: 'Сбрасываю shell-сессию', icon: '↺' },
  verify_code:     { action: 'Проверяю код', icon: '✅' },
  run_tests:       { action: 'Запускаю тесты', icon: '🧪' },
  browser_open:    { action: 'Открываю страницу', icon: '🌐' },
  browser_screenshot:{ action: 'Делаю скриншот', icon: '📸' },
  browser_click:   { action: 'Кликаю в браузере', icon: '🖱' },
  browser_type:    { action: 'Ввожу текст', icon: '⌨' },
  browser_close:   { action: 'Закрываю страницу', icon: '✖' },
  analyze_image:   { action: 'Анализирую изображение', icon: '👁' },
  ops_list_services:{ action:'Смотрю сервисы', icon: '🛠' },
  ops_run_action:  { action: 'Выполняю ops-действие', icon: '🛠' },
  plan_set:        { action: 'Составляю план', icon: '📋' },
  plan_check:      { action: 'Отмечаю шаг плана', icon: '☑️' },
  use_subagents:   { action: 'Запускаю sub-agents', icon: '🛰' },
  remember_fact:   { action: 'Запоминаю факт', icon: '🧠' },
  forget_fact:     { action: 'Удаляю факт', icon: '🧠' },
  recall_facts:    { action: 'Вспоминаю факты', icon: '🧠' },
  kb_add:          { action: 'Добавляю в базу знаний', icon: '📚' },
  kb_search:       { action: 'Ищу в базе знаний', icon: '📚' },
  kb_list:         { action: 'Смотрю базу знаний', icon: '📚' },
  kb_delete:       { action: 'Удаляю из базы знаний', icon: '📚' },
  replace_across_files: { action: 'Массово заменяю в файлах', icon: '🔄' },
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
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'file_history':
    case 'restore_file': return args.path || args.file || ''
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
    case 'bash':        return args.command || ''
    case 'verify_code': return args.path || args.npm_script || args.node_check || args.command || 'проверка'
    case 'run_tests':   return args.path || 'tests'
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
  if (name === 'bash' && (result.stdout || result.stderr)) {
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
    case 'bash': return `Команда завершилась с кодом ${result.exitCode ?? '—'}`
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
  onRetry,
}) {
  const [open, setOpen] = useState(false)
  const isDev = devtoolsEnabled()
  const mcpMatch = typeof name === 'string' && name.startsWith('mcp__')
    ? name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
    : null
  const spec = mcpMatch
    ? { action: `MCP: ${mcpMatch[1]}/${mcpMatch[2]}`, icon: '🔌' }
    : (VERBS[name] || { action: name || 'Выполняю инструмент', icon: '⚙️' })

  let mark, markCls
  if (status === 'done') {
    if (ok) { mark = '✓'; markCls = 'text-emerald-300' }
    else    { mark = '✗'; markCls = 'text-rose-300' }
  } else if (status === 'queued') {
    mark = '◌'; markCls = 'text-violet-300'
  } else {
    mark = '•'; markCls = 'text-amber-300 animate-pulse'
  }

  const duration = startedAt && finishedAt ? fmtDuration(finishedAt - startedAt) : ''
  const argSummary = summarizeArgs(name, args)
  const rawBody = status === 'done'
    ? (ok ? formatRawResult(name, result) : (error || 'unknown error'))
    : ''
  const summary = status === 'done' ? resultSummary(name, result, ok, error) : ''
  const deltaPill = status === 'done' && ok && (name === 'edit_file' || name === 'write_file')
    ? editDeltaPill(result)
    : ''

  const screenshotPath = status === 'done' && ok && result && typeof result === 'object'
    ? (result.screenshotPath || result.screenshot || (typeof result.path === 'string' && /\.(png|jpg|jpeg|webp)$/i.test(result.path) ? result.path : ''))
    : ''
  const inlineDataUrl = status === 'done' && ok && result && typeof result === 'object'
    ? (typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/') ? result.dataUrl : '')
    : ''

  let highlightedHtml = null
  if (status === 'done' && ok && rawBody && isDev) {
    let lang = ''
    if (name === 'write_file' || name === 'edit_file') lang = detectLangFromPath(args?.path || '')
    else if (name === 'read_file') lang = detectLangFromPath(args?.path || '')
    else if (name === 'bash') lang = 'sh'
    if (lang) highlightedHtml = highlight(rawBody, lang)
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-white/10 bg-graphite-800/60 text-[12px] md:text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/5 md:gap-2 md:px-3 md:py-2"
      >
        <span className="font-mono text-[11px] text-cream-faint shrink-0">{spec.icon}</span>
        <span className="min-w-0 shrink truncate font-medium text-cream" title={spec.action}>{spec.action}</span>
        {argSummary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream-faint md:text-[12px]" title={argSummary}>
            {argSummary}
          </span>
        )}
        {!argSummary && <span className="flex-1" />}
        {deltaPill && <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">{deltaPill}</span>}
        <span className={`shrink-0 text-[13px] leading-none ${markCls}`}>{mark}</span>
        {duration && <span className="shrink-0 font-mono text-[10px] text-cream-faint md:text-[11px]">{duration}</span>}
        <svg width="10" height="10" viewBox="0 0 12 12" className={`shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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

      {open && (
        <div className="border-t border-white/10 px-2.5 py-2 md:px-3">
          {summary && (
            <div className={`mb-2 break-words rounded-lg px-2.5 py-1.5 text-[12px] ${ok === false ? 'bg-red-500/10 text-red-200' : 'bg-black/20 text-cream-soft'}`}>
              {summary}
              {ok === false && !isDev ? <div className="mt-1 text-[11px] text-red-200/80">Агент может попробовать другой способ или запросить уточнение.</div> : null}

              {ok === false && onRetry && (
                <button
                  onClick={() => onRetry({ name, args })}
                  className="mt-2 inline-flex items-center gap-1 rounded bg-red-500/20 px-3 py-1 text-[12px] font-medium text-red-200 hover:bg-red-500/30 active:bg-red-500/40"
                >
                  ↻ Retry
                </button>
              )}
            </div>
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
            // eslint-disable-next-line jsx-a11y/img-redundant-alt
            <img
              src={`/api/workspace/download?path=${encodeURIComponent(screenshotPath)}&inline=1`}
              alt={`screenshot: ${screenshotPath}`}
              loading="lazy"
              className="mb-2 w-full rounded border border-white/5 bg-graphite-950 object-contain"
              style={{ maxHeight: 360 }}
            />
          )}
          {inlineDataUrl && (
            // eslint-disable-next-line jsx-a11y/img-redundant-alt
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

          {status === 'done' && isDev ? (
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
