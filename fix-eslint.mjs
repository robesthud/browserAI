import fs from 'fs'
let code = fs.readFileSync('server/llmClient.js', 'utf8')
code = code.replace(
  "async function callGeminiOfficial({ baseUrl, apiKey, model, messages, temperature = 0.7, tools, toolChoice }) {",
  "async function callGeminiOfficial({ baseUrl, apiKey, model, messages, temperature = 0.7, tools }) {"
)
code = code.replace(
  "tools, toolChoice, onTextDelta, onToolCallDelta, onUsage,",
  "tools, onTextDelta, onToolCallDelta, onUsage,"
)
fs.writeFileSync('server/llmClient.js', code)
