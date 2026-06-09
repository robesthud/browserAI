import fs from 'fs'
let code = fs.readFileSync('tests/auto-memory.test.js', 'utf8')
code = code.replace(
  "return {\n    ...actual,\n  return {\n    invokeTool:",
  "return {\n    ...actual,\n    invokeTool:"
)
fs.writeFileSync('tests/auto-memory.test.js', code)
