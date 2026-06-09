import fs from 'fs'
let code = fs.readFileSync('server/agentLoop.js', 'utf8')

const errorRecoveryCode = `
        const validation = validateToolCall(call.tool, call.args || {}, toolDef)
        if (!validation.ok) {
          const r0 = makeToolErrorResult(validation.error, { warnings: validation.warnings })
          
          // ── v2.24 Advanced error recovery (Schema Retry) ──
          // If the model messed up the tool arguments (missing required, 
          // wrong type, hallucinated property), don't just log it and fail. 
          // Give it a loud, specific warning and push back ONCE per turn 
          // to let it self-correct natively.
          if (!pushedBackThisTurn && !aborted) {
            pushedBackThisTurn = true
            sse(res, 'tool_result', {
              step, sub: idx, name: call.tool, ok: false,
              error: r0.error, structured: normalizeToolResult(call.tool, r0, { step, sub: idx, readBack: false }), router: { validation },
            })
            sse(res, 'thought', { step, text: \`ОШИБКА СХЕМЫ \${call.tool}: \${validation.error}. Запрашиваю исправление.\` })
            
            const schemaErrStr = \`[schema_validation_error]\\nTool '\${call.tool}' rejected your arguments: \${validation.error}\\nFix the arguments and try again.\\n[/schema_validation_error]\`
            if (useNativeTools) {
              // We must complete the native tool roundtrip before pushing back
              convo.push({ role: 'tool', tool_call_id: call.nativeId, name: call.tool, content: schemaErrStr })
            } else {
              convo.push({ role: 'user', content: schemaErrStr })
            }
            continue // Let the outer loop retry it
          }

          // If we already pushed back this turn, or it's aborted, fall through to hard failure
          const structuredResult = normalizeToolResult(call.tool, r0, { step, sub: idx, readBack: Boolean(call._readBack) })
          updateAgentStateFromTool(agentState, call.tool, r0, call.args || {})
`

code = code.replace(
  /const validation = validateToolCall\(call\.tool, call\.args \|\| \{\}, toolDef\)[\s\S]*?if \(\!validation\.ok\) \{[\s\S]*?const r0 = makeToolErrorResult\(validation\.error, \{ warnings: validation\.warnings \}\)[\s\S]*?const structuredResult = normalizeToolResult\(call\.tool, r0, \{ step, sub: idx, readBack: Boolean\(call\._readBack\) \}\)[\s\S]*?updateAgentStateFromTool\(agentState, call\.tool, r0, call\.args \|\| \{\}\)/,
  errorRecoveryCode.trim()
)

fs.writeFileSync('server/agentLoop.js', code)
