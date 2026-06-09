import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')
code = code.replace(
  "const toolResults = events.filter(e => e.event === 'tool_result'); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)",
  "const toolResults = events.filter(e => e.event === 'tool_result'); console.log('THOUGHTS:', thoughts); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)"
)
fs.writeFileSync('tests/error-recovery.test.js', code)
