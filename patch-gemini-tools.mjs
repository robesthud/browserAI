import fs from 'fs'
let file = fs.readFileSync('server/llmClient.js', 'utf8')

const newGeminiHelpers = `
function toGeminiTools(tools = []) {
  if (!tools || tools.length === 0) return []
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} }
    }))
  }]
}

function normalizeGeminiModel(model = '') {
`

file = file.replace(
  "function normalizeGeminiModel(model = '') {",
  newGeminiHelpers.trim() + "\n"
)

fs.writeFileSync('server/llmClient.js', file)
