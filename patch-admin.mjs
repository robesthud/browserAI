import fs from 'fs'
let code = fs.readFileSync('src/components/AgentAdmin.jsx', 'utf8')

code = code.replace(
  "import Markdown from './Markdown.jsx'",
  "import Markdown from './Markdown.jsx'\nimport AgentThought from './AgentThought.jsx'\nimport AgentAskUser from './AgentAskUser.jsx'"
)

const viewerReplacement = `
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
               
               <div className="space-y-3 mt-4 border-t border-white/10 pt-4">
                  {(() => {
                    const items = []
                    const thoughtsByStep = new Map()
                    for (const t of replayTrace.thoughts || []) {
                      if (!thoughtsByStep.has(t.step)) thoughtsByStep.set(t.step, [])
                      thoughtsByStep.get(t.step).push(t)
                    }

                    for (const tc of replayTrace.tools || []) {
                      const ths = thoughtsByStep.get(tc.step) || []
                      for (const t of ths) {
                        items.push(<AgentThought key={\`th-\${tc.step}-\${t.at}\`} text={t.text} />)
                      }
                      thoughtsByStep.delete(tc.step)
                      if (tc.name === 'plan_set' || tc.name === 'plan_check') continue
                      items.push(
                        <AgentToolBlock
                          key={\`tool-\${tc.step}-\${tc.name}\`}
                          toolName={tc.name || tc.tool}
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
                        items.push(<AgentThought key={\`th-late-\${step}-\${t.at}\`} text={t.text} />)
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
`

code = code.replace(
  /\{replayTrace && \(\s*<div className="mt-4 space-y-4[\s\S]*?<\/details>\s*<\/div>\s*\)\}/,
  viewerReplacement.trim()
)

fs.writeFileSync('src/components/AgentAdmin.jsx', code)
