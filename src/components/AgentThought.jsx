import { useState } from 'react'
import Markdown from '../lib/markdown.jsx'

/**
 * Inline "model is thinking" block. Collapsed by default — user requested
 * less visual noise in chat. A small "💭 размышления" pill expands to the
 * full markdown text. Multiple consecutive thoughts within the same step
 * are concatenated by the caller before being handed here, but we also
 * accept an array.
 */
export default function AgentThought({ text }) {
  const [open, setOpen] = useState(false)
  const raw = String(text || '').trim()
  if (!raw) return null
  // Tiny preview shown next to the pill so the user has a hint of what's
  // inside without expanding.
  const preview = raw.replace(/\s+/g, ' ').slice(0, 80)

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] text-cream-faint hover:bg-white/5"
        title={open ? 'Скрыть размышления' : 'Показать размышления'}
      >
        <span className="shrink-0">💭</span>
        <span className="shrink-0 text-cream-faint/80">размышления</span>
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate text-cream-faint/60">{preview}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 12 12" className={`ml-auto shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-white/5 bg-graphite-800/40 px-2.5 py-1.5 text-[13px] text-cream-soft/90">
          <Markdown text={raw} />
        </div>
      )}
    </div>
  )
}
