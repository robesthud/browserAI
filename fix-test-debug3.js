import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

code = code.replace(
  "console.log('TOOL RESULTS:', toolResults, '\\nEVENTS:', events.map(e => e.event)); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)\n    const toolResults = events.filter(e => e.event === 'tool_result')",
  "const toolResults = events.filter(e => e.event === 'tool_result'); console.log('TOOL RESULTS:', toolResults, '\\nEVENTS:', events.map(e => e.event)); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)"
)
fs.writeFileSync('tests/error-recovery.test.js', code)
