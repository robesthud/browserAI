import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// If INVOKED TOOL is not printed, it means the tool was never invoked.
// Why wouldn't it be invoked? Because validateToolCall failed?
// Ah! In test 2: args: { path: 'wrong.txt' }
// Does validateToolCall check if the file exists? No.
// But wait, the second test has 't2' and 'wrong.txt'. Let's check the test mock again.

code = code.replace(
  "return { text: '', toolCalls: [{ name: 'read_file', args: { path: 'wrong.txt' }, id: 't2', raw: {} }], usage: {} }",
  "console.log('SENDING LLM CALL'); return { text: '', toolCalls: [{ name: 'read_file', args: { path: 'wrong.txt' }, id: 't2', raw: {} }], usage: {} }"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
