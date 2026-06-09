import { useState } from "react"
import AgentPlanCard from './AgentPlanCard.jsx'

export default function AgentRuntimePanel({ context, state, aiWorking, isDev }) {
  const isRunning = state?.status === 'running' || state?.status === 'planning'
  const [open, setOpen] = useState(isRunning)

  if (!state) return null

  // Format arrays for display
  const errors = state.lastErrors || []
  const files = state.touchedFiles || []
  const plan = state.plan || { steps: [], done: [] }
  const totalSteps = plan.steps?.length || 0

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-white/10 bg-graphite-800/40 text-[13px] shadow-sm">
      {/* Header / Toggle */}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between bg-graphite-800/60 px-3 py-2 text-left hover:bg-graphite-800/80 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          <span className="font-medium text-cream">Agent State</span>
          
          <span className={`rounded-full px-1.5 py-px text-[10px] font-mono tracking-wider border ${
            isRunning 
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' 
              : state.status === 'error'
              ? 'border-red-500/30 bg-red-500/10 text-red-300'
              : 'border-white/10 bg-black/20 text-cream-faint'
          }`}>
            {state.status}
          </span>
          
          {isRunning && aiWorking && (
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          )}
        </div>
        
        {state.currentStep && !open && (
           <div className="truncate text-[11px] text-cream-faint max-w-[200px] ml-2">
             {state.currentStep}
           </div>
        )}
      </button>

      {/* Expanded Content */}
      {open && (
        <div className="p-3 space-y-3">
          {/* P3-02 Context Visibility */}
          {isDev && context && (
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {context.task?.type && (
                 <span className="rounded bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-200">
                   Task: {context.task.type}
                 </span>
              )}
              {context.task?.complexity && (
                 <span className="rounded bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-200">
                   Complexity: {context.task.complexity}
                 </span>
              )}
              {context.workspace?.scope && (
                 <span className="rounded bg-black/20 border border-white/5 px-1.5 py-0.5 text-[10px] text-cream-faint font-mono">
                   Workspace: {context.workspace.scope}
                 </span>
              )}
            </div>
          )}

          {state.goal && (
            <div>
              <div className="text-[11px] font-medium text-cream-faint uppercase tracking-wide mb-0.5">Goal</div>
              <div className="text-cream-soft leading-snug">{state.goal}</div>
            </div>
          )}

          {state.currentStep && (
            <div>
              <div className="text-[11px] font-medium text-cream-faint uppercase tracking-wide mb-0.5">Current Step</div>
              <div className="text-amber-200/90">{state.currentStep}</div>
            </div>
          )}

          {totalSteps > 0 && (
            <div>
              <div className="text-[11px] font-medium text-cream-faint uppercase tracking-wide mb-1.5">Plan</div>
              <AgentPlanCard plan={plan} hideBorder={true} />
            </div>
          )}

          {files.length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-cream-faint uppercase tracking-wide mb-0.5">Touched Files</div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {files.map(f => (
                  <span key={f} className="rounded bg-black/20 border border-white/5 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-cream-faint uppercase tracking-wide mb-0.5 text-red-300/70">Last Errors</div>
              <div className="space-y-1">
                {errors.map((err, i) => (
                  <div key={i} className="rounded bg-red-500/10 border border-red-500/20 p-1.5 text-[11px] text-red-200 font-mono break-words">
                    {err}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
