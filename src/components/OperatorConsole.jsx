import { useEffect, useState } from 'react'
import OperatorReportModal from './OperatorReportModal.jsx'
import OperatorMissionTimeline from './OperatorMissionTimeline.jsx'

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
    throw err
  }
  return data
}

function pill(status) {
  if (status === 'succeeded') return 'bg-emerald-500/15 text-emerald-200'
  if (status === 'failed') return 'bg-red-500/15 text-red-200'
  if (status === 'running' || status === 'queued') return 'bg-amber-500/15 text-amber-200'
  return 'bg-white/10 text-cream-faint'
}

export default function OperatorConsole() {
  const [operator, setOperator] = useState(null)
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reportTarget, setReportTarget] = useState(null)

  const refresh = async () => {
    try {
      const data = await api('/api/operator/status')
      setOperator(data.operator)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }

  useEffect(() => {
    let dead = false
    const tick = async () => { if (!dead) await refresh() }
    tick()
    const id = setInterval(tick, 7000)
    return () => { dead = true; clearInterval(id) }
  }, [])

  const startMission = async (type, { confirm = false } = {}) => {
    setBusy(true)
    setError('')
    try {
      const mt = operator?.missionTypes?.find((m) => m.id === type)
      let ok = confirm
      if (mt?.requiresConfirmation && !ok) {
        ok = window.confirm(`Operator mission «${mt.title}» может менять production. Запустить?`)
        if (!ok) return
      }
      await api('/api/operator/missions', { method: 'POST', body: JSON.stringify({ type, goal, confirm: ok }) })
      setGoal('')
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const finalizeCodeTask = async (taskId) => {
    const ok = window.confirm('Commit, push branch and create PR for this code task?')
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/operator/code-tasks/${encodeURIComponent(taskId)}/finalize`, { method: 'POST', body: JSON.stringify({ push: true, createPr: true }) })
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const reviewCodeTask = async (taskId) => {
    setBusy(true)
    setError('')
    try {
      await api(`/api/operator/code-tasks/${encodeURIComponent(taskId)}/review`, { method: 'POST' })
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const waitCi = async (taskId) => {
    setBusy(true)
    setError('')
    try {
      await api(`/api/operator/code-tasks/${encodeURIComponent(taskId)}/wait-ci`, { method: 'POST', body: JSON.stringify({ timeoutSec: 900, intervalSec: 15 }) })
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const autoFixCi = async (taskId) => {
    const ok = window.confirm('Start CI auto-fix loop? The agent will patch the same branch, verify, commit, push and wait CI again.')
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/operator/code-tasks/${encodeURIComponent(taskId)}/auto-fix-ci`, { method: 'POST', body: JSON.stringify({ maxAttempts: 2 }) })
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const mergePr = async (taskId, deploy = false) => {
    const ok = window.confirm(deploy ? 'Merge PR and start safe production deploy?' : 'Merge this PR?')
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/operator/code-tasks/${encodeURIComponent(taskId)}/merge`, { method: 'POST', body: JSON.stringify({ mergeMethod: 'squash', deploy, confirmDeploy: deploy }) })
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const missions = operator?.missions || []
  const types = operator?.missionTypes || []
  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Operator Mode</h2>
          <p className="text-[12px] text-cream-faint">Личный developer/operator agent: диагностика, deploy, self-heal и custom фоновые задачи через policy/workflows.</p>
        </div>
        <div className={`rounded-full px-2 py-0.5 text-[11px] ${operator?.ok ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-200'}`}>{operator?.ok ? 'ready' : 'attention'}</div>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}

      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="mb-2 text-[13px] font-medium">Mission launcher</div>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            placeholder="Задача для custom operator agent: например, 'проверь почему деплой падает, исправь и задеплой до green health'"
            className="mb-2 w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-[12px] text-cream placeholder:text-cream-faint focus:outline-none"
          />
          <div className="grid gap-2 md:grid-cols-2">
            {types.map((t) => (
              <button key={t.id} disabled={busy} onClick={() => void startMission(t.id)} className="rounded-lg border border-white/10 bg-graphite-900/60 p-2 text-left hover:bg-white/5 disabled:opacity-60">
                <div className="flex items-center justify-between gap-2"><span className="font-medium text-cream">{t.icon} {t.title}</span><span className={`rounded px-1.5 py-0.5 text-[10px] ${t.risk === 'safe' ? 'bg-emerald-500/15 text-emerald-200' : t.risk === 'production-write' ? 'bg-amber-500/15 text-amber-200' : 'bg-violet-500/15 text-violet-200'}`}>{t.risk}</span></div>
                <div className="mt-1 text-[11px] text-cream-faint">{t.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="mb-2 text-[13px] font-medium">Primary project</div>
          {(operator?.projects || []).slice(0, 3).map((p) => (
            <div key={p.id} className="mb-2 rounded-lg border border-white/10 bg-graphite-900/60 p-2 text-[12px]">
              <div className="font-medium text-cream">{p.name}</div>
              <div className="font-mono text-[10px] text-cream-faint">{p.repo}</div>
              <div className="mt-1 text-[11px] text-cream-faint">prod: {p.productionPath}</div>
            </div>
          ))}
          <details className="mt-2 text-[11px] text-cream-faint">
            <summary className="cursor-pointer">Live ops status</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/25 p-2 whitespace-pre-wrap">{JSON.stringify(operator?.status || {}, null, 2).slice(0, 5000)}</pre>
          </details>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-white/10 bg-black/15 p-3">
        <div className="mb-2 text-[13px] font-medium">Recent operator missions</div>
        <div className="space-y-1.5">
          {missions.length === 0 ? <div className="text-[12px] text-cream-faint">No missions yet.</div> : missions.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-graphite-900/60 px-2 py-1.5 text-[12px]">
              <span className="min-w-0 flex-1 truncate text-cream-soft">{m.title}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${pill(m.workflow?.status || m.job?.status || m.codeTask?.status || m.status)}`}>{m.workflow?.status || m.job?.status || m.codeTask?.status || m.status}</span>
              {m.workflowId && <span className="font-mono text-[10px] text-violet-200">wf {m.workflowId.slice(-8)}</span>}
              {m.jobId && <span className="font-mono text-[10px] text-violet-200">job {m.jobId.slice(-8)}</span>}
              {m.result?.codeTaskId && <span className="font-mono text-[10px] text-violet-200">code {m.result.codeTaskId.slice(-8)}</span>}
              {m.codeTask?.status === 'succeeded' && !m.codeTask?.result?.review && (
                <button onClick={() => void reviewCodeTask(m.result.codeTaskId)} className="rounded border border-violet-400/25 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-100 hover:bg-violet-500/20">review</button>
              )}
              {m.codeTask?.result?.review && <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.codeTask.result.review.risk === 'critical' || m.codeTask.result.review.risk === 'high' ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'}`}>risk {m.codeTask.result.review.risk}</span>}
              {m.codeTask?.status === 'succeeded' && !m.codeTask?.result?.finalize?.committed && (
                <button onClick={() => void finalizeCodeTask(m.result.codeTaskId)} className="rounded border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-100 hover:bg-emerald-500/20">commit+PR</button>
              )}
              {m.codeTask?.result?.finalize?.pullRequest?.url && <a href={m.codeTask.result.finalize.pullRequest.url} target="_blank" rel="noreferrer" className="text-[10px] text-emerald-200 underline">PR #{m.codeTask.result.finalize.pullRequest.number}</a>}
              {m.codeTask?.result?.finalize?.pushed && !m.codeTask?.result?.ci?.status && <button onClick={() => void waitCi(m.result.codeTaskId)} className="rounded border border-violet-400/25 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-100 hover:bg-violet-500/20">wait CI</button>}
              {m.codeTask?.result?.ci?.status && <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.codeTask.result.ci.ok ? 'bg-emerald-500/15 text-emerald-200' : 'bg-red-500/15 text-red-200'}`}>CI {m.codeTask.result.ci.status}</span>}
              {m.codeTask?.result?.ci?.status === 'failed' && <button onClick={() => void autoFixCi(m.result.codeTaskId)} className="rounded border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-100 hover:bg-amber-500/20">auto-fix CI</button>}
              {m.codeTask?.result?.ciFix?.status && <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.codeTask.result.ciFix.status === 'succeeded' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-200'}`}>fix {m.codeTask.result.ciFix.status}</span>}
              {m.codeTask?.result?.ci?.ok === true && m.codeTask?.result?.finalize?.pullRequest?.number && !m.codeTask?.result?.merge?.ok && (
                <>
                  <button onClick={() => void mergePr(m.result.codeTaskId, false)} className="rounded border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-100 hover:bg-emerald-500/20">merge</button>
                  <button onClick={() => void mergePr(m.result.codeTaskId, true)} className="rounded border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-100 hover:bg-amber-500/20">merge+deploy</button>
                </>
              )}
              {m.codeTask?.result?.merge?.ok && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-200">merged</span>}
              {m.codeTask?.result?.deployWorkflowId && <span className="font-mono text-[10px] text-amber-200">deploy {m.codeTask.result.deployWorkflowId.slice(-8)}</span>}
              <button onClick={() => setReportTarget({ kind: 'mission', id: m.id })} className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-cream-soft hover:bg-white/5">report</button>
              {m.error && <span className="text-red-200">{m.error}</span>}
              {m.events?.length > 0 && (
                <details className="basis-full">
                  <summary className="cursor-pointer text-[10px] text-cream-faint">timeline ({m.events.length})</summary>
                  <div className="mt-2"><OperatorMissionTimeline events={m.events} /></div>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
      <OperatorReportModal open={Boolean(reportTarget)} kind={reportTarget?.kind} id={reportTarget?.id} onClose={() => setReportTarget(null)} />
    </section>
  )
}
