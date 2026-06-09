import fs from 'fs'
let code = fs.readFileSync('server/llmClient.js', 'utf8')

// Fix sync Gemini
const syncBodyUpdate = `
    generationConfig: {
      temperature,
      maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),
    },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools)
  }
`
code = code.replace(
  /generationConfig: \{[\s\S]*?maxOutputTokens: Number\(process\.env\.BROWSERAI_MAX_OUTPUT_TOKENS \|\| 4096\),[\s\S]*?\},[\s\S]*?\}[\s\S]*?if \(system\) body\.systemInstruction = \{ parts: \[\{ text: system \}\] \}/,
  syncBodyUpdate.trim()
)

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
  const usage = data?.usageMetadata ? {
    prompt: Number(data.usageMetadata.promptTokenCount || 0),
    completion: Number(data.usageMetadata.candidatesTokenCount || 0),
    total: Number(data.usageMetadata.totalTokenCount || 0),
  } : null
  return { text: text.join(''), toolCalls: nativeToolCalls, usage }
`
code = code.replace(
  /const parts = data\?\.candidates\?\.\[0\]\?\.content\?\.parts \|\| \[\][\s\S]*?const text = parts\.map\(\(p\) => p\.text \|\| ''\)\.join\(''\)[\s\S]*?const usage = data\?\.usageMetadata \? \{[\s\S]*?\} : null[\s\S]*?return \{ text, toolCalls: nativeToolCalls, usage \}/,
  syncExtract.trim()
)

// Fix stream Gemini body
const streamBodyUpdate = `
    generationConfig: {
      temperature,
      maxOutputTokens: Number(process.env.BROWSERAI_MAX_OUTPUT_TOKENS || 4096),
    },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools)
  }
`
code = code.replace(
  /generationConfig: \{[\s\S]*?maxOutputTokens: Number\(process\.env\.BROWSERAI_MAX_OUTPUT_TOKENS \|\| 4096\),[\s\S]*?\},[\s\S]*?\}[\s\S]*?if \(system\) body\.systemInstruction = \{ parts: \[\{ text: system \}\] \}/g,
  streamBodyUpdate.trim()
)

fs.writeFileSync('server/llmClient.js', code)
