import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')

const advancedRecoveryCode = `
        const structuredResult = normalizeToolResult(call.tool, r, {
          step, sub: idx, readBack: Boolean(call._readBack),
        })
        
        // ── v2.24 Advanced error recovery (Execution Self-Healing) ──
        // If a file write, bash command, or search fails, don't just dump the 
        // error and move on. Push back so the model notices it and retries 
        // (e.g. creating a missing directory, fixing a bash syntax error).
        if (!r.ok && !pushedBackThisTurn && !aborted && cat !== 'ask') {
           pushedBackThisTurn = true
           sse(res, 'thought', { step, text: \`Ошибка выполнения \${call.tool}. Даю агенту шанс исправить.\` })
           const execErrStr = \`[execution_error]\\nTool '\${call.tool}' failed: \${r.error}\\nConsider this error, fix the parameters or try a different approach.\\n[/execution_error]\`
           if (useNativeTools) {
             convo.push({ role: 'tool', tool_call_id: call.nativeId, name: call.tool, content: execErrStr })
           } else {
             convo.push({ role: 'user', content: execErrStr })
           }
           // We still update state and emit tool_result so the UI shows the red card
           updateAgentStateFromTool(agentState, call.tool, r, call.args || {})
           sse(res, 'tool_result', {
             step, sub: idx,
             name: call.tool,
             ok: Boolean(r.ok),
             result: r.ok ? r.result : undefined,
             error: r.ok ? undefined : r.error,
             structured: structuredResult,
           })
           continue // trigger self-healing loop
        }

        updateAgentStateFromTool(agentState, call.tool, r, call.args || {})
`

code = code.replace(
  /const structuredResult = normalizeToolResult\(call\.tool, r, \{[\s\S]*?step, sub: idx, readBack: Boolean\(call\._readBack\),[\s\S]*?\}\)[\s\S]*?updateAgentStateFromTool\(agentState, call\.tool, r, call\.args \|\| \{\}\)/,
  advancedRecoveryCode.trim()
)

fs.writeFileSync('server/agentLoop.js', code)
