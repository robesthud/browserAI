import { useState } from 'react'
import { highlight, detectLangFromPath } from '../lib/syntaxHighlight.js'

/**
 * Inline tool-call card — mobile-first compact layout that mirrors the
 * Arena top bar style: a single-row pill with verb + name + status +
 * duration + chevron. Expanding it reveals arguments and the result.
 *
 * Mobile gets the tighter visual, desktop just slightly larger.
 */

const VERBS = {
  list_files:   { verb: 'used',  noun: 'List Files', icon: '📂' },
  read_file:    { verb: 'used',  noun: 'Read File',  icon: '📄' },
  write_file:   { verb: 'Write', noun: '',           icon: '✏️' },
  edit_file:    { verb: 'Edit',  noun: '',           icon: '🔧' },
  delete_file:  { verb: 'used',  noun: 'Delete',     icon: '🗑️' },
  search_files: { verb: 'used',  noun: 'Search',     icon: '🔎' },
  web_search:   { verb: 'used',  noun: 'Web Search', icon: '🌐' },
  web_fetch:    { verb: 'used',  noun: 'Fetch',      icon: '📥' },
  bash:         { verb: 'used',  noun: 'Bash',       icon: '>_' },
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
    case 'delete_file': return args.path || ''
    case 'list_files':  return args.path || '/'
    case 'search_files': return `"${args.query || ''}"`
    case 'web_search':  return `"${args.query || ''}"`
    case 'web_fetch':   return args.url || ''
    case 'bash':        return args.command || ''
    default: return ''
  }
}

function formatResult(name, result) {
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
}) {
  const [open, setOpen] = useState(false)
  const spec = VERBS[name] || { verb: 'used', noun: name, icon: '⚙️' }

  // Status mark like Arena: ✓ / ✗ / spinning dot
  let mark, markCls
  if (status === 'done') {
    if (ok) { mark = '✓'; markCls = 'text-emerald-300' }
    else    { mark = '✗'; markCls = 'text-rose-300' }
  } else {
    mark = '•'; markCls = 'text-amber-300 animate-pulse'
  }

  const duration = startedAt && finishedAt ? fmtDuration(finishedAt - startedAt) : ''
  const argSummary = summarizeArgs(name, args)
  const body = status === 'done'
    ? (ok ? formatResult(name, result) : (error || 'unknown error'))
    : ''

  // Detect language for syntax highlighting on read_file / write_file / edit_file
  let highlightedHtml = null
  if (status === 'done' && ok && body) {
    let lang = ''
    if (name === 'write_file' || name === 'edit_file') lang = detectLangFromPath(args?.path || '')
    else if (name === 'read_file') lang = detectLangFromPath(args?.path || '')
    else if (name === 'bash')      lang = 'sh'
    if (lang) {
      highlightedHtml = highlight(body, lang)
    }
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-white/10 bg-graphite-800/60 text-[12px] md:text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/5 md:gap-2 md:px-3 md:py-2"
      >
        {/* Verb icon (terminal-like) */}
        <span className="font-mono text-[11px] text-cream-faint shrink-0">{spec.icon}</span>

        {/* Verb + noun (compact) */}
        <span className="flex shrink-0 items-baseline gap-1">
          <span className="text-cream-faint">{spec.verb}</span>
          {spec.noun && <span className="font-medium text-cream">{spec.noun}</span>}
        </span>

        {/* Arg preview (truncated) */}
        {argSummary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream-faint md:text-[12px]" title={argSummary}>
            {argSummary}
          </span>
        )}
        {!argSummary && <span className="flex-1" />}

        {/* Status mark */}
        <span className={`shrink-0 text-[13px] leading-none ${markCls}`}>{mark}</span>

        {/* Duration */}
        {duration && (
          <span className="shrink-0 font-mono text-[10px] text-cream-faint md:text-[11px]">{duration}</span>
        )}

        {/* Chevron */}
        <svg width="10" height="10" viewBox="0 0 12 12" className={`shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-white/10 px-2.5 py-2 md:px-3">
          {args && Object.keys(args).length > 0 && (
            <details className="mb-1.5 text-[11px] text-cream-faint" open={!body}>
              <summary className="cursor-pointer">аргументы</summary>
              <pre className="thin-scroll mt-1 max-h-32 overflow-auto rounded bg-graphite-900 p-2 font-mono text-[11px] text-cream">{JSON.stringify(args, null, 2)}</pre>
            </details>
          )}
          {status === 'done' ? (
            highlightedHtml ? (
              <pre
                className={`thin-scroll max-h-72 overflow-auto whitespace-pre-wrap rounded bg-graphite-900 p-2 font-mono text-[11px] ${ok ? 'text-cream' : 'text-rose-200'}`}
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            ) : (
              <pre className={`thin-scroll max-h-72 overflow-auto whitespace-pre-wrap rounded bg-graphite-900 p-2 font-mono text-[11px] ${ok ? 'text-cream' : 'text-rose-200'}`}>
                {body || (ok ? '(пустой результат)' : '(нет сообщения об ошибке)')}
              </pre>
            )
          ) : (
            <div className="text-cream-faint">выполняется…</div>
          )}
          {step != null && (
            <div className="mt-1 text-right text-[10px] text-cream-faint">шаг #{step}</div>
          )}
        </div>
      )}
    </div>
  )
}
