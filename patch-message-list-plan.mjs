import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')

// Remove pass 1 & pass 2 manual plan extraction
const planExtractionRegex = /\/\/\s*───\s*Pass 1:[\s\S]*?const totalSteps = stepIds\.size/
code = code.replace(planExtractionRegex, 'const items = []')

const planCardPushRegex = /const items = \[\]\s*if \(plan\) items\.push\(<AgentPlanCard key="plan" plan=\{plan\} \/>\)\s*if \(isDev && totalSteps > 1 && aiWorking\) \{\s*items\.push\([\s\S]*?\)\s*\}/
code = code.replace(planCardPushRegex, 'const items = []')

// Make sure AgentRuntimePanel is always shown if there's agentState
const runtimePanelRegex = /\{m\.agentState && \(m\.agentState\.plan \|\| m\.agentState\.goal\)\s*\?\s*\(\s*<AgentRuntimePanel\s+key=\{`runtime-\$\{m\.id\}`\}\s+state=\{m\.agentState\}\s*\/>\s*\)\s*:\s*null\}/g
code = code.replace(runtimePanelRegex, '{m.agentState && <AgentRuntimePanel key={`runtime-${m.id}`} state={m.agentState} aiWorking={aiWorking} />}')

const devRuntimeRegex = /\{isDev && \(\s*<AgentRuntimePanel\s+context=\{m\.agentContext\}\s+state=\{m\.agentState\}\s+protocol=\{m\.streamProtocol\}\s+routerWarnings=\{m\.routerWarnings \|\| \[\]\}\s*\/>\s*\)\}/g
code = code.replace(devRuntimeRegex, '')

fs.writeFileSync('src/components/MessageList.jsx', code)
