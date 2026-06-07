import { useState } from 'react'

const ICONS = {
  list_files:   '📂',
  read_file:    '📄',
  write_file:   '✏️',
  edit_file:    '🔧',
  delete_file:  '🗑️',
  search_files: '🔎',
  web_search:   '🌐',
  web_fetch:    '📥',
  bash:         '🖥️',
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
    case 'bash':        return args.command ? args.command.slice(0, 60) : ''
    default: return JSON.stringify(args || {}).slice(0, 60)
  }
}

function formatResult(name, result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  // Pretty print known shapes
  if (name === 'read_file' && result.content) {
    return result.content
  }
  if (name === 'bash' && (result.stdout || result.stderr)) {
    let out = ''
    if (result.stdout) out += result.stdout
    if (result.stderr) out += (out ? '\n— stderr —\n' : '') + result.stderr
    if (result.exitCode != null) out += `\n[exit ${result.exitCode}]`
    return out
  }
  if (name === 'web_search' && Array.isArray(result.results)) {
    return result.results.map((r, i) => `${i + 1}. ${r.title || r.url}\n   ${r.url}\n   ${(r.snippet || '').slice(0, 200)}`).join('\n\n')
  }
  try { return JSON.stringify(result, null, 2) } catch { return String(result) }
}

export default function AgentToolBlock({ name, args, status = 'running', ok, result, error, step }) {
  const [open, setOpen] = useState(false)

  let stateLabel = '…'
  let stateCls = 'text-amber-300'
  if (status === 'done') {
    if (ok) { stateLabel = '✓'; stateCls = 'text-emerald-300' }
    else    { stateLabel = '✗'; stateCls = 'text-rose-300' }
  }

  const icon = ICONS[name] || '⚙️'
  const summary = summarizeArgs(name, args)
  const body = status === 'done'
    ? (ok ? formatResult(name, result) : (error || 'unknown error'))
    : ''

  return (
    <div className="my-2 rounded-lg border border-white/10 bg-graphite-800/60 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/5"
      >
        <span className="text-base leading-none">{icon}</span>
        <span className="font-mono text-cream">{name}</span>
        {summary && <span className="truncate text-cream-faint" title={summary}>· {summary}</span>}
        <span className={`ml-auto ${stateCls}`}>{stateLabel}</span>
        {step != null && <span className="text-[11px] text-cream-faint">#{step}</span>}
      </button>
      {open && (
        <div className="border-t border-white/10 px-3 py-2">
          {args && Object.keys(args).length > 0 && (
            <details className="mb-2 text-[11px] text-cream-faint">
              <summary className="cursor-pointer">arguments</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-graphite-900 p-2 font-mono text-cream">{JSON.stringify(args, null, 2)}</pre>
            </details>
          )}
          {status === 'done' ? (
            <pre className={`max-h-80 overflow-auto rounded bg-graphite-900 p-2 font-mono text-[11px] whitespace-pre-wrap ${ok ? 'text-cream' : 'text-rose-200'}`}>
              {body || (ok ? '(empty result)' : '(no error message)')}
            </pre>
          ) : (
            <div className="text-cream-faint">running…</div>
          )}
        </div>
      )}
    </div>
  )
}
