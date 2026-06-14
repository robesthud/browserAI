import { useEffect, useState } from 'react'
import { loadSettings, resolveActive } from '../lib/settings.js'
import AgentRuntimePanel from './AgentRuntimePanel.jsx'
import AgentToolBlock from './AgentToolBlock.jsx'
import Markdown from '../lib/markdown.jsx'
import AgentThought from './AgentThought.jsx'
import AgentAskUser from './AgentAskUser.jsx'
import AutomationCenter from './AutomationCenter.jsx'
import AgentInbox from './AgentInbox.jsx'
import AgentControlPlanePanel from './AgentControlPlanePanel.jsx'
import NotificationCenter from './NotificationCenter.jsx'
import FailureAdvisorPanel from './FailureAdvisorPanel.jsx'
import AutoRecoveryPanel from './AutoRecoveryPanel.jsx'
import OperatorConsole from './OperatorConsole.jsx'
import OperatorMissionDetail from './OperatorMissionDetail.jsx'
import OperatorProjectsPanel from './OperatorProjectsPanel.jsx'
import OperatorRunbooks from './OperatorRunbooks.jsx'
import DeploySessionsPanel from './DeploySessionsPanel.jsx'

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
  const [providerDiag, setProviderDiag] = useState(null)
  const [loadingDiag, setLoadingDiag] = useState(false)
  const [replayTrace, setReplayTrace] = useState(null)
  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem('browserai.agentAdmin.tab') || 'overview' } catch { return 'overview' }
  })

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

  const refreshDiag = async () => {
    setLoadingDiag(true)
    setProviderDiag(null)
    try {
      // Use the real settings store (browserai.settings.v2, keys[] schema).
      // The previous version read a non-existent 'browserai.settings' key with
      // a providers{} schema that never existed -> permanent ERROR panel.
      const settings = loadSettings()
      const active = resolveActive(settings)
      const baseUrl = active.baseUrl
      const apiKey = active.apiKey
      const model = active.model
      if (!baseUrl || !model) throw new Error('Нет активного API-ключа: добавь ключ в Настройках')

      const r = await fetch('/api/agent/provider/diagnose', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          apiKey,
          model,
          runProbe: true
        })
      })
      const data = await r.json()
      setProviderDiag(data)
    } catch (e) {
      setProviderDiag({ ok: false, providerError: { message: e.message } })
    } finally {
      setLoadingDiag(false)
    }
  }

  useEffect(() => { 
    refreshMeta() 
    refreshDiag()
  }, [])

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

  const tabs = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'operator', label: 'Operator', icon: '🛠️' },
    { id: 'projects', label: 'Projects', icon: '🗂️' },
    { id: 'deploys', label: 'Deploys', icon: '🚀' },
    { id: 'automation', label: 'Automation', icon: '⚙️' },
    { id: 'diagnostics', label: 'Diagnostics', icon: '🧪' },
  ]
  const switchTab = (id) => {
    setActiveTab(id)
    try { localStorage.setItem('browserai.agentAdmin.tab', id) } catch { /* ignore */ }
  }

  return (
    <div className="min-h-screen bg-graphite-900 text-cream">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-graphite-900/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
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
        <nav className="mx-auto mt-3 flex max-w-6xl gap-1 overflow-x-auto pb-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-[12px] transition ${activeTab === t.id ? 'border-violet-400/40 bg-violet-500/20 text-violet-100' : 'border-white/10 text-cream-faint hover:bg-white/5 hover:text-cream-soft'}`}
            >
              <span className="mr-1">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">
        {activeTab === 'overview' && (
          <>
            <AgentControlPlanePanel />
            <NotificationCenter />
            <AgentInbox />
          </>
        )}

        {activeTab === 'operator' && (
          <>
            <FailureAdvisorPanel />
            <AutoRecoveryPanel />
            <OperatorConsole />
            <OperatorMissionDetail />
          </>
        )}

        {activeTab === 'projects' && (
          <>
            <OperatorProjectsPanel />
            <OperatorRunbooks />
          </>
        )}

        {activeTab === 'deploys' && <DeploySessionsPanel />}

        {activeTab === 'automation' && <AutomationCenter />}

        {activeTab === 'diagnostics' && (
          <>
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
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-medium">Provider Diagnostics</h2>
                <p className="text-[12px] text-cream-faint">Live check for current active model.</p>
              </div>
              <button
                type="button"
                onClick={refreshDiag}
                disabled={loadingDiag}
                className="rounded-lg border border-white/10 px-2.5 py-1 text-[12px] text-cream-soft hover:bg-graphite-750 disabled:opacity-50"
              >↻</button>
            </div>
            {providerDiag ? (
               <div className="space-y-3">
                 <div className="flex items-center gap-2">
                    <StatusPill ok={Boolean(providerDiag.ok)}>{providerDiag.ok ? 'OK' : 'ERROR'}</StatusPill>
                    <span className="text-[12px] text-cream-faint">{providerDiag.capabilities?.kind || 'unknown'}</span>
                 </div>
                 {providerDiag.providerError && (
                   <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-200">
                     {providerDiag.providerError.message}
                   </div>
                 )}
                 <details>
                   <summary className="cursor-pointer text-[12px] text-cream-faint">Raw JSON</summary>
                   <div className="mt-2"><JsonBlock data={providerDiag} /></div>
                 </details>
               </div>
            ) : <div className="text-[12px] text-cream-faint">загрузка…</div>}
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
                    } catch {
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
                   isDev={true}
                 />
               ) : null}
               
               <div className="space-y-3 mt-4 border-t border-white/10 pt-4">
                  {(() => {
                    const items = []
                    let plan = null
                    for (const tc of replayTrace.tools || []) {
                      if (tc.status !== 'done' || !tc.ok) continue
                      if ((tc.name === 'plan_set' || tc.tool === 'plan_set') && Array.isArray(tc.result?.plan)) {
                        plan = { title: tc.result.title || '', steps: tc.result.plan.map((s) => ({ ...s })) }
                      } else if ((tc.name === 'plan_check' || tc.tool === 'plan_check') && plan && Array.isArray(tc.result?.checked)) {
                        for (const i of tc.result.checked) {
                          const idx = Number(i)
                          const step = plan.steps.find((s) => s.idx === idx)
                          if (step) {
                            step.done = true
                            if (tc.result.note) step.note = tc.result.note
                          }
                        }
                      }
                    }

                    

                    const thoughtsByStep = new Map()
                    for (const t of replayTrace.thoughts || []) {
                      if (!thoughtsByStep.has(t.step)) thoughtsByStep.set(t.step, [])
                      thoughtsByStep.get(t.step).push(t)
                    }

                    for (const tc of replayTrace.tools || []) {
                      const ths = thoughtsByStep.get(tc.step) || []
                      for (const t of ths) {
                        items.push(<AgentThought key={`th-${tc.step}-${t.at}`} text={t.text} />)
                      }
                      thoughtsByStep.delete(tc.step)
                      const name = tc.name || tc.tool
                      if (name === 'plan_set' || name === 'plan_check') continue
                      items.push(
                        <AgentToolBlock
                          key={`tool-${tc.step}-${name}`}
                          toolName={name}
                          args={tc.args}
                          status={tc.status}
                          result={tc.result}
                          error={tc.error}
                          diagnostics={tc.diagnostics}
                          isDev={true}
                        />
                      )
                    }

                    for (const [step, ths] of thoughtsByStep.entries()) {
                      for (const t of ths) {
                        items.push(<AgentThought key={`th-late-${step}-${t.at}`} text={t.text} />)
                      }
                    }

                    return items
                  })()}
               </div>

               {Array.isArray(replayTrace.askUsers) && replayTrace.askUsers.length > 0 && (
                 <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
                    {replayTrace.askUsers.map(q => (
                       <AgentAskUser
                         key={q.id}
                         question={q}
                         answered={true}
                       />
                    ))}
                 </div>
               )}

               {replayTrace.error || replayTrace.providerError ? (
                 <div className="mt-4 border-t border-red-500/20 pt-4 text-red-400">
                   <h3 className="text-[13px] font-medium mb-1">Ошибка</h3>
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
          </>
        )}

      </main>
    </div>
  )
}
