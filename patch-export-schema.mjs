import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')

code = code.replace(
  "id: m.id,",
  "schema: 'browserai.agent_trace.v1',\n                  id: m.id,"
)

fs.writeFileSync('src/components/MessageList.jsx', code)
