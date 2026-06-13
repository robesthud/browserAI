function tone(type) {
  if (type === 'success') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
  if (type === 'error') return 'border-red-400/30 bg-red-500/10 text-red-100'
  if (type === 'warn') return 'border-amber-400/30 bg-amber-500/10 text-amber-100'
  return 'border-white/10 bg-black/15 text-cream-soft'
}

function fmt(ts) {
  try { return new Date(ts).toLocaleTimeString() } catch { return '' }
}

export default function OperatorMissionTimeline({ events = [] }) {
  if (!events?.length) return <div className="text-[11px] text-cream-faint">No timeline events yet.</div>
  return (
    <div className="space-y-1.5">
      {events.slice(-30).map((e) => (
        <div key={e.id} className={`rounded-lg border px-2 py-1.5 text-[11px] ${tone(e.type)}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{e.title || e.type}</span>
            <span className="shrink-0 font-mono text-[10px] opacity-60">{fmt(e.createdAt)}</span>
          </div>
          {e.message && <div className="mt-0.5 whitespace-pre-wrap opacity-85">{e.message}</div>}
          {e.data && Object.keys(e.data || {}).length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] opacity-60">data</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-1.5 text-[10px]">{JSON.stringify(e.data, null, 2).slice(0, 2500)}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  )
}
