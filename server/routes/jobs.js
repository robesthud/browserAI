import express from 'express'
import { requireAuth } from '../authz.js'
import { safeErrorMessage } from '../errorSanitizer.js'
import { createJob, getJob, listJobs, startJob, cancelJob, retryJob, registerRuntimeInput } from '../jobs.js'

const router = express.Router()
router.use(requireAuth)

function canAccessJob(req, job) {
  if (!job) return false
  if (req.user?.role === 'owner') return true
  return String(job.userId || '') === String(req.user?.id || '')
}

router.get('/', (req, res) => {
  const jobs = listJobs({
    chatId: req.query.chatId || '',
    userId: req.user?.role === 'owner' ? '' : req.user?.id || '',
    limit: Math.max(1, Math.min(200, Number(req.query.limit) || 50)),
  })
  res.json({ jobs })
})

router.get('/:id', (req, res) => {
  const job = getJob(req.params.id)
  if (!job || !canAccessJob(req, job)) return res.status(404).json({ error: 'Not found' })
  res.json({ job })
})

router.post('/agent', (req, res) => {
  try {
    const body = req.body || {}
    const chatId = String(body.chatId || '')
    const history = Array.isArray(body.history) ? body.history : []
    const provider = {
      keyId: String(body.keyId || ''),
      useStoredSecret: Boolean(body.useStoredSecret),
      baseUrl: String(body.baseUrl || ''),
      authType: String(body.authType || 'bearer'),
      authHeader: String(body.authHeader || ''),
      // A — sanitize extraHeader values: strip CRLF to prevent header-injection
      extraHeaders: (() => {
        const raw = body.extraHeaders
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
        const safe = {}
        for (const [k, v] of Object.entries(raw)) {
          const ks = String(k || '').replace(/[\r\n]/g, '').slice(0, 128)
          const vs = String(v ?? '').replace(/[\r\n]/g, '').slice(0, 1024)
          if (ks) safe[ks] = vs
        }
        return safe
      })(),
      model: String(body.model || ''),
      temperature: Number(body.temperature ?? 0.3),
    }
    const inlineRuntimeProvider = {
      ...provider,
      apiKey: String(body.apiKey || ''),
    }
    const persistedInput = {
      prompt: String(body.prompt || ''),
      title: String(body.title || body.prompt || 'Background agent').slice(0, 200),
      extraSystem: String(body.extraSystem || ''),
      history,
      provider,
    }
    const job = createJob({ userId: req.user?.id || '', chatId, type: 'agent_run', title: persistedInput.title, input: persistedInput })
    if (inlineRuntimeProvider.apiKey) registerRuntimeInput(job.id, { provider: inlineRuntimeProvider })
    startJob(job.id)
    res.json({ job: getJob(job.id) })
  } catch (e) {
    res.status(400).json({ error: safeErrorMessage(e) })
  }
})

router.post('/tool', (req, res) => {
  try {
    const body = req.body || {}
    const tool = String(body.tool || '').trim()
    if (!tool) return res.status(400).json({ error: 'tool required' })
    const job = createJob({
      userId: req.user?.id || '',
      chatId: String(body.chatId || ''),
      type: `tool_${tool}`,
      title: String(body.title || tool),
      input: {
        tool,
        args: body.args && typeof body.args === 'object' ? body.args : {},
      },
    })
    startJob(job.id)
    res.json({ job: getJob(job.id) })
  } catch (e) {
    res.status(400).json({ error: safeErrorMessage(e) })
  }
})

router.post('/:id/cancel', (req, res) => {
  const job = getJob(req.params.id)
  if (!job || !canAccessJob(req, job)) return res.status(404).json({ error: 'Not found' })
  res.json({ job: cancelJob(job.id) })
})

router.post('/:id/retry', (req, res) => {
  const job = getJob(req.params.id)
  if (!job || !canAccessJob(req, job)) return res.status(404).json({ error: 'Not found' })
  const next = retryJob(job.id)
  res.json({ job: next })
})

export default router
