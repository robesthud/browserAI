import { useEffect, useRef, useState } from 'react'
import Markdown from '../lib/markdown.jsx'

/**
 * "Extended thinking" / provider-side reasoning block.
 *
 * Renders Anthropic Claude 3.7+ `delta.reasoning`, OpenAI o1/o3
 * reasoning streams, and DeepSeek-R1 `reasoning_content` chunks.
 * Auto-opens while text is still streaming so the user can watch the
 * model "think", and folds itself shut once the parent message stops
 * being pending (so the final answer is what dominates the bubble).
 *
 * Props:
 *   text        — accumulated reasoning markdown (server appends chunks)
 *   pending     — true while the assistant turn is still streaming
 *   tokens      — optional reasoning token count (from usage.reasoningTokens)
 */
export default function AgentExtendedThinking({ text, pending = false, tokens = 0 }) {
  const raw = String(text || '').trim()
  const [open, setOpen] = useState(true)         // open while streaming
  const [userOverride, setUserOverride] = useState(false)
  const scrollRef = useRef(null)

  // Auto-fold once the assistant turn finishes — unless the user
  // explicitly clicked the pill (then we respect their choice).
  useEffect(() => {
    if (userOverride) return
    if (!pending) setOpen(false)
  }, [pending, userOverride])

  // Auto-scroll the inner pre to bottom while streaming.
  useEffect(() => {
    if (!open || !pending) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [raw, open, pending])

  if (!raw) return null

  const charCount = raw.length
  const preview = raw.replace(/\s+/g, ' ').slice(0, 80)

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => { setUserOverride(true); setOpen((o) => !o) }}
        className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] transition-colors ${
          pending
            ? 'text-violet-200 hover:bg-violet-500/10'
            : 'text-cream-faint hover:bg-white/5'
        }`}
        title={open ? 'Скрыть размышления модели' : 'Показать размышления модели'}
      >
        <span className="shrink-0">{pending ? '🧠' : '💭'}</span>
        <span className="shrink-0 font-medium">
          {pending ? 'модель размышляет' : 'размышления'}
        </span>
        {pending && (
          <span className="shrink-0 inline-block h-1.5 w-1.5 rounded-full bg-violet-300 animate-pulse" />
        )}
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate text-cream-faint/60">{preview}</span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-cream-faint/60">
          {tokens > 0 ? `${tokens} reasoning tok` : `${charCount} ch`}
        </span>
        <svg width="10" height="10" viewBox="0 0 12 12" className={`shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4 L6 8 L10 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          ref={scrollRef}
          className={`thin-scroll mt-1 max-h-72 overflow-y-auto rounded-md border px-2.5 py-1.5 text-[12.5px] leading-relaxed transition-colors ${
            pending
              ? 'border-violet-400/30 bg-violet-500/[0.04] text-cream-soft/90'
              : 'border-white/5 bg-graphite-800/40 text-cream-soft/80'
          }`}
        >
          <Markdown text={raw} />
          {pending && (
            <span className="ml-0.5 inline-block w-1.5 align-middle text-violet-300">▌</span>
          )}
        </div>
      )}
    </div>
  )
}
