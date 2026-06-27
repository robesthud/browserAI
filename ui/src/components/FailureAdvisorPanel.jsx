import { useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`)
    err.data = data
    throw err
  }
  return data
}

function tone(sev) {
  if (sev === 'critical' || sev === 'high') return 'bg-red-500/15 text-red-200 border-red-400/30'
  if (sev === 'medium') return 'bg-amber-500/15 text-amber-200 border-amber-400/30'
  return 'bg-emerald-500/15 text-emerald-200 border-emerald-400/30'
}

export default function FailureAdvisorPanel() {
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const classify = async () => {
    setBusy(true); setError('')
    try { setResult(await api('/api/operator/failure/classify', { method: 'POST', body: JSON.stringify({ error: text, logs: text, title: 'Manual failure analysis', source: 'manual' }) })) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const createIncident = async () => {
    setBusy(true); setError('')
    try { setResult(await api('/api/operator/failure/incident', { method: 'POST', body: JSON.stringify({ error: text, logs: text, title: `Manual: ${result?.classification?.category || 'failure'}`, source: 'manual' }) })) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const execute = async () => {
    const rec = result?.recommendation
    const needs = rec?.requiresApproval
    const ok = !needs || window.confirm(`Execute recommended action?\n\n${rec.description}`)
    if (!ok) return
    setBusy(true); setError('')
    try { setResult(await api('/api/operator/failure/execute', { method: 'POST', body: JSON.stringify({ input: { error: text, logs: text, title: 'Manual failure auto-fix', source: 'manual' }, confirm: needs }) })) }
    catch (e) { setError(e.message); if (e.data) setResult(e.data) }
    finally { setBusy(false) }
  }

  const c = result?.classification
  const r = result?.recommendation
  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3">
        <h2 className="text-[15px] font-medium">Failure Advisor</h2>
        <p className="text-[12px] text-cream-faint">Классифицирует ошибки/логи и предлагает безопасный следующий шаг: diagnostic, code task, CI auto-fix, deploy session или approval.</p>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Вставь ошибку, лог деплоя, CI output, stack trace…" className="w-full rounded-xl border border-white/10 bg-graphite-900 p-3 font-mono text-[12px] text-cream placeholder:text-cream-faint focus:outline-none" />
      <div className="mt-2 flex flex-wrap gap-2">
        <button disabled={!text.trim() || busy} onClick={() => void classify()} className="rounded border border-violet-400/25 bg-violet-500/10 px-3 py-1.5 text-[12px] text-violet-100 disabled:opacity-50">Classify</button>
        <button disabled={!c || busy} onClick={() => void createIncident()} className="rounded border border-amber-400/25 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-100 disabled:opacity-50">Create incident</button>
        <button disabled={!r || busy} onClick={() => void execute()} className="rounded border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-100 disabled:opacity-50">Execute recommendation</button>
      </div>
      {c && (
        <div className="mt-3 rounded-xl border border-white/10 bg-black/15 p-3 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 ${tone(c.severity)}`}>{c.category}</span>
            <span className="text-cream-faint">severity: {c.severity} · confidence: {Math.round((c.confidence || 0) * 100)}%</span>
          </div>
          {r && <div className="mt-2 text-cream-soft">{r.description}</div>}
          {r?.recommended?.length > 0 && <ul className="mt-2 list-disc pl-5 text-cream-faint">{r.recommended.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          <details className="mt-2"><summary className="cursor-pointer text-cream-faint">raw</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/25 p-2 text-[11px]">{JSON.stringify(result, null, 2)}</pre></details>
        </div>
      )}
    </section>
  )
}
