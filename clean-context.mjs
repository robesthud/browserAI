import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')

const agentContextRegex = /\/\/\s*Arena parity:\s*show agent_context if present[\s\S]*?if\s*\(m\.agentContext\)\s*\{\s*items\.push\([\s\S]*?<\/div>\s*\n?\s*\)\s*\}/
code = code.replace(agentContextRegex, '')

fs.writeFileSync('src/components/MessageList.jsx', code)
