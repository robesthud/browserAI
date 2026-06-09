import fs from 'fs'
let file = fs.readFileSync('server/llmClient.js', 'utf8')

file = file.replace(
  "async function callAnthropicOfficial({\n  baseUrl, apiKey, model, messages, temperature = 0.7,\n}) {",
  "async function callAnthropicOfficial({\n  baseUrl, apiKey, model, messages, temperature = 0.7, tools, toolChoice\n}) {"
)

file = file.replace(
  "  const body = {\n    model,\n    messages: toAnthropicMessages(rest),\n    max_tokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),\n    temperature,\n  }",
  `  const body = {
    model,
    messages: toAnthropicMessages(rest),
    max_tokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),
    temperature,
  }
  if (tools && tools.length > 0) {
    body.tools = toAnthropicTools(tools)
    if (toolChoice === 'auto') body.tool_choice = { type: 'auto' }
  }`
)

// Now we need to correctly parse toolCalls from the response in callAnthropicOfficial
file = file.replace(
  "  const text = Array.isArray(data.content)\n    ? data.content.map((b) => b?.text || '').join('')\n    : ''\n  return {\n    text,\n    toolCalls: [],\n    usage: data.usage ? {",
  `  const text = Array.isArray(data.content)
    ? data.content.filter(b => b.type === 'text').map((b) => b?.text || '').join('')
    : ''
  const nativeToolCalls = []
  if (Array.isArray(data.content)) {
    for (const b of data.content) {
      if (b.type === 'tool_use') {
        nativeToolCalls.push({
          id: b.id,
          name: b.name,
          args: b.input,
          raw: { id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }
        })
      }
    }
  }
  return {
    text,
    toolCalls: nativeToolCalls,
    usage: data.usage ? {`
)

fs.writeFileSync('server/llmClient.js', file)
