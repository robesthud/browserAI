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
  list_files:      { verb: 'used',  noun: 'List Files',  icon: '📂' },
  find_projects:   { verb: 'used',  noun: 'Find Projects', icon: '🗂' },
  read_file:       { verb: 'used',  noun: 'Read File',   icon: '📄' },
  write_file:      { verb: 'Write', noun: '',            icon: '✏️' },
  edit_file:       { verb: 'Edit',  noun: '',            icon: '🔧' },
  delete_file:     { verb: 'used',  noun: 'Delete',      icon: '🗑️' },
  file_history:    { verb: 'used',  noun: 'History',     icon: '🕓' },
  restore_file:    { verb: 'used',  noun: 'Restore',     icon: '↩️' },
  search_files:    { verb: 'used',  noun: 'Search',      icon: '🔎' },
  download_url:    { verb: 'used',  noun: 'Download',    icon: '📥' },
  git_status:      { verb: 'used',  noun: 'git status',  icon: '⎇' },
  git_diff:        { verb: 'used',  noun: 'git diff',    icon: '⎇' },
  git_commit:      { verb: 'used',  noun: 'git commit',  icon: '⎇' },
  git_push:        { verb: 'used',  noun: 'git push',    icon: '⎇' },
  git_pull:        { verb: 'used',  noun: 'git pull',    icon: '⎇' },
  git_clone:       { verb: 'used',  noun: 'git clone',   icon: '⎇' },
  github_pr_create:{ verb: 'used',  noun: 'GitHub PR',   icon: '🔀' },
  web_search:      { verb: 'used',  noun: 'Web Search',  icon: '🌐' },
  web_fetch:       { verb: 'used',  noun: 'Fetch',       icon: '📥' },
  bash:            { verb: 'used',  noun: 'Bash',        icon: '>_' },
  verify_code:     { verb: 'used',  noun: 'Verify',      icon: '✅' },
  browser_open:    { verb: 'used',  noun: 'Open Page',   icon: '🌐' },
  browser_screenshot:{ verb: 'used',noun: 'Screenshot',  icon: '📸' },
  browser_click:   { verb: 'used',  noun: 'Click',       icon: '🖱' },
  browser_type:    { verb: 'used',  noun: 'Type',        icon: '⌨' },
  browser_close:   { verb: 'used',  noun: 'Close Page',  icon: '✖' },
  analyze_image:   { verb: 'used',  noun: 'Vision',      icon: '👁' },
  ops_list_services:{ verb:'used',  noun: 'Ops List',    icon: '🛠' },
  ops_run_action:  { verb: 'used',  noun: 'Ops Action',  icon: '🛠' },
  plan_set:        { verb: 'used',  noun: 'Plan',        icon: '📋' },
  plan_check:      { verb: 'used',  noun: 'Plan check',  icon: '☑️' },
  use_subagents:   { verb: 'Spawned', noun: 'Sub-agents', icon: '🛰' },
  remember_fact:   { verb: 'used',  noun: 'Remember',    icon: '🧠' },
  forget_fact:     { verb: 'used',  noun: 'Forget',      icon: '🧠' },
  recall_facts:    { verb: 'used',  noun: 'Recall',      icon: '🧠' },
  kb_add:          { verb: 'used',  noun: 'KB add',      icon: '📚' },
  kb_search:       { verb: 'used',  noun: 'KB search',   icon: '📚' },
  kb_list:         { verb: 'used',  noun: 'KB list',     icon: '📚' },
  kb_delete:       { verb: 'used',  noun: 'KB delete',   icon: '📚' },
  replace_across_files: { verb: 'Refactor', noun: '',    icon: '🔄' },
  run_tests:       { verb: 'used',  noun: 'Tests',       icon: '🧪' },
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
    case 'restore_file': return args.path || ''
    case 'list_files':
    case 'find_projects': return args.path || '/'
    case 'search_files': return `"${args.query || ''}"`
    case 'web_search':  return `"${args.query || ''}"`
    case 'web_fetch':
    case 'download_url': return args.url || ''
    case 'browser_open':
    case 'browser_screenshot':
    case 'browser_close': return args.url || args.session_id || ''
    case 'browser_click':
    case 'browser_type':  return args.selector || args.text || ''
    case 'bash':        return args.command || ''
    case 'verify_code': return args.path || args.script || 'verify'
    case 'git_commit':  return args.message || ''
    case 'git_push':    return args.branch || 'current branch'
    case 'github_pr_create': return args.title || ''
    case 'plan_set':    return args.title || `${args.steps ? '...' : ''}`
    case 'plan_check':  return args.indices || ''
    case 'ops_run_action': return `${args.service || ''}.${args.action || ''}`
    default: return ''
  }
}

// Tiny "+N / -M lines" hint to surface in the collapsed pill for edit_file.
// Calculated from the result.oldLines / newLines returned by the new
// edit_file handler. Falls back to '' if either field is missing
// (old single-replacement responses).
function editDeltaPill(result) {
  if (!result || typeof result !== 'object') return ''
  const o = Number(result.oldLines)
  const n = Number(result.newLines)
  if (!Number.isFinite(o) || !Number.isFinite(n)) return ''
  const d = n - o
  if (d === 0) return '±0 lines'
  return d > 0 ? `+${d} lines` : `${d} lines`
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
  stream,
  diagnostic,   // { path, error } when post-write syntax check failed
}) {
  const [open, setOpen] = useState(false)
  // MCP tools come back as 'mcp__<server>__<tool>'. Render them with a
  // distinct icon and a clean human-readable noun so the UI doesn't
  // dump the raw triple-underscore string.
  const mcpMatch = typeof name === 'string' && name.startsWith('mcp__')
    ? name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
    : null
  const spec = mcpMatch
    ? { verb: 'MCP', noun: `${mcpMatch[1]}/${mcpMatch[2]}`, icon: '🔌' }
    : (VERBS[name] || { verb: 'used', noun: name, icon: '⚙️' })

  // Status mark like Arena: ✓ / ✗ / spinning dot / queued
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
  const body = status === 'done'
    ? (ok ? formatResult(name, result) : (error || 'unknown error'))
    : ''
  const deltaPill = status === 'done' && ok && (name === 'edit_file' || name === 'write_file')
    ? editDeltaPill(result)
    : ''
  // Inline screenshot preview for browser_* tools (whenever the result
  // includes a screenshot path inside /workspace).
  const screenshotPath = status === 'done' && ok && result && typeof result === 'object'
    ? (result.screenshotPath || result.screenshot || (typeof result.path === 'string' && /\.(png|jpg|jpeg|webp)$/i.test(result.path) ? result.path : ''))
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

        {/* +N/-M lines pill for edit_file / write_file */}
        {deltaPill && (
          <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">{deltaPill}</span>
        )}

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

      {/* Always-visible mini-tail: when a long-running tool (bash /
          verify_code / browser_*) is producing stdout LIVE, show the
          last ~2 lines below the pill without forcing the user to
          expand. Disappears the moment the tool finishes. */}
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
          {args && Object.keys(args).length > 0 && (
            <details className="mb-1.5 text-[11px] text-cream-faint" open={!body}>
              <summary className="cursor-pointer">аргументы</summary>
              <pre className="thin-scroll mt-1 max-h-32 overflow-auto rounded bg-graphite-900 p-2 font-mono text-[11px] text-cream">{JSON.stringify(args, null, 2)}</pre>
            </details>
          )}
          {/* Inline screenshot preview for browser_* tools */}
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
          {diagnostic && (
            <div className="mb-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
              ⚠ После записи <code className="rounded bg-graphite-900/60 px-1 py-0.5 font-mono">{diagnostic.path}</code> синтаксис-чек выдал: {diagnostic.error}
            </div>
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
            stream ? (
              // Live tail of stdout/stderr from a long-running bash /
              // verify_code call. Auto-scrolls to bottom each render via
              // overflow-anchor on the wrapper. Capped to last ~8 KB
              // on the client too (see useChats.js).
              <pre className="thin-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded bg-graphite-900 p-2 font-mono text-[11px] text-cream-faint">
                {stream}
                <span className="text-amber-300">▌</span>
              </pre>
            ) : (
              <div className="text-cream-faint">выполняется…</div>
            )
          )}
          {step != null && (
            <div className="mt-1 text-right text-[10px] text-cream-faint">шаг #{step}</div>
          )}
        </div>
      )}
    </div>
  )
}
