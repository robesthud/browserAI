import { runAgent } from './server/agentLoop.js'
import express from 'express'
const app = express()
app.get('/', async (req, res) => {
  await runAgent({
    provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'mock', model: 'gpt-4' },
    history: [{ role: 'user', content: 'hello' }],
    res
  })
})
console.log("Syntax is OK")
