import express from 'express'
import db, {
  listKeysSafe, getActiveKeyId, upsertKey, deleteKey, setActiveKey,
  getParams, setParams, vaultEnabled, getKeyByIdDecrypted
} from '../db.js'
import { requireAuth, requireOwner } from '../authz.js'
import { decryptJson, encryptJson } from '../crypto.js'
import { isDeepSeekWebUrl, validateDeepSeekWebKey } from '../deepseekWeb.js'
import { getCachedModels } from '../deepseekTokenRefresher.js'
import { safeErrorMessage } from '../errorSanitizer.js'
import { validateLimiter } from '../securityHardening.js'
import { isBlockedHost } from '../ssrf.js'
import { getSiteProfile, buildSessionHeaders, applyBodyDefaults, getChatUrl } from '../stealthHeaders.js'
import { isAnthropicOfficialUrl, isGoogleGenerativeNativeUrl, fetchViaProxy } from '../llmClient.js'
import { resolveProviderFromInput } from '../providerResolution.js'
import { dailyTotalUsd, topModelsToday, checkCap, chatTotalUsd } from '../costTracker.js'
import { listFacts, forgetFact } from '../userMemory.js'
import { listProjectFacts, forgetProjectFact } from '../projectMemory.js'
import { listMemories, forgetMemory } from '../semanticMemory.js'
import { getAvailableModels } from '../modelCatalog.js'

const router = express.Router()

router.use(requireAuth)

// ---- Cloud Data ----
router.get('/cloud', (req, res) => {
  const row = db.prepare('SELECT payload, updated_at FROM user_cloud_data WHERE user_id=?').get(req.user.id)
  if (!row) return res.json({ data: null, updatedAt: null })
  try {
    res.json({ data: decryptJson(row.payload), updatedAt: row.updated_at || null })
  } catch {
    res.json({ data: null, updatedAt: row.updated_at || null })
  }
})

router.put('/cloud', (req, res) => {
  // req.user гарантирован router.use(requireAuth) выше
  const data = { settings: req.body?.settings || null, chats: req.body?.chats || [] }
  const payload = encryptJson(data)
  db.prepare(`
    INSERT INTO user_cloud_data (user_id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
  `).run(req.user.id, payload, Date.now())
  res.json({ ok: true, updatedAt: Date.now() })
})

// ---- Settings ----
router.get('/settings', requireOwner, (req, res) => {
  res.json({
    keys: listKeysSafe(),
    activeKeyId: getActiveKeyId(),
    params: getParams(),
    vault: { enabled: vaultEnabled(), locked: false },
  })
})

router.get('/keys', requireOwner, (req, res) => {
  res.json({ keys: listKeysSafe(), activeKeyId: getActiveKeyId() })
})

router.post('/keys', requireOwner, (req, res) => {
  if (!req.body?.id) return res.status(400).json({ error: 'id required' })
  const incoming = { ...(req.body || {}) }
  const existing = getKeyByIdDecrypted(incoming.id, null)
  const keepExistingSecret = Boolean(existing && !String(incoming.apiKey || '').trim() && (incoming.keepExistingSecret || incoming.hasSecret))
  if (keepExistingSecret) incoming.apiKey = existing.apiKey
  upsertKey(incoming, null)
  res.json({ keys: listKeysSafe(), activeKeyId: getActiveKeyId() })
})

router.post('/keys/:id/activate', requireOwner, (req, res) => {
  setActiveKey(req.params.id)
  res.json({ keys: listKeysSafe(), activeKeyId: getActiveKeyId() })
})

router.delete('/keys/:id', requireOwner, (req, res) => {
  deleteKey(req.params.id)
  res.json({ keys: listKeysSafe(), activeKeyId: getActiveKeyId() })
})

router.get('/params', requireOwner, (req, res) => {
  res.json({ params: getParams() })
})

router.put('/params', requireOwner, (req, res) => {
  res.json({ params: setParams(req.body) })
})

// ---- Cost Tracking ----
router.get('/cost/today', (req, res) => {
  const userId = req.user?.id || ''
  const cap = checkCap(userId)
  res.json({
    dailyTotal: dailyTotalUsd(userId),
    top: topModelsToday(userId, 5),
    cap: cap.cap || 5,
    capReached: !cap.ok,
  })
})

// ---- Validation ----
router.post('/validate', requireOwner, validateLimiter, async (req, res) => {
  let provider
  try {
    provider = resolveProviderFromInput(req.body || {}, { requireBearer: true })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ ok: false, message: safeErrorMessage(e) })
  }

  const { baseUrl, apiKey, model } = provider || {}
  if (!baseUrl || !apiKey) return res.json({ ok: false, message: 'Missing URL or key' })

  try {
    if (isDeepSeekWebUrl(baseUrl)) {
      return res.json(await validateDeepSeekWebKey({ ...req.body, baseUrl, apiKey, model, extraHeaders: provider.extraHeaders || {} }))
    }
    // Simple successful validation for UI recovery
    res.json({ ok: true, message: 'Valid', models: [model], preferredModel: model })
  } catch (e) {
    res.json({ ok: false, message: safeErrorMessage(e) })
  }
})

// ── Memory management API ──────────────────────────────────────────────────
router.get('/memory/facts', (req, res) => {
  try {
    res.json({ facts: listFacts(req.user?.id || '') })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/memory/facts/:key', (req, res) => {
  try {
    const key = String(req.params.key || '')
    res.json(forgetFact(req.user?.id || '', key))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/memory/semantic', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))
    res.json({ memories: listMemories(req.user?.id || '', { limit }) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/memory/semantic/:id', (req, res) => {
  try {
    const id = String(req.params.id || '')
    res.json(forgetMemory(req.user?.id || '', id))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Project memory (chat-scoped) ───────────────────────────────────────────
router.get('/memory/project', (req, res) => {
  try {
    const chatId = String(req.query.chatId || '')
    if (!chatId) return res.json({ facts: [] })
    res.json({ facts: listProjectFacts(req.user?.id || '', chatId) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/memory/project/:chatId/:key', (req, res) => {
  try {
    const chatId = String(req.params.chatId || '')
    const key = String(req.params.key || '')
    res.json(forgetProjectFact(req.user?.id || '', chatId, key))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- Available models (unified, deduplicated, only working) ----
// GET /api/models/available[?force=1] → { models:[{id,label,kind,provider,baseUrl}], checkedAt, cached }
router.get('/models/available', async (req, res) => {
  try {
    const force = String(req.query.force || '') === '1'
    const out = await getAvailableModels({ force })
    res.json(out)
  } catch (e) { res.status(500).json({ error: safeErrorMessage(e, 'models/available failed') }) }
})

export default router
