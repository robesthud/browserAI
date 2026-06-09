import fs from 'fs'
let file = fs.readFileSync('server/llmClient.js', 'utf8')

const newAnthropicHelpers = `
function toAnthropicTools(tools = []) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} }
  }))
}

function toAnthropicMessages(messages = []) {
  const out = []
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue
    
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content || '')
      }
      const prev = out[out.length - 1]
      if (prev?.role === 'user') {
        prev.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const blocks = []
    
    if (m.content) {
      blocks.push(...toAnthropicBlockArray(m.content))
    }
    
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let input = {}
        try { input = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input
        })
      }
    }
    
    if (blocks.length === 0 && !m.tool_calls) {
       blocks.push({ type: 'text', text: '' })
    }

    const prev = out[out.length - 1]
    if (prev?.role === role) {
      if (blocks.length > 0 && blocks[0].type === 'text') {
         prev.content.push({ type: 'text', text: '\\n\\n' })
      }
      prev.content.push(...blocks)
    } else {
      out.push({ role, content: blocks })
    }
  }
  return out
}
`

file = file.replace(
  /function toAnthropicMessages\([\s\S]*?return out\n\}/,
  newAnthropicHelpers.trim()
)

fs.writeFileSync('server/llmClient.js', file)
