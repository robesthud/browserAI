import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')

// The loops:
// Promise.all(calls.map(async (call, idx) => { ... }))
// Since we are inside a map() function, we can't `continue` or `break` out of the loop.
// We must `return` from the map callback, but we also want the loop to skip the rest if possible.

// First fix Schema Retry
code = code.replace(
  "            break // Let the outer loop retry it",
  "            return { call, pushedBack: true }"
)

// Second fix Execution Self-Healing
code = code.replace(
  "           break // trigger self-healing loop",
  "           return { call, pushedBack: true }"
)

fs.writeFileSync('server/agentLoop.js', code)
