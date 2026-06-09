const fs = require('fs')
let file = fs.readFileSync('tests/sse-stream-shape.test.js', 'utf8')
file = file.replace(
  "vi.mock('../server/agentTools.js', () => {",
  "vi.mock('../server/agentTools.js', async (importOriginal) => {\n  const actual = await importOriginal()\n  return {\n    ...actual,"
)
file = file.replace(
  "name: 'bash'",
  "name: 'read_file'"
)
file = file.replace(
  "args: { command: 'echo \"hello\"', timeout: 120 }",
  "args: { path: 'notes.txt' }"
)
fs.writeFileSync('tests/sse-stream-shape.test.js', file)
