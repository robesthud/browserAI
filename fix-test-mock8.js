import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// The test is failing because `cat` of `read_file` is 'read'. Wait, I checked approvalGate.js earlier, `categoryOf('read_file')` is 'read'.
// Is `cat !== 'ask'` true? Yes, 'read' !== 'ask'.
// So why doesn't it push back?
// Ah! In `server/agentLoop.js`:
// `const cat = categoryOf(call.tool)` is on line 1381, inside the `for` loop mapping the results. Wait no, it's inside `Promise.all(calls.map(async (call, idx) => {`
// Let's console.log inside the execution block in `server/agentLoop.js`

code = code.replace(
  "console.log('THOUGHTS:', thoughts); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)",
  "console.log('THOUGHTS:', thoughts, '\\nTOOL RESULTS:', toolResults); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)"
)
fs.writeFileSync('tests/error-recovery.test.js', code)

let loop = fs.readFileSync('server/agentLoop.js', 'utf8')
loop = loop.replace(
  "if (!r.ok && !pushedBackThisTurn && !aborted && cat !== 'ask') {",
  "console.log('EVALUATING HEALING:', { ok: r.ok, pushed: pushedBackThisTurn, aborted, cat }); if (!r.ok && !pushedBackThisTurn && !aborted && cat !== 'ask') {"
)
fs.writeFileSync('server/agentLoop.js', loop)

