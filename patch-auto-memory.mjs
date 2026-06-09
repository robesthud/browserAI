import fs from 'fs'
let file = fs.readFileSync('server/agentLoop.js', 'utf8')

const autoMemoryCode = `
  // ── v2.22 Automatic memory integration ─────────────────────────
  // For medium/high complexity tasks, the agent implicitly runs
  // recall_facts (and kb_search if high) before even talking to the
  // provider. This gives it complete context natively, matching Arena.
  if (['medium', 'high'].includes(agentContext?.task?.complexity) && userId) {
    const autoQuery = agentState.goal.slice(0, 300) || ''
    const autoTools = ['recall_facts']
    if (agentContext.task.complexity === 'high' && autoQuery) {
      autoTools.push('kb_search')
    }
    
    // 1. Simulate the assistant asking for these tools
    if (useNativeTools) {
      convo.push({
        role: 'assistant',
        content: 'Проверяю базу знаний и память перед началом...',
        tool_calls: autoTools.map((t, i) => ({
          id: \`auto-mem-\${i}\`,
          type: 'function',
          function: { name: t, arguments: JSON.stringify(t === 'kb_search' ? { query: autoQuery, top_k: 3 } : {}) }
        }))
      })
    } else {
      let xml = 'Проверяю базу знаний и память перед началом...\\n'
      for (const t of autoTools) {
        const argsXml = t === 'kb_search' ? \`<query>\${autoQuery}</query><top_k>3</top_k>\` : ''
        xml += \`<xai:function_call>\\n  <xai:tool_name>\${t}</xai:tool_name>\\n\${argsXml ? \`  <xai:parameters>\\n    \${argsXml}\\n  </xai:parameters>\\n\` : ''}</xai:function_call>\\n\`
      }
      convo.push({ role: 'assistant', content: xml })
    }

    // 2. Execute them and feed the results into context
    for (let idx = 0; idx < autoTools.length; idx++) {
      const toolName = autoTools[idx]
      const args = toolName === 'kb_search' ? { query: autoQuery, top_k: 3 } : {}
      
      sse(res, 'tool_start', { step: 0, sub: idx, name: toolName, args })
      
      const r = await invokeTool(toolName, { ...args, _userId: userId }, {
        signal: abortCtl.signal,
        userId,
        chatId,
        extraTools,
      })
      
      const structuredResult = normalizeToolResult(toolName, r, { step: 0, sub: idx, readBack: true })
      updateAgentStateFromTool(agentState, toolName, r, args)
      
      sse(res, 'tool_result', {
        step: 0, sub: idx, name: toolName, ok: Boolean(r.ok),
        result: r.ok ? r.result : undefined, error: r.ok ? undefined : r.error,
        structured: structuredResult
      })
      
      recentToolHistory.push({ tool: toolName, ok: Boolean(r.ok), at: Date.now() })
      
      const obsRaw = r.ok ? r.result : { error: r.error }
      const obsStr = clipToolOutput(toolName, typeof obsRaw === 'string' ? obsRaw : JSON.stringify(obsRaw, null, 2))
      
      if (useNativeTools) {
        convo.push({ role: 'tool', tool_call_id: \`auto-mem-\${idx}\`, name: toolName, content: obsStr })
      } else {
        convo.push({ role: 'user', content: \`[tool_result name="\${toolName}" ok=\${Boolean(r.ok)}]\\n\${obsStr}\\n[/tool_result]\` })
      }
    }
    sse(res, 'agent_state', agentState)
  }
`

file = file.replace(
  "let pushedBackThisTurn = false\n\n  try {\n    while (step < maxSteps) {",
  "let pushedBackThisTurn = false\n" + autoMemoryCode + "\n  try {\n    while (step < maxSteps) {"
)

fs.writeFileSync('server/agentLoop.js', file)
