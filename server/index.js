import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import { ensureWorkspaceRoot } from './workspace.js'
import { initJobs } from './jobs.js'
import { initAgentWorkflows } from './agentWorkflows.js'
import { initIncidents } from './incidents.js'
import { initOperatorMode } from './operatorMode.js'
import { initDeploySessions } from './deploySessions.js'
import { initGithubAutomation } from './githubAutomation.js'
import { initNotifications } from './notifications.js'
import { initAutonomousRecovery, startRecoverySupervisor } from './autonomousRecovery.js'
import { startCronWorker } from './cron.js'
import { startBackupScheduler } from './backup.js'
import { startProductionWatchdog } from './productionWatchdog.js'
import { bootstrap as bootstrapDeepSeekSession } from './deepseekTokenRefresher.js'
import { bootstrap as bootstrapZaiSession } from './zaiTokenRefresher.js'
import { startTelegramBot } from './telegramBot.js'

// Import Routes
import authRoutes, { getSessionUser } from './routes/auth.js'
import workspaceRoutes from './routes/workspace.js'
import agentRoutes from './routes/agent.js'
import jobsRoutes from './routes/jobs.js'
import operatorRoutes from './routes/operator.js'
import settingsRoutes from './routes/settings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8080

const app = express()
app.set('trust proxy', 1)

app.use(helmet({ hsts: false, crossOriginOpenerPolicy: false, contentSecurityPolicy: false }))
// A — CORS: reflect origin only if it matches CORS_ORIGIN env (or localhost in dev).
// 'origin: true' (reflect-all) + credentials:true = any site can make credentialed XHR → CSRF.
const _allowedOrigin = process.env.CORS_ORIGIN || ''
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, mobile apps, same-origin)
    if (!origin) return cb(null, true)
    // Allow explicitly configured origin
    if (_allowedOrigin && origin === _allowedOrigin) return cb(null, true)
    // Allow localhost variants, or the server's own IP/host in development/production if no CORS_ORIGIN is specified
    if (!_allowedOrigin && (/^https?:\/\/(localhost|127\.0\.0\.1|186\.246\.31\.78)(:\d+)?$/.test(origin))) return cb(null, true)
    // Deny all others
    cb(null, false)
  },
  credentials: true,
}))
app.use(express.json({ limit: '4mb' }))   // C — was 50mb (DoS vector); large file uploads use multipart, not JSON

// Auth Middleware
app.use((req, res, next) => {
  req.user = getSessionUser(req)
  next()
})

// Mounting
// D — /api/health must be registered BEFORE agentRoutes (which has its own /health that requires auth)
app.get('/api/health', (req, res) => res.json({ ok: true }))

app.use('/api/auth', authRoutes)
app.use('/api/workspace', workspaceRoutes)
app.use('/api/agent', agentRoutes)
app.use('/api/jobs', jobsRoutes)
app.use('/api/operator', operatorRoutes)
app.use('/api', agentRoutes)    // Mount agentRoutes at /api too for /api/chat
app.use('/api', settingsRoutes) // Mount settingsRoutes at /api for /api/settings, /api/cloud, etc.

// Static frontend
const distDir = join(__dirname, '..', 'dist')
if (existsSync(distDir)) {
  // Hashed assets — кешируем на 1 год (имя содержит хэш, меняется при каждой сборке)
  app.use('/assets', express.static(join(distDir, 'assets'), { maxAge: '1y', immutable: true }))
  // index.html — никогда не кешировать, браузер всегда получает свежий
  app.use(express.static(distDir, { maxAge: 0, etag: true, lastModified: true }))
  app.get(/^\/(?!api)/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(join(distDir, 'index.html'))
  })
}

const httpServer = app.listen(PORT, async () => {
  console.log(`BrowserAI Core listening on ${PORT}`)
  try {
    await ensureWorkspaceRoot(); initJobs(); initAgentWorkflows(); initIncidents()
    initOperatorMode(); initDeploySessions(); initGithubAutomation()
    initNotifications(); initAutonomousRecovery(); bootstrapDeepSeekSession()
  bootstrapZaiSession()

    // Approach 7 — start scheduled task supervisors (each gated by env var
    // so test environments can disable them). These are critical for:
    //   - autonomous recovery (every 30s by default)
    //   - cron user-defined jobs (every 60s)
    //   - daily backups (24h interval, 90s initial delay)
    //   - production watchdog (long-running liveness checks)
    if (process.env.AUTONOMOUS_RECOVERY_ENABLED !== '0') startRecoverySupervisor()
    if (process.env.CRON_WORKER_ENABLED !== '0') startCronWorker()
    if (process.env.BACKUP_SCHEDULER_ENABLED !== '0') startBackupScheduler()
    if (process.env.PRODUCTION_WATCHDOG_ENABLED !== '0') startProductionWatchdog()
    startTelegramBot().catch((e) => console.error('[tg-v2] start failed:', e))
  } catch (e) { console.error('Init failed:', e.message) }
})
