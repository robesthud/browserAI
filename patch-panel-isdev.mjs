import fs from 'fs'
let code = fs.readFileSync('src/components/AgentRuntimePanel.jsx', 'utf8')

code = code.replace(
  "export default function AgentRuntimePanel({ context, state, aiWorking }) {",
  "export default function AgentRuntimePanel({ context, state, aiWorking, isDev }) {"
)

code = code.replace(
  "{/* P3-02 Context Visibility */}\n          {context && (",
  "{/* P3-02 Context Visibility */}\n          {isDev && context && ("
)

fs.writeFileSync('src/components/AgentRuntimePanel.jsx', code)
