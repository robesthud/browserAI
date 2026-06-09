import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')

const fallbackCode = `
                  // Legacy fallback for old chats without saved agentState
                  if (!m.agentState) {
                    let plan = null
                    for (const tc of m.toolCalls || []) {
                      if (tc.status !== 'done' || !tc.ok) continue
                      if (tc.name === 'plan_set' && Array.isArray(tc.result?.plan)) {
                        plan = { title: tc.result.title || '', steps: tc.result.plan.map((s) => ({ ...s })) }
                      } else if (tc.name === 'plan_check' && plan && Array.isArray(tc.result?.checked)) {
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
                  }

                  for (const tc of m.toolCalls || []) {
`

code = code.replace(
  "                  for (const tc of m.toolCalls || []) {",
  fallbackCode.trim()
)

fs.writeFileSync('src/components/MessageList.jsx', code)
