import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')

// Remove the debug "agent_state" block and replace it entirely
const agentStateRegex = /\/\/\s*Arena parity:\s*show agent_state[\s\S]*?if\s*\(m\.agentState\s*&&\s*\(m\.agentState\.plan\s*\|\|\s*m\.agentState\.goal\)\)\s*\{\s*items\.push\(\s*<AgentRuntimePanel\s+key=\{`runtime-\$\{m\.id\}`\}\s+state=\{m\.agentState\}\s*\/>\s*\)\s*\}/
code = code.replace(agentStateRegex, `// Live agent_state streaming
                  if (m.agentState) {
                    items.push(<AgentRuntimePanel key={\`runtime-\${m.id}\`} state={m.agentState} aiWorking={aiWorking} />)
                  }`)

fs.writeFileSync('src/components/MessageList.jsx', code)
