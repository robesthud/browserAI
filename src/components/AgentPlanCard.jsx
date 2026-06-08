/**
 * Compact plan/TODO card. Folds plan_set + plan_check tool results into
 * one visual checklist so the user sees "Step 4 of 12" instead of an
 * opaque sequence of tool calls.
 *
 * The MessageList pre-processes the assistant message's toolCalls and
 * passes us:
 *   plan:  { title, steps: [{idx, text, done, note}] }
 * The component is purely presentational.
 */
export default function AgentPlanCard({ plan }) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null
  const done = plan.steps.filter((s) => s.done).length
  const total = plan.steps.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-violet-400/20 bg-violet-500/5 p-3 text-[13px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">📋</span>
          <span className="truncate font-medium text-cream">
            {plan.title || 'Plan'}
          </span>
        </div>
        <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[11px] text-violet-200">
          {done} / {total}
        </span>
      </div>
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-graphite-900/60">
        <div className="h-full bg-violet-400 transition-all" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <ol className="space-y-1">
        {plan.steps.map((s) => (
          <li key={s.idx} className="flex items-start gap-2 text-cream-soft">
            <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              s.done
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                : 'border-white/15 text-cream-faint'
            }`}>{s.done ? '✓' : ''}</span>
            <span className={`min-w-0 ${s.done ? 'text-cream-faint line-through' : ''}`}>
              {s.text}
              {s.note ? <span className="ml-1 text-[11px] text-cream-faint">— {s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
