import fs from 'fs'
let code = fs.readFileSync('src/components/AgentAdmin.jsx', 'utf8')

code = code.replace(
  "protocol={{ version: 1 }}\n                   routerWarnings={replayTrace.warnings || []}\n                 />",
  "protocol={{ version: 1 }}\n                   routerWarnings={replayTrace.warnings || []}\n                   isDev={true}\n                 />"
)

fs.writeFileSync('src/components/AgentAdmin.jsx', code)
