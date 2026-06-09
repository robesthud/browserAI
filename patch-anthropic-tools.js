const fs = require('fs')
let file = fs.readFileSync('server/llmClient.js', 'utf8')

// 1. Update supportsNativeTools
file = file.replace(
  "export function supportsNativeTools(baseUrl = '') {\n  if (isDeepSeekWebUrl(baseUrl)) return false\n  const u = String(baseUrl).toLowerCase()\n  return (\n    u.includes('api.openai.com')    ||\n    u.includes('open.bigmodel.cn')  ||\n    u.includes('api.deepseek.com')  ||\n    u.includes('api.groq.com')      ||\n    u.includes('api.mistral.ai')    ||\n    u.includes('api.together.xyz')  ||\n    u.includes('openrouter.ai')     ||\n    // Google only supports OpenAI-style tools on its /openai compatibility endpoint.\n    // The official GenerateContent endpoint is handled by the universal XML protocol.\n    (u.includes('generativelanguage.googleapis.com') && u.includes('/openai'))\n  )\n}",
  `export function supportsNativeTools(baseUrl = '') {
  if (isDeepSeekWebUrl(baseUrl)) return false
  const u = String(baseUrl).toLowerCase()
  return (
    u.includes('api.openai.com')    ||
    u.includes('open.bigmodel.cn')  ||
    u.includes('api.deepseek.com')  ||
    u.includes('api.groq.com')      ||
    u.includes('api.mistral.ai')    ||
    u.includes('api.together.xyz')  ||
    u.includes('openrouter.ai')     ||
    u.includes('api.anthropic.com') ||
    u.includes('generativelanguage.googleapis.com')
  )
}`
)

fs.writeFileSync('server/llmClient.js', file)
