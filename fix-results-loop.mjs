import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')

// The problem is that the map() callback returns { call, r, pushedBack: true }
// but the parent loop sets pushedBackThisTurn = true and calls continue
// We need to verify exactly how it's written now

// Actually, wait, let me grep it
