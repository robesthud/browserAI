import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')

// When the inner map returns { call, pushedBack: true }, we need the outer loop to recognize it.
// The map runs concurrently, so multiple tools might try to push back.
// We handle that in the for (const res of results) loop.

const findStr = "      let sawOk = false\n      let sawAsk = false\n      const askData = []\n      for (const { call, r } of results) {\n        if (!call || !r) continue"
const fixStr = "      let sawOk = false\n      let sawAsk = false\n      const askData = []\n      for (const res of results) {\n        if (res && res.pushedBack) { pushedBackThisTurn = true; continue }\n        if (!res || !res.call || !res.r) continue\n        const { call, r } = res"

code = code.replace(findStr, fixStr)

fs.writeFileSync('server/agentLoop.js', code)
