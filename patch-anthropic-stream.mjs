import fs from 'fs'
let file = fs.readFileSync('server/llmClient.js', 'utf8')

file = file.replace(
  "async function callAnthropicOfficialStream({\n  baseUrl, apiKey, model, messages, temperature = 0.7, signal,\n  onTextDelta, onUsage,\n}) {",
  "async function callAnthropicOfficialStream({\n  baseUrl, apiKey, model, messages, temperature = 0.7, signal,\n  tools, toolChoice, onTextDelta, onToolCallDelta, onUsage,\n}) {"
)

file = file.replace(
  "    temperature,\n    stream: true,\n  }\n  if (system) body.system = system",
  `    temperature,
    stream: true,
  }
  if (system) body.system = system
  if (tools && tools.length > 0) {
    body.tools = toAnthropicTools(tools)
    if (toolChoice === 'auto') body.tool_choice = { type: 'auto' }
  }`
)

const handlerReplacement = `
  let currentTool = null
  const nativeToolCalls = []

  function handleData(payload) {
    if (!payload || payload === '[DONE]') return
    const evt = safeJsonParse(payload)
    if (!evt) return
    const delta = evt.delta || {}
    
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      currentTool = {
        id: evt.content_block.id,
        name: evt.content_block.name,
        inputArgs: ''
      }
      onToolCallDelta?.()
    } else if (evt.type === 'content_block_delta' && delta.type === 'input_json_delta') {
      if (currentTool) {
        currentTool.inputArgs += (delta.partial_json || '')
        onToolCallDelta?.()
      }
    } else if (evt.type === 'content_block_stop' && currentTool) {
      let args = {}
      try { args = JSON.parse(currentTool.inputArgs) } catch { /* ignore */ }
      nativeToolCalls.push({
        id: currentTool.id,
        name: currentTool.name,
        args,
        raw: { id: currentTool.id, type: 'function', function: { name: currentTool.name, arguments: currentTool.inputArgs } }
      })
      currentTool = null
    }

    if (evt.type === 'content_block_delta' && delta.type === 'text_delta') {
      const t = delta.text || delta.thinking || ''
      if (t) {
        text += t
        try { onTextDelta?.(t, delta.thinking ? { kind: 'thinking' } : undefined) } catch { /* ignore */ }
      }
    }
    if (evt.type === 'message_delta' && delta.usage) {
      const out = Number(delta.usage.output_tokens || 0)
      usage = { ...(usage || {}), completion: out }
    }
    if (evt.type === 'message_start' && evt.message?.usage) {
      usage = { prompt: Number(evt.message.usage.input_tokens || 0), completion: 0, total: 0 }
    }
  }
`

file = file.replace(
  /function handleData\(payload\) \{[\s\S]*?if \(evt\.type === 'message_start' && evt\.message\?.usage\) \{[\s\S]*?\}\n  \}/,
  handlerReplacement.trim()
)

file = file.replace(
  "  return { text, toolCalls: [], usage }",
  "  return { text, toolCalls: nativeToolCalls, usage }"
)

fs.writeFileSync('server/llmClient.js', file)
