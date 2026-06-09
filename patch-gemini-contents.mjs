import fs from 'fs'
let file = fs.readFileSync('server/llmClient.js', 'utf8')

const newGeminiContents = `
function toGeminiContents(messages = []) {
  const out = []
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue
    
    if (m.role === 'tool') {
      const block = {
        functionResponse: {
          name: m.name || m.tool_call_id || 'unknown',
          response: { content: String(m.content || '') }
        }
      }
      const prev = out[out.length - 1]
      if (prev?.role === 'user') {
        prev.parts.push(block)
      } else {
        out.push({ role: 'user', parts: [block] })
      }
      continue
    }

    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts = []
    
    if (m.content) {
      parts.push(...toGeminiParts(m.content))
    }
    
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
        parts.push({
          functionCall: { name: tc.function.name, args }
        })
      }
    }
    
    if (parts.length === 0 && !m.tool_calls) {
       parts.push({ text: '' })
    }

    const prev = out[out.length - 1]
    if (prev?.role === role) {
      if (parts.length > 0 && parts[0].text) {
         prev.parts.push({ text: '\\n\\n' })
      }
      prev.parts.push(...parts)
    } else {
      out.push({ role, parts })
    }
  }
  return out
}
`

file = file.replace(
  /function toGeminiContents\([\s\S]*?return out\n\}/,
  newGeminiContents.trim()
)

fs.writeFileSync('server/llmClient.js', file)
