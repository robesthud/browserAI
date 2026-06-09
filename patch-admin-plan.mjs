import fs from 'fs'
let code = fs.readFileSync('src/components/AgentAdmin.jsx', 'utf8')

code = code.replace(
  "import AgentAskUser from './AgentAskUser.jsx'",
  "import AgentAskUser from './AgentAskUser.jsx'\nimport AgentPlanCard from './AgentPlanCard.jsx'"
)

const searchString = "const items = []"
const startIdx = code.indexOf("{(() => {\n                    const items = []\n                    const thoughtsByStep = new Map()")
const endString = "return items\n                  })()}"
const endIdx = code.indexOf(endString, startIdx) + endString.length

if (startIdx > -1 && endIdx > startIdx) {
  const foldingLogic = `{(() => {
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

                    if (plan) items.push(<AgentPlanCard key="plan" plan={plan} />)

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
                      const name = tc.name || tc.tool
                      if (name === 'plan_set' || name === 'plan_check') continue
                      items.push(
                        <AgentToolBlock
                          key={\`tool-\${tc.step}-\${name}\`}
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
                        items.push(<AgentThought key={\`th-late-\${step}-\${t.at}\`} text={t.text} />)
                      }
                    }

                    return items
                  })()}`

  code = code.substring(0, startIdx) + foldingLogic + code.substring(endIdx)
  fs.writeFileSync('src/components/AgentAdmin.jsx', code)
} else {
  console.log("Could not find the block to replace", startIdx, endIdx)
}

