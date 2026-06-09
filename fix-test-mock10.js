import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// The first test is now failing because it doesn't push back on schema error.
// The `validation.ok` must be true.
// Why would `validation.ok` be true?
// `validateToolCall` checks `toolDef.params`. But we mocked `TOOLS: { read_file: {} }`, which means no params are required.
// So `args: {}` is perfectly valid!
// We need to make it require a param.
code = code.replace(
  "TOOLS: { read_file: {} },",
  "TOOLS: { read_file: { params: { path: { required: true } } } },"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
