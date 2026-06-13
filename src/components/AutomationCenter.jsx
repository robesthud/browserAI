import { useEffect, useMemo, useState } from 'react'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

function statusClass(status) {
  if (status === 'succeeded') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
  if (status === 'failed') return 'border-red-400/30 bg-red-500/10 text-red-100'
  if (status === 'cancelled') return 'border-zinc-400/30 bg-zinc-500/10 text-zinc-100'
  return 'border-amber-400/30 bg-amber-500/10 text-amber-100'
}

function riskLabel(risk) {
  return { safe: 'safe', 'production-write': 'production' }[risk] || risk || 'unknown'
}

function fmtTime(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString() } catch { return String(ts) }
}

async function api(path, options = {}) {
  const r = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`)
    err.code = data.code
    err.policy = data.policy
    throw err
  }
  return data
}

function WorkflowCard({ workflow, onRefresh }) {
  const [open, setOpen] = useState(false)
  const running = !TERMINAL.has(workflow.status)
  const report = workflow.result?.report || ''
  return (
    <div className={`rounded-xl border p-3 text-[12px] ${statusClass(workflow.status)}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-cream">{workflow.title}</div>
          <div className="font-mono text-[10px] opacity-70">{workflow.id}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px]">{workflow.status}</span>
          <button onClick={() => setOpen(!open)} className="rounded border border-white/10 px-2 py-1 hover:bg-white/5">{open ? 'hide' : 'details'}</button>
        </div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/25">
        <div className="h-full bg-current opacity-70" style={{ width: `${Math.max(3, workflow.progress || 0)}%` }} />
      </div>
      {workflow.error && <div className="mt-2 text-red-200">{workflow.error}</div>}
      {open && (
        <div className="mt-3 space-y-2">
          {report && (
            <div className="rounded-lg border border-white/10 bg-black/15 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium text-cream">Report</span>
                <button onClick={() => navigator.clipboard?.writeText(report)} className="rounded border border-white/10 px-2 py-0.5 text-[10px] hover:bg-white/5">copy</button>
              </div>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-cream-soft">{report}</pre>
            </div>
          )}
          {(workflow.steps || []).map((s) => (
            <div key={s.id} className="rounded-lg border border-white/10 bg-black/15 p-2">
              <div className="flex items-center justify-between gap-2">
                <span>{s.idx}. {s.title}</span>
                <span className="font-mono text-[10px] opacity-75">{s.status}</span>
              </div>
              {s.error && <div className="mt-1 text-red-200">{s.error}</div>}
              {s.result && Object.keys(s.result || {}).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] opacity-75">result</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/25 p-2 text-[10px]">{JSON.stringify(s.result, null, 2).slice(0, 5000)}</pre>
                </details>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            {running && <button onClick={async () => { await api(`/api/agent/workflows/${workflow.id}/cancel`, { method: 'POST' }); onRefresh?.() }} className="rounded bg-red-500/15 px-2 py-1 text-red-100 hover:bg-red-500/25">cancel</button>}
            {['failed', 'cancelled'].includes(workflow.status) && <button onClick={async () => { await api(`/api/agent/workflows/${workflow.id}/retry`, { method: 'POST' }); onRefresh?.() }} className="rounded bg-violet-500/15 px-2 py-1 text-violet-100 hover:bg-violet-500/25">retry</button>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AutomationCenter() {
  const [recipes, setRecipes] = useState([])
  const [workflows, setWorkflows] = useState([])
  const [cronJobs, setCronJobs] = useState([])
  const [policy, setPolicy] = useState(null)
  const [policyEvents, setPolicyEvents] = useState([])
  const [webhookConfig, setWebhookConfig] = useState(null)
  const [webhookSecret, setWebhookSecret] = useState('')
  const [busyRecipe, setBusyRecipe] = useState('')
  const [error, setError] = useState('')
  const [scheduleRecipe, setScheduleRecipe] = useState('production_health_check')
  const [scheduleExpr, setScheduleExpr] = useState('*/15 minutes')

  const runningCount = useMemo(() => workflows.filter((w) => !TERMINAL.has(w.status)).length, [workflows])

  const refresh = async () => {
    const [r, w, c, p, wh] = await Promise.all([
      api('/api/agent/recipes'),
      api('/api/agent/workflows?limit=20'),
      api('/api/cron').catch(() => ({ jobs: [] })),
      api('/api/agent/policy?limit=20').catch(() => ({ policy: null, events: [] })),
      api('/api/webhooks/github/config').catch(() => null),
    ])
    setRecipes(r.recipes || [])
    setWorkflows(w.workflows || [])
    setCronJobs(c.jobs || [])
    setPolicy(p.policy || null)
    setPolicyEvents(p.events || [])
    setWebhookConfig(wh)
  }

  useEffect(() => {
    let dead = false
    const tick = async () => { try { if (!dead) await refresh() } catch (e) { if (!dead) setError(e.message) } }
    tick()
    const id = setInterval(tick, runningCount ? 2500 : 7000)
    return () => { dead = true; clearInterval(id) }
  }, [runningCount])

  const runRecipe = async (recipe) => {
    setBusyRecipe(recipe.id)
    setError('')
    try {
      let confirm = false
      if (recipe.requiresConfirmation || recipe.risk !== 'safe') {
        confirm = window.confirm(`Запустить automation recipe «${recipe.title}»?\n\nRisk: ${recipe.risk}\nЭто может изменить production.`)
        if (!confirm) return
      }
      await api('/api/agent/workflows', { method: 'POST', body: JSON.stringify({ recipeId: recipe.id, confirm }) })
      await refresh()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusyRecipe('')
    }
  }

  const scheduleSafeRecipe = async () => {
    const recipe = recipes.find((r) => r.id === scheduleRecipe)
    if (!recipe) return
    if (recipe.requiresConfirmation || recipe.risk !== 'safe') {
      setError('Scheduled automations currently allow only safe recipes without confirmation.')
      return
    }
    try {
      await api('/api/cron', {
        method: 'POST',
        body: JSON.stringify({ name: `workflow: ${recipe.title}`, schedule: scheduleExpr, trigger: 'workflow', prompt: recipe.id }),
      })
      setError(`Scheduled: ${recipe.title} (${scheduleExpr})`)
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
  }

  const toggleCron = async (job) => {
    await api(`/api/cron/${encodeURIComponent(job.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !job.enabled }) })
    await refresh()
  }
  const deleteCron = async (job) => {
    if (!window.confirm(`Удалить schedule «${job.name}»?`)) return
    await api(`/api/cron/${encodeURIComponent(job.id)}`, { method: 'DELETE' })
    await refresh()
  }
  const runCronNow = async (job) => {
    await api(`/api/cron/${encodeURIComponent(job.id)}/run`, { method: 'POST' })
    await refresh()
  }

  const generateWebhookSecret = async () => {
    try {
      const data = await api('/api/webhooks/github/secret', { method: 'POST' })
      setWebhookSecret(data.secret || '')
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Automation Center</h2>
          <p className="text-[12px] text-cream-faint">Production-grade recipes: health, safe deploy, self-heal, security and CI checks.</p>
        </div>
        <button onClick={() => void refresh()} className="rounded-lg border border-white/10 px-2.5 py-1 text-[12px] text-cream-soft hover:bg-graphite-750">↻</button>
      </div>

      {error && <div className="mb-3 rounded-lg border border-amber-400/25 bg-amber-500/10 p-2 text-[12px] text-amber-100">{error}</div>}

      {policy && (
        <details className="mb-3 rounded-xl border border-white/10 bg-black/15 p-3 text-[12px]">
          <summary className="cursor-pointer text-cream-soft">Policy Engine v{policy.version} · running/user {policy.maxRunningWorkflowsPerUser} · prod/hour {policy.maxProductionWritesPerHour}</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <pre className="max-h-44 overflow-auto rounded bg-black/25 p-2 text-[10px] text-cream-faint">{JSON.stringify(policy, null, 2)}</pre>
            <div className="max-h-44 overflow-auto space-y-1 text-[11px] text-cream-faint">
              {policyEvents.map((e) => <div key={e.id} className="rounded border border-white/5 px-2 py-1">{e.decision === 'allow' ? '✓' : '✗'} {e.recipeId} · {e.source} · {e.reason}</div>)}
            </div>
          </div>
        </details>
      )}

      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        {recipes.map((r) => (
          <button key={r.id} type="button" disabled={busyRecipe === r.id} onClick={() => void runRecipe(r)} className="rounded-xl border border-white/10 bg-black/15 p-3 text-left transition hover:border-white/20 hover:bg-white/5 disabled:opacity-60">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium text-cream">{r.icon} {r.title}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.risk === 'safe' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-200'}`}>{riskLabel(r.risk)}</span>
            </div>
            <div className="line-clamp-3 text-[12px] text-cream-faint">{r.description}</div>
            <div className="mt-2 text-[10px] text-cream-faint">{(r.steps || []).length} steps · {(r.tags || []).join(', ')}</div>
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-black/15 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-medium">GitHub webhook setup</h3>
            <p className="text-[11px] text-cream-faint">Подключи GitHub → Settings → Webhooks: workflow_run failed и push to main будут создавать incidents и diagnostics workflows.</p>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${webhookConfig?.configured ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-200'}`}>{webhookConfig?.configured ? 'configured' : 'no secret'}</span>
        </div>
        <div className="space-y-2 text-[12px]">
          <div className="rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 font-mono text-[11px] text-cream-soft">{webhookConfig?.endpoint || '/api/webhooks/github'}</div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => navigator.clipboard?.writeText(webhookConfig?.endpoint || '')} className="rounded border border-white/10 px-2 py-1 text-[11px] hover:bg-white/5">copy endpoint</button>
            {!webhookConfig?.configured && <button onClick={() => void generateWebhookSecret()} className="rounded border border-violet-400/25 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-100 hover:bg-violet-500/20">generate secret</button>}
            <span className="text-[11px] text-cream-faint">source: {webhookConfig?.source || 'unknown'} · required: {webhookConfig?.required ? 'yes' : 'no'}</span>
          </div>
          {webhookSecret && (
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/10 p-2">
              <div className="mb-1 text-[11px] text-amber-100">Secret shown once — paste it into GitHub webhook settings:</div>
              <div className="flex gap-2"><code className="min-w-0 flex-1 break-all text-[11px] text-cream">{webhookSecret}</code><button onClick={() => navigator.clipboard?.writeText(webhookSecret)} className="rounded border border-white/10 px-2 py-1 text-[11px]">copy</button></div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-black/15 p-3">
        <div className="mb-2">
          <h3 className="text-[13px] font-medium">Scheduled automation</h3>
          <p className="text-[11px] text-cream-faint">Запуск safe recipes по расписанию. Форматы: */15 minutes, hourly, daily 09:00, weekly mon 10:00.</p>
        </div>
        <div className="flex flex-col gap-2 md:flex-row">
          <select value={scheduleRecipe} onChange={(e) => setScheduleRecipe(e.target.value)} className="rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 text-[12px] text-cream">
            {recipes.filter((r) => r.risk === 'safe' && !r.requiresConfirmation).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
          <input value={scheduleExpr} onChange={(e) => setScheduleExpr(e.target.value)} className="rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 text-[12px] text-cream" placeholder="*/15 minutes" />
          <button onClick={() => void scheduleSafeRecipe()} className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-100 hover:bg-emerald-500/20">Schedule</button>
        </div>
        <div className="mt-3 space-y-1">
          {cronJobs.length === 0 ? <div className="text-[12px] text-cream-faint">Нет schedules.</div> : cronJobs.map((j) => (
            <div key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-graphite-900/60 px-2 py-1.5 text-[11px]">
              <span className={j.enabled ? 'text-emerald-200' : 'text-cream-faint'}>{j.enabled ? '●' : '○'}</span>
              <span className="min-w-0 flex-1 truncate text-cream-soft">{j.name}</span>
              <span className="font-mono text-cream-faint">{j.schedule}</span>
              <span className="text-cream-faint">next: {fmtTime(j.next_run_at)}</span>
              <button onClick={() => void runCronNow(j)} className="rounded border border-white/10 px-1.5 py-0.5 hover:bg-white/5">run</button>
              <button onClick={() => void toggleCron(j)} className="rounded border border-white/10 px-1.5 py-0.5 hover:bg-white/5">{j.enabled ? 'pause' : 'enable'}</button>
              <button onClick={() => void deleteCron(j)} className="rounded border border-red-400/20 px-1.5 py-0.5 text-red-200 hover:bg-red-500/10">del</button>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-medium">Recent workflows</h3>
          {runningCount > 0 && <span className="text-[11px] text-amber-200">{runningCount} running</span>}
        </div>
        <div className="space-y-2">
          {workflows.length === 0 ? <div className="text-[12px] text-cream-faint">Пока нет workflow.</div> : workflows.map((w) => <WorkflowCard key={w.id} workflow={w} onRefresh={refresh} />)}
        </div>
      </div>
    </section>
  )
}
