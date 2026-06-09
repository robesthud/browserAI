import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// Is `runAgent` failing because `useNativeTools` is true but `nativeId` is missing?
// Yes! In `agentLoop.js`: `useNativeTools` uses `tc.id` to set `call.nativeId`.
// BUT in my mock toolCall: `id: 't2'`
// Let's console log the error string. Maybe runAgent throws entirely?

code = code.replace(
  "const thoughts = events.filter(e => e.event === 'thought')",
  "const errorEvents = events.filter(e => e.event === 'error'); console.log('ERRORS:', errorEvents);\n    const thoughts = events.filter(e => e.event === 'thought')"
)
fs.writeFileSync('tests/error-recovery.test.js', code)
