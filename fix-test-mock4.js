import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

code = code.replace(
  "return {\n    ...actual,\n  return {\n    invokeTool:",
  "return {\n    ...actual,\n    invokeTool:"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
