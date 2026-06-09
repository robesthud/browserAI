function short(value = '', max = 80) {
  const s = String(value || '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

function devtoolsEnabled() {
  try { return localStorage.getItem('browserai.devtools') === '1' }
  catch { return false }
}

export default function AgentRuntimePanel({ context, state, protocol, routerWarnings = [] }) {
  if (!context && !state && !protocol && !routerWarnings?.length) return null

  const isDev = devtoolsEnabled()
  const task = context?.task || {}
  const model = context?.model || {}
  const workspace = context?.workspace || {}
  const planSteps = Array.isArray(state?.plan?.steps) ? state.plan.steps : []
  const doneSet = new Set(Array.isArray(state?.plan?.done) ? state.plan.done.map(Number) : [])
  const touched = Array.isArray(state?.touchedFiles) ? state.touchedFiles : []
  const errors = Array.isArray(state?.lastErrors) ? state.lastErrors : []
  const next = Array.isArray(state?.nextActions) ? state.nextActions : []
  const status = state?.status || (task.type ? 'running' : '')
  const planDone = planSteps.filter((s) => Boolean(s.done) || doneSet.has(Number(s.idx))).length
  const planTotal = planSteps.length

  return (
    <details
      className="mb-2 rounded-xl border border-white/10 bg-graphite-800/30 text-[12px] text-cream-soft"
      open={Boolean(state?.status === 'waiting_for_user' || errors.length)}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-cream">
        <span className="inline-flex items-center gap-2">
          <span>🧭 Ход выполнения</span>
          {status ? <span className="rounded-full bg-graphite-700 px-1.5 py-0.5 font-mono text-[10px] text-cream-faint">{status}</span> : null}
          {planTotal ? <span className="rounded-full bg-graphite-700 px-1.5 py-0.5 font-mono text-[10px] text-cream-faint">{planDone}/{planTotal}</span> : null}
          {isDev && task.type ? <span className="rounded-full bg-graphite-700 px-1.5 py-0.5 font-mono text-[10px] text-cream-faint">{task.type}</span> : null}
        </span>
      </summary>

      <div className="space-y-2 border-t border-white/10 px-3 py-2">
        {state?.currentStep ? (
          <div>
            <span className="text-cream-faint">Сейчас:</span> {state.currentStep}
          </div>
        ) : null}

        {planSteps.length ? (
          <div>
            <div className="mb-1 text-cream-faint">План</div>
            <div className="space-y-0.5">
              {planSteps.slice(0, 8).map((s) => {
                const idx = Number(s.idx)
                const done = Boolean(s.done) || doneSet.has(idx)
                return (
                  <div key={idx || s.text} className={done ? 'text-emerald-300' : 'text-cream-soft'}>
                    {done ? '✓' : '○'} {idx || '?'} · {short(s.text, 120)}
                  </div>
                )
              })}
              {planSteps.length > 8 ? <div className="text-cream-faint">… ещё {planSteps.length - 8}</div> : null}
            </div>
          </div>
        ) : null}

        {errors.length ? (
          <div>
            <div className="mb-1 text-red-300">Ошибки</div>
            {errors.slice(-3).map((e, i) => <div key={i} className="rounded bg-red-500/10 px-2 py-1 text-red-200">{short(e, 180)}</div>)}
          </div>
        ) : null}

        {touched.length ? (
          <div><span className="text-cream-faint">Файлы:</span> {touched.slice(-6).map((f) => short(f, 36)).join(', ')}</div>
        ) : null}

        {next.length ? (
          <div><span className="text-cream-faint">Дальше:</span> {next.slice(0, 3).map((x) => short(x, 80)).join(' → ')}</div>
        ) : null}

        {isDev && state?.goal ? (
          <div>
            <div className="mb-1 text-cream-faint">goal</div>
            <div className="rounded-lg bg-black/20 px-2 py-1">{short(state.goal, 260)}</div>
          </div>
        ) : null}

        {isDev && protocol ? (
          <div className="text-cream-faint">
            stream v{protocol.version || 1} · {protocol.compatibility || 'compatible'}
          </div>
        ) : null}

        {isDev && context ? (
          <div className="grid gap-1 sm:grid-cols-2">
            <div><span className="text-cream-faint">model:</span> {short(model.id || '—', 42)}</div>
            <div><span className="text-cream-faint">provider:</span> {model.providerKind || '—'}</div>
            <div><span className="text-cream-faint">tools:</span> {model.supportsNativeTools ? 'native + universal' : 'universal XML'}</div>
            <div><span className="text-cream-faint">workspace:</span> {workspace.scoped ? 'scoped' : 'global'} · {workspace.cwd || '/workspace'}</div>
            <div><span className="text-cream-faint">complexity:</span> {task.complexity || '—'}</div>
            <div><span className="text-cream-faint">max steps:</span> {context.runtime?.effectiveMaxSteps || context.runtime?.requestedMaxSteps || '—'}</div>
          </div>
        ) : null}

        {isDev && routerWarnings?.length ? (
          <div>
            <div className="mb-1 text-amber-300">tool router warnings</div>
            {routerWarnings.slice(-4).map((w, i) => (
              <div key={i} className="rounded bg-amber-500/10 px-2 py-1 text-amber-100">
                {w.name ? `${w.name}: ` : ''}{(w.warnings || []).join('; ')}
              </div>
            ))}
          </div>
        ) : null}

        {isDev && state?.toolStats ? (
          <div className="text-cream-faint">
            tools: {state.toolStats.total || 0} · ok {state.toolStats.ok || 0} · failed {state.toolStats.failed || 0}
          </div>
        ) : null}
      </div>
    </details>
  )
}
