import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// The second test is failing execution error because we added { required: true }
// But wait, the second test has args: { path: 'wrong.txt' }, which IS a valid param.
// But now `read_file` is not invoked. Why?
// Ah! In `validation` process, it doesn't just check `required`. If `type` isn't specified, maybe it fails?
code = code.replace(
  "TOOLS: { read_file: { params: { path: { required: true } } } },",
  "TOOLS: { read_file: { params: { path: { type: 'string', required: true } } } },"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
