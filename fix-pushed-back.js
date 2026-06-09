import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')
code = code.replace(
  "if (res.pushedBack) {\n           pushedBackThisTurn = true\n        }",
  "if (res && res.pushedBack) {\n           pushedBackThisTurn = true\n        }"
)
fs.writeFileSync('server/agentLoop.js', code)
