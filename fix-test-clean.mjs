import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

code = code.replace(
  "const errorEvents = events.filter(e => e.event === 'error'); console.log('ERRORS:', errorEvents);\n    const thoughts = events.filter(e => e.event === 'thought')",
  "const thoughts = events.filter(e => e.event === 'thought')"
)
code = code.replace(
  "const toolResults = events.filter(e => e.event === 'tool_result'); console.log('THOUGHTS:', thoughts, '\\nTOOL RESULTS:', toolResults); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)",
  "const toolResults = events.filter(e => e.event === 'tool_result'); expect(thoughts.some(t => t.includes('Ошибка выполнения'))).toBe(true)"
)
code = code.replace(
  "console.log('SENDING LLM CALL'); ",
  ""
)

fs.writeFileSync('tests/error-recovery.test.js', code)
