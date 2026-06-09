import React from 'react'

export default function AgentRuntimePanel({ state }) {
  if (!state) return null

  return (
    <div className="mb-3 rounded-xl border border-white/10 bg-graphite-800/60 p-3 text-[12px]">
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50">
        <span>Agent Runtime</span>
        <span className="rounded bg-white/10 px-1.5 py-px font-mono text-[9px]">{state.status}</span>
      </div>

      {state.goal && (
        <div className="mb-1 text-white/90">
          <span className="text-white/50">Goal:</span> {state.goal}
        </div>
      )}

      {state.currentStep && (
        <div className="text-amber-300">
          Current step: <span className="font-medium">{state.currentStep}</span>
        </div>
      )}

      {state.lastErrors?.length > 0 && (
        <div className="mt-1 text-red-400">
          Errors: {state.lastErrors.length}
        </div>
      )}

      {state.touchedFiles?.length > 0 && (
        <div className="mt-1 text-emerald-400 text-[11px]">
          Files: {state.touchedFiles.slice(0, 4).join(', ')}
          {state.touchedFiles.length > 4 && '...'}
        </div>
      )}
    </div>
  )
}
