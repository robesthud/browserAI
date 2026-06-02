import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8080

const app = express()

// Middleware
app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Простой ответ для проверки
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'running', port: PORT })
})

// Отдаём статику из папки dist (на уровень выше)
const distPath = join(__dirname, '..', 'dist')
app.use(express.static(distPath))

// Все остальные запросы отдаём index.html
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'))
})

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`)
  console.log(`📁 Serving static from: ${distPath}`)
})
