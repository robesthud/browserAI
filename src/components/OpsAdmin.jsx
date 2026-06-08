import { useEffect, useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`))
  return r.json()
}

function StatusPill({ ok, children }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs ${ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{children}</span>
}

export default function OpsAdmin() {
  const [services, setServices] = useState([])
  const [gateway, setGateway] = useState(null)
  const [agentHealth, setAgentHealth] = useState(null)
  const [jobs, setJobs] = useState([])
  const [audit, setAudit] = useState([])
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [ops, gw, ah, js, au] = await Promise.all([
        api('/api/ops/services').catch(() => ({ services: [] })),
        api('/api/gateway/status').catch(() => null),
        api('/api/agent/health').catch(() => null),
        api('/api/jobs?limit=20').catch(() => ({ jobs: [] })),
        api('/api/ops/audit?limit=100').catch(() => ({ entries: [] })),
      ])
      setServices(ops.services || [])
      setGateway(gw)
      setAgentHealth(ah)
      setJobs(js.jobs || [])
      setAudit(au.entries || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const id = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(id)
  }, [])

  const runAction = async (service, action, params = {}, confirm = false) => {
    setResult('Выполняю...')
    try {
      const data = await api('/api/ops/action', {
        method: 'POST',
        body: JSON.stringify({ service, action, params, confirm }),
      })
      const res = data.result || data
      // Dangerous actions come back asking for confirmation. Show a real
      // confirm dialog and re-run with confirm:true if the user agrees,
      // instead of leaving the user staring at requiresConfirmation JSON.
      if (res && res.requiresConfirmation && !confirm) {
        setResult(res.message || 'Требуется подтверждение опасного действия.')
        const okToRun = window.confirm(
          `Опасное действие: ${service}.${action}\n\n${res.message || ''}\n\nВыполнить?`,
        )
        if (okToRun) return runAction(service, action, params, true)
        setResult(`Отменено: ${service}.${action}`)
        return
      }
      setResult(typeof res === 'string' ? res : JSON.stringify(res, null, 2))
      void load()
    } catch (e) {
      setResult(e.message || String(e))
    }
  }

  return (
    <div className="min-h-screen bg-graphite-950 p-4 text-cream">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">BrowserAI Ops</h1>
            <p className="text-sm text-cream-faint">Сервисы, health, jobs, deploy diagnostics</p>
          </div>
          <button onClick={() => void load()} className="rounded-xl border border-white/10 px-3 py-2 text-sm hover:bg-white/5">
            {loading ? 'Обновляю...' : 'Обновить'}</button>
        </div>

        <section className="rounded-2xl border border-white/10 bg-graphite-900/70 p-4">
          <h2 className="mb-3 text-lg font-medium">Status</h2>
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={gateway?.deepseek?.alive}>DeepSeek {gateway?.deepseek?.alive ? 'OK' : 'unknown'}</StatusPill>
            <StatusPill ok={gateway?.gemini?.alive}>Gemini {gateway?.gemini?.alive ? 'OK' : 'unknown'}</StatusPill>
            <StatusPill ok={agentHealth?.sandbox === 'ok'}>Sandbox {agentHealth?.sandbox || 'unknown'}</StatusPill>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-graphite-900/70 p-4">
          <h2 className="mb-3 text-lg font-medium">Services</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {services.map((svc) => (
              <div key={svc.id} className="rounded-xl border border-white/10 bg-graphite-800/60 p-3">
                <div className="mb-2 font-medium">{svc.label || svc.id}</div>
                <div className="flex flex-wrap gap-1.5">
                  {(svc.actions || []).map((a) => (
                    <button
                      key={a.action}
                      onClick={() => void runAction(svc.id, a.action, a.action === 'docker_logs' ? { service: 'browserai', tail: 80 } : {}, false)}
                      className={`rounded-lg border px-2 py-1 text-xs ${a.safe ? 'border-white/10 text-cream-soft hover:bg-white/5' : 'border-amber-400/20 text-amber-300 hover:bg-amber-400/10'}`}
                      title={a.description}
                    >
                      {a.action}{a.safe ? '' : ' ⚠'}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-graphite-900/70 p-4">
          <h2 className="mb-3 text-lg font-medium">Recent jobs</h2>
          <div className="space-y-2">
            {jobs.length === 0 ? <div className="text-sm text-cream-faint">Нет задач</div> : jobs.map((j) => (
              <div key={j.id} className="rounded-lg border border-white/10 p-2 text-sm">
                <div className="flex justify-between gap-2"><span>{j.title || j.type}</span><span className="text-cream-faint">{j.status} · {j.progress}%</span></div>
                {j.error && <div className="mt-1 text-red-300">{j.error}</div>}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-graphite-900/70 p-4">
          <h2 className="mb-3 text-lg font-medium">Audit log <span className="text-xs text-cream-faint">(последние {audit.length})</span></h2>
          {audit.length === 0 ? (
            <div className="text-sm text-cream-faint">Нет записей</div>
          ) : (
            <div className="thin-scroll max-h-80 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-cream-faint">
                  <tr>
                    <th className="py-1 pr-2">Время</th>
                    <th className="py-1 pr-2">Сервис.действие</th>
                    <th className="py-1 pr-2">Статус</th>
                    <th className="py-1 pr-2">exit</th>
                    <th className="py-1 pr-2">мс</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((e, i) => {
                    const st = e.status || ''
                    const stCls = st === 'ok' ? 'text-emerald-300'
                      : st === 'error' || st === 'throw' ? 'text-red-300'
                      : st === 'needs_confirmation' ? 'text-amber-300' : 'text-cream-faint'
                    return (
                      <tr key={i} className="border-t border-white/5">
                        <td className="py-1 pr-2 text-cream-faint">{(e.ts || '').replace('T', ' ').slice(0, 19)}</td>
                        <td className="py-1 pr-2 font-mono">{e.service ? `${e.service}.${e.action}` : (e.raw || '—')}</td>
                        <td className={`py-1 pr-2 ${stCls}`}>{st}{e.error ? ` — ${String(e.error).slice(0, 60)}` : ''}</td>
                        <td className="py-1 pr-2 text-cream-faint">{e.exitCode ?? '—'}</td>
                        <td className="py-1 pr-2 text-cream-faint">{e.ms ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {result && (
          <section className="rounded-2xl border border-white/10 bg-graphite-900/70 p-4">
            <h2 className="mb-3 text-lg font-medium">Result</h2>
            <pre className="thin-scroll max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-black/30 p-3 text-xs text-cream-soft">{result}</pre>
          </section>
        )}
      </div>
    </div>
  )
}
