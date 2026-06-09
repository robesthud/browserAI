import fs from 'fs'
let file = fs.readFileSync('server/llmClient.js', 'utf8')

// callGeminiOfficial
file = file.replace(
  "async function callGeminiOfficial({ baseUrl, apiKey, model, messages, temperature = 0.7 }) {",
  "async function callGeminiOfficial({ baseUrl, apiKey, model, messages, temperature = 0.7, tools, toolChoice }) {"
)

file = file.replace(
  "    generationConfig: { temperature, maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 8192) },\n  }",
  `    generationConfig: { temperature, maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 8192) },
  }
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools)
    // if (toolChoice === 'auto') // Gemini defaults to AUTO when tools are present
  }`
)

// Extract Gemini tools from sync response
const syncExtract = `
  const text = []
  const nativeToolCalls = []
  if (data?.candidates?.[0]?.content?.parts) {
    for (const p of data.candidates[0].content.parts) {
      if (p.text) text.push(p.text)
      if (p.functionCall) {
        nativeToolCalls.push({
          id: p.functionCall.name + '-' + Math.random().toString(36).slice(2),
          name: p.functionCall.name,
          args: p.functionCall.args,
          raw: { id: p.functionCall.name + '-' + Math.random().toString(36).slice(2), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) } }
        })
      }
    }
  }
  return {
    text: text.join(''),
    toolCalls: nativeToolCalls,
`

file = file.replace(
  "  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''\n  return {\n    text,\n    toolCalls: [],",
  syncExtract.trim()
)

// callGeminiOfficialStream
file = file.replace(
  "async function callGeminiOfficialStream({\n  baseUrl, apiKey, model, messages, temperature = 0.7, signal,\n  onTextDelta, onUsage,\n}) {",
  "async function callGeminiOfficialStream({\n  baseUrl, apiKey, model, messages, temperature = 0.7, signal,\n  tools, toolChoice, onTextDelta, onToolCallDelta, onUsage,\n}) {"
)

file = file.replace(
  "    generationConfig: { temperature, maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 8192) },\n  }\n  if (system) body.systemInstruction = { parts: [{ text: system }] }",
  `    generationConfig: { temperature, maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 8192) },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools)
  }`
)

// Extract tools from stream
const streamExtract = `
  let buf = ''
  let text = ''
  let usage = null
  const nativeToolCalls = []

  function handleData(payload) {
    if (!payload || payload === '[DONE]') return
    const chunk = safeJsonParse(payload)
    if (!chunk) return
    const parts = chunk?.candidates?.[0]?.content?.parts || []
    for (const p of parts) {
      if (p.text) {
        text += p.text
        try { onTextDelta?.(p.text) } catch { /* ignore */ }
      }
      if (p.functionCall) {
        nativeToolCalls.push({
          id: p.functionCall.name + '-' + Math.random().toString(36).slice(2),
          name: p.functionCall.name,
          args: p.functionCall.args,
          raw: { id: p.functionCall.name + '-' + Math.random().toString(36).slice(2), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) } }
        })
        try { onToolCallDelta?.() } catch { /* ignore */ }
      }
    }
`

file = file.replace(
  /let buf = ''\n  let text = ''\n  let usage = null\n\n  function handleData\(payload\) \{[\s\S]*?for \(const p of parts\) \{[\s\S]*?try \{ onTextDelta\?\.\(p\.text\) \} catch \{ \/\* ignore \*\/ \}\n      \}\n    \}/,
  streamExtract.trim()
)

file = file.replace(
  "  return { text, toolCalls: [], usage }",
  "  return { text, toolCalls: nativeToolCalls, usage }"
)

fs.writeFileSync('server/llmClient.js', file)
