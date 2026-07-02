import { useCallback, useEffect, useMemo, useState } from 'react'
import { SLASH_COMMANDS } from '../lib/slashCommands.js'

/**
 * Two-mode autocomplete popup for Composer:
 *   • slash mode  — shown when text starts with `/<word>`; lists matching
 *                   commands with short hints.
 *   • mention mode — shown when text contains `@partial` (after a space
 *                    or at start); fuzzy-matches workspace files.
 *
 * Keyboard: ↑/↓ to navigate, Enter/Tab to accept, Esc to close.
 * Selecting a row calls onAccept(replacement) which the parent uses
 * to rewrite the textarea contents.
 */
export default function SlashAutocomplete({ text, caret, chatId, onAccept, onClose }) {
  const [files, setFiles] = useState([])
  const [active, setActive] = useState(0)

  // What is the token at the caret?
  const upToCaret = text.slice(0, caret)
  const slashMatch = /(^|\n)\/(\w*)$/.exec(upToCaret)
  const mentionMatch = /(?:^|\s)@(\S{0,80})$/.exec(upToCaret)
  const mode = slashMatch ? 'slash' : (mentionMatch ? 'mention' : null)
  const fragment = slashMatch ? slashMatch[2] : (mentionMatch ? mentionMatch[1] : '')

  // Load workspace file list for mention mode (lazy, once).
  useEffect(() => {
    if (mode !== 'mention') return
    if (files.length) return
    let alive = true
    ;(async () => {
      try {
        const url = chatId
          ? `/api/workspace/tree?chatId=${encodeURIComponent(chatId)}`
          : '/api/workspace/tree'
        const r = await fetch(url, { credentials: 'include' })
        if (!r.ok) return
        const j = await r.json()
        const flat = []
        const walk = (node, prefix = '') => {
          if (!node) return
          if (node.type === 'file') flat.push(prefix + node.name)
          else if (Array.isArray(node.children)) {
            const next = prefix ? prefix + node.name + '/' : (node.name ? node.name + '/' : '')
            for (const c of node.children) walk(c, prefix === '' && !node.name ? '' : next)
          }
        }
        walk(j.tree || j)
        if (alive) setFiles(flat.slice(0, 2000))
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [mode, chatId, files.length])

  // Reset active row when filter changes.
  useEffect(() => { setActive(0) }, [fragment, mode])

  // Compute current list.
  const rows = useMemo(() => {
    if (mode === 'slash') {
      const f = fragment.toLowerCase()
      return SLASH_COMMANDS.filter((c) => c.name.slice(1).startsWith(f)).slice(0, 8)
        .map((c) => ({ label: c.name, hint: c.hint, replacement: c.name + (c.name === '/model' ? ' ' : '') }))
    }
    if (mode === 'mention') {
      const f = fragment.toLowerCase()
      return files
        .filter((p) => p.toLowerCase().includes(f))
        .sort((a, b) => {
          // Prefer paths where the segment is at the start of basename.
          const aBase = a.split('/').pop().toLowerCase()
          const bBase = b.split('/').pop().toLowerCase()
          const aStart = aBase.startsWith(f) ? 0 : 1
          const bStart = bBase.startsWith(f) ? 0 : 1
          if (aStart !== bStart) return aStart - bStart
          return a.length - b.length
        })
        .slice(0, 8)
        .map((p) => ({ label: p, hint: '', replacement: '@' + (p.includes(' ') ? `"${p}"` : p) + ' ' }))
    }
    return []
  }, [mode, fragment, files])

  const accept = useCallback((row) => {
    if (!row) return
    const startToken = mode === 'slash' ? slashMatch.index + (slashMatch[1] === '\n' ? 1 : 0)
                                        : mentionMatch.index + (mentionMatch[0].startsWith(' ') ? 1 : 0)
    const newText = text.slice(0, startToken) + row.replacement + text.slice(caret)
    onAccept?.(newText, startToken + row.replacement.length)
  }, [mode, slashMatch, mentionMatch, text, caret, onAccept])

  // Keyboard handler attached on the parent's textarea via a window listener.
  useEffect(() => {
    if (!mode || rows.length === 0) return
    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % rows.length) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + rows.length) % rows.length) }
      else if (e.key === 'Escape') { e.preventDefault(); onClose?.() }
      else if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        accept(rows[active])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mode, rows, active, accept, onClose])

  if (!mode || rows.length === 0) return null

  return (
    <div className="absolute bottom-full left-2 z-30 mb-1 w-72 max-w-[90vw] overflow-hidden rounded-xl border border-white/10 bg-graphite-800 shadow-2xl">
      <div className="border-b border-white/5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-cream-faint">
        {mode === 'slash' ? `slash · ${rows.length}` : `файлы · ${rows.length}`}
      </div>
      <div className="max-h-60 overflow-y-auto">
        {rows.map((r, i) => (
          <button
            key={r.label}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); accept(r) }}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
              i === active ? 'bg-cream/15 text-cream' : 'text-cream-soft hover:bg-graphite-750'
            }`}
          >
            <span className="font-mono">{r.label}</span>
            {r.hint && <span className="ml-auto truncate text-[10px] text-cream-faint">{r.hint}</span>}
          </button>
        ))}
      </div>
      <div className="border-t border-white/5 px-3 py-1 text-[9px] uppercase tracking-wider text-cream-faint">
        ↑↓ навигация · Tab/Enter — выбрать · Esc — закрыть
      </div>
    </div>
  )
}
