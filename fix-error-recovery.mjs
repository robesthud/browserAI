import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')

// The problem is that the "continue" inside the "for" loop (iterating over "calls")
// only continues the inner "for" loop, not the outer "while" loop.
// To retry the turn, we should set a flag and break out of the for loop,
// then check the flag and continue the while loop.

// First fix Schema Retry
code = code.replace(
  "            continue // Let the outer loop retry it",
  "            break // Let the outer loop retry it"
)

// Second fix Execution Self-Healing
code = code.replace(
  "           continue // trigger self-healing loop",
  "           break // trigger self-healing loop"
)

fs.writeFileSync('server/agentLoop.js', code)
