import { useEffect, useState } from 'react'
import AgentRuntimePanel from './AgentRuntimePanel.jsx'
import AgentToolBlock from './AgentToolBlock.jsx'
import Markdown from './Markdown.jsx'

function JsonBlock({ data }) {
  if (!data) return null
  return (
    <pre className="max-h-96 overflow-auto rounded-xl border border-white/10 bg-black/25 p-3 text-[11px] leading-relaxed text-cream-soft">
{JSON.stringify(data, null, 2)}
    </pre>
  )
}

function StatusPill({ ok, children }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
      ok ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
         : 'border-red-400/40 bg-red-500/15 text-red-200'
    }`}>
      {children || (ok ? 'OK' : 'FAIL')}
    </span>
  )
}

export default function AgentAdmin() {
  const [selfTest, setSelfTest] = useState(null)
  const [selfTestLoading, setSelfTestLoading] = useState(false)
  const [health, setHealth] = useState(null)
  const [workspace, setWorkspace] = useState(null)
  const [loadingMeta, setLoadingMeta] = useState(false)
  const [replayTrace, setReplayTrace] = useState(null)

  const refreshMeta = async () => {
    setLoadingMeta(true)
    try {
      const [h, w] = await Promise.all([
        fetch('/api/agent/health', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/workspace/metadata', { credentials: 'include' }).then((r) => r.json()),
      ])
      setHealth(h)
      setWorkspace(w?.metadata || w)
    } catch (e) {
      setHealth({ error: e?.message || String(e) })
    } finally {
      setLoadingMeta(false)
    }
  }

  useEffect(() => { refreshMeta() }, [])

  const runSelfTest = async () => {
    setSelfTestLoading(true)
    setSelfTest(null)
    try {
      const r = await fetch('/api/agent/self-test', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      setSelfTest(await r.json())
    } catch (e) {
      setSelfTest({ ok: false, error: e?.message || String(e) })
    } finally {
      setSelfTestLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-graphite-900 text-cream">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-graphite-900/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Agent Lab</h1>
            <p className="text-[12px] text-cream-faint">Developer diagnostics for BrowserAI Agent Mode</p>
          </div>
          <button
            type="button"
            onClick={() => { window.location.href = '/' }}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-cream-soft hover:bg-graphite-750 hover:text-cream"
          >← В чат</button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-5">
        <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-medium">Self-test / Regression Suite</h2>
              <p className="text-[12px] text-cream-faint">Проверяет runtime-слои без реального LLM-вызова.</p>
            </div>
            <button
              type="button"
              onClick={runSelfTest}
              disabled={selfTestLoading}
              className="rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 disabled:opacity-50"
            >{selfTestLoading ? 'Running…' : 'Run self-test'}</button>
          </div>

          {selfTest && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill ok={Boolean(selfTest.ok)}>{selfTest.ok ? 'PASSED' : 'FAILED'}</StatusPill>
                <span className="font-mono text-[12px] text-cream-faint">
                  {selfTest.passed ?? 0}/{(selfTest.passed ?? 0) + (selfTest.failed ?? 0)} checks
                </span>
                {selfTest.createdAt && <span className="text-[11px] text-cream-faint">{selfTest.createdAt}</span>}
              </div>

              {Array.isArray(selfTest.checks) && (
                <div className="grid gap-1 md:grid-cols-2">
                  {selfTest.checks.map((c) => (
                    <div key={c.name} className={`rounded-lg border px-2.5 py-2 text-[12px] ${
                      c.ok ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                           : 'border-red-400/20 bg-red-500/10 text-red-100'
                    }`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono">{c.ok ? '✓' : '✗'} {c.name}</span>
                        <span className="text-[10px] opacity-70">{c.durationMs}ms</span>
                      </div>
                      {c.error && <div className="mt-1 text-red-200">{c.error}</div>}
                    </div>
                  ))}
                </div>
              )}

              <details>
                <summary className="cursor-pointer text-[12px] text-cream-faint">Raw JSON</summary>
                <div className="mt-2"><JsonBlock data={selfTest} /></div>
              </details>
            </div>
          )}
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-medium">Agent Health</h2>
                <p className="text-[12px] text-cream-faint">Sandbox / browser / managed session.</p>
              </div>
              <button
                type="button"
                onClick={refreshMeta}
                disabled={loadingMeta}
                className="rounded-lg border border-white/10 px-2.5 py-1 text-[12px] text-cream-soft hover:bg-graphite-750 disabled:opacity-50"
              >↻</button>
            </div>
            <JsonBlock data={health} />
          </div>

          <div className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
            <div className="mb-3">
              <h2 className="text-[15px] font-medium">Workspace Metadata</h2>
              <p className="text-[12px] text-cream-faint">Quota, file counts, path/sandbox policy.</p>
            </div>
            {workspace ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div className="rounded-lg bg-black/20 px-2 py-1"><span className="text-cream-faint">files:</span> {workspace.fileCount ?? '—'}</div>
                  <div className="rounded-lg bg-black/20 px-2 py-1"><span className="text-cream-faint">dirs:</span> {workspace.dirCount ?? '—'}</div>
                  <div className="rounded-lg bg-black/20 px-2 py-1"><span className="text-cream-faint">used:</span> {workspace.usedBytes ?? 0} bytes</div>
                  <div className="rounded-lg bg-black/20 px-2 py-1"><span className="text-cream-faint">quota:</span> {workspace.quotaBytes ?? 0} bytes</div>
                </div>
                <details>
                  <summary className="cursor-pointer text-[12px] text-cream-faint">Raw JSON</summary>
                  <div className="mt-2"><JsonBlock data={workspace} /></div>
                </details>
              </div>
            ) : <div className="text-[12px] text-cream-faint">загрузка…</div>}
          </div>
        </section>
      
        <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4 mt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-medium">Replay Agent Trace</h2>
              <p className="text-[12px] text-cream-faint">Загрузите JSON с trace-экспортом для просмотра состояния.</p>
            </div>
            <label className="cursor-pointer rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900">
              Загрузить JSON
              <input 
                type="file" 
                accept=".json" 
                className="hidden" 
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if(!f) return
                  const r = new FileReader()
                  r.onload = (ev) => {
                    try {
                       setReplayTrace(JSON.parse(ev.target.result))
                    } catch(err) {
                       alert('Invalid JSON')
                    }
                  }
                  r.readAsText(f)
                }}
              />
            </label>
          </div>
          {replayTrace && (
            <div className="mt-4 space-y-4 rounded-xl border border-white/10 bg-graphite-900 p-4">
               {replayTrace.agentContext || replayTrace.agentState ? (
                 <AgentRuntimePanel 
                   context={replayTrace.agentContext}
                   state={replayTrace.agentState}
                   protocol={{ version: 1 }}
                   routerWarnings={replayTrace.warnings || []}
                 />
               ) : null}
               {Array.isArray(replayTrace.tools) && replayTrace.tools.length > 0 && (
                 <div className="space-y-2 mt-4 border-t border-white/10 pt-4">
                   <h3 className="text-[13px] font-medium">Инструменты</h3>
                   {replayTrace.tools.map((t, idx) => (
                     <AgentToolBlock key={idx} toolName={t.name || t.tool} args={t.args} result={t.result} error={t.error} isDev={true} />
                   ))}
                 </div>
               )}
               {replayTrace.error || replayTrace.providerError ? (
                 <div className="mt-4 border-t border-red-500/20 pt-4 text-red-400">
                   <h3 className="text-[13px] font-medium">Ошибка</h3>
                   <pre className="text-[11px] whitespace-pre-wrap">{JSON.stringify(replayTrace.providerError || replayTrace.error, null, 2)}</pre>
                 </div>
               ) : null}
               {replayTrace.content && (
                 <div className="mt-4 border-t border-white/10 pt-4">
                   <h3 className="text-[13px] font-medium mb-2">Финальный ответ</h3>
                   <div className="text-[14px] leading-relaxed text-cream-soft"><Markdown text={replayTrace.content} /></div>
                 </div>
               )}
               <details className="mt-4 border-t border-white/10 pt-4">
                  <summary className="text-[12px] cursor-pointer text-cream-faint">Сырой JSON</summary>
                  <JsonBlock data={replayTrace} />
               </details>
            </div>
          )}
        </section>

      </main>
    </div>
  )
}
