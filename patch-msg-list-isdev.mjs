import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')

code = code.replace(
  "items.push(<AgentRuntimePanel key={`runtime-${m.id}`} context={m.agentContext} state={m.agentState} aiWorking={aiWorking} />)",
  "items.push(<AgentRuntimePanel key={`runtime-${m.id}`} context={m.agentContext} state={m.agentState} aiWorking={aiWorking} isDev={isDev} />)"
)

fs.writeFileSync('src/components/MessageList.jsx', code)
