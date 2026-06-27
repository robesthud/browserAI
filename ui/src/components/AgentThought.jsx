import Markdown from '../lib/markdown.jsx'

/**
 * User-facing agent narration. This is not hidden chain-of-thought: it is the
 * short operational explanation the agent gives between tool calls.
 * Render it like regular assistant text: no avatar, no card frame.
 */
export default function AgentThought({ text }) {
  const raw = String(text || '').trim()
  if (!raw) return null

  return (
    <div className="my-1.5 text-[14px] leading-relaxed text-cream-soft text-left">
      <Markdown text={raw} />
    </div>
  )
}
