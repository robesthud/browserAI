import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// The execution test is still not passing `validation.ok` because we mocked `extraTools` maybe?
// Wait, `extraTools` is not passed in the `runAgent` opts in the test.
// So `TOOLS` must have `read_file`. But `server/agentLoop.js` imports `TOOLS` from `server/agentTools.js`.
// And we mocked `agentTools`! So `TOOLS` inside `agentLoop.js` is what we return from our mock!
// Let's add it carefully.

code = code.replace(
  "TOOLS: { read_file: { params: { path: { type: 'string', required: true } } } },",
  "TOOLS: { read_file: { params: { path: { type: 'string', required: true } } }, bash: { params: { command: { type: 'string', required: true } } } },"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
