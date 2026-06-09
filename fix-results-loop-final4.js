import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')

const replace1 = `      // Update tracking state from THIS round's results so the next
      // iteration's safety nets have fresh data.
      for (const { call, r } of results) {
        recentToolHistory.push({ tool: call.tool, ok: Boolean(r.ok), at: Date.now() })
        if (call.tool === 'plan_set' && r.ok && Array.isArray(r.result?.plan)) {
          planState.done = new Set()
        } else if (call.tool === 'plan_check' && r.ok && Array.isArray(r.result?.checked)) {
          for (const i of r.result.checked) planState.done.add(Number(i))
        }
      }`

const replacement = `      // Update tracking state from THIS round's results so the next
      // iteration's safety nets have fresh data.
      let sawPushBack = false
      for (const res of results) {
        if (!res) continue
        if (res.pushedBack) sawPushBack = true
        if (!res.call || !res.r) continue
        const { call, r } = res
        recentToolHistory.push({ tool: call.tool, ok: Boolean(r.ok), at: Date.now() })
        if (call.tool === 'plan_set' && r.ok && Array.isArray(r.result?.plan)) {
          planState.done = new Set()
        } else if (call.tool === 'plan_check' && r.ok && Array.isArray(r.result?.checked)) {
          for (const i of r.result.checked) planState.done.add(Number(i))
        }
      }
      if (sawPushBack) continue`

code = code.replace(replace1, replacement)

fs.writeFileSync('server/agentLoop.js', code)
