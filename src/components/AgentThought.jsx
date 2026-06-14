import { useState } from 'react'
import Markdown from '../lib/markdown.jsx'

/**
 * User-facing agent narration. This is not hidden chain-of-thought: it is the
 * short operational explanation the agent gives between tool calls, e.g.
 * "Сейчас запущу тесты". Long entries remain expandable to keep the chat clean.
 */
export default function AgentThought({ text }) {
  const [open, setOpen] = useState(false)
  const raw = String(text || '').trim()
  if (!raw) return null
  const compact = raw.length <= 260
  const preview = raw.replace(/\s+/g, ' ').slice(0, 180)

  if (compact) {
    return (
      <div className="my-1 rounded-lg border border-white/5 bg-graphite-800/35 px-2.5 py-1.5 text-[13px] leading-relaxed text-cream-soft/90">
        <span className="mr-1.5">🤖</span>
        <Markdown text={raw} />
      </div>
    )
  }

  return (
    <div className="my-1 rounded-lg border border-white/5 bg-graphite-800/35">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[13px] text-cream-soft hover:bg-white/5"
        title={open ? 'Свернуть шаг агента' : 'Развернуть шаг агента'}
      >
        <span className="shrink-0">🤖</span>
        <span className="shrink-0 text-cream-soft/90">агент</span>
        {!open && preview && <span className="min-w-0 flex-1 truncate text-cream-faint">{preview}…</span>}
        <svg width="10" height="10" viewBox="0 0 12 12" className={`ml-auto shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-white/5 px-2.5 py-1.5 text-[13px] text-cream-soft/90">
          <Markdown text={raw} />
        </div>
      )}
    </div>
  )
}
