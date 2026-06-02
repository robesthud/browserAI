// Express-бэкенд BrowserAI.
// - REST API для CRUD ключей и параметров (SQLite через db.js)
// - Опциональное шифрование ключей мастер-паролем (vault, см. crypto.js)
// - Автоблокировка по таймауту бездействия
// - Экспорт/импорт зашифрованного бэкапа БД
// - Проверка валидности ключа на стороне сервера (нет проблем с CORS)
// - В production отдаёт собранный фронтенд из ../dist

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { isIP as isIp } from 'is-ip'
import ipaddr from 'ipaddr.js'
import AdmZip from 'adm-zip'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  listKeys,
  getActiveKeyId,
  getActiveKeyDecrypted,
  upsertKey,
  deleteKey,
  setActiveKey,
  replaceKeys,
  reencryptAll,
  getParams,
  setParams,
  getVault,
  vaultEnabled,
  getMeta,
  setMeta,
  delMeta,
  dumpRawKeys,
  restoreRawKeys,
} from './db.js'
import {
  generateSalt,
  deriveKey,
  makeVerifier,
  checkVerifier,
} from './crypto.js'
import {
  ensureWorkspaceRoot,
  getWorkspaceTree,
  readWorkspaceFile,
  createFolder,
  createFile,
  writeFileContent,
  renameItem,
  deleteItem,
  moveItem,
  uploadFiles,
  uploadFromUrl,
  searchWorkspaceContent,
  getFileHistory,
  restoreFileRevision,
  streamWorkspaceFile,
  statWorkspaceItem,
  getDownloadName,
  safePath,
} from './workspace.js'
import { searchWeb, fetchWebPage } from './web.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8787

function isPrivateIp(address) {
  if (!isIp(address)) return false
  const addr = ipaddr.parse(address)
  return addr.range() !== 'unicast' || addr.isLoopback() || addr.isLinkLocal()
}

// Rate limiting: 100 запросов на IP за 15 минут
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down' }
})

// Мастер-ключ хранилища держим ТОЛЬКО в памяти, пока разблокировано.
let unlockedKey = null
let lastActivity = Date.now()

const app = express()
app.set('trust proxy', 1)
app.use(helmet())
app.use(limiter)
// Do not hard-code localhost in production: Vite emits crossorigin assets,
// and a mismatched Access-Control-Allow-Origin header makes browsers block JS/CSS.
app.use(process.env.CORS_ORIGIN ? cors({ origin: process.env.CORS_ORIGIN }) : cors())
app.use(express.json({ limit: '50mb' }))

function encKey() {
  return vaultEnabled() ? unlockedKey : null
}
function isLocked() {
  return vaultEnabled() && !unlockedKey
}

function normalizeModels(data) {
  if (!Array.isArray(data?.data)) return []
  return [...new Set(data.data.map((item) => String(item?.id || '').trim()).filter(Boolean))]
}

function scoreModel(id) {
  const v = String(id || '').toLowerCase()
  let score = 0

  if (/(gpt|claude|chat|instruct|qwen|deepseek|gemini|llama|mistral|yi|grok|kimi|command|sonnet|haiku|opus)/.test(v)) {
    score += 100
  }
  if (/(embed|embedding|rerank|rank|moderation|whisper|tts|speech|transcri|audio|image)/.test(v)) {
    score -= 120
  }
  if (/(mini|small|turbo|lite|flash|instant)/.test(v)) {
    score += 10
  }
  if (/(vision|vl)/.test(v)) {
    score += 5
  }

  return score
}

function rankModels(models = [], requestedModel = '') {
  const unique = [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))]
  const requested = String(requestedModel || '').trim()
  return unique.sort((a, b) => {
    if (a === requested) return -1
    if (b === requested) return 1
    const diff = scoreModel(b) - scoreModel(a)
    return diff || a.localeCompare(b)
  })
}

async function probeChatModel(root, apiKey, model) {
  const r = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
  })

  if (r.ok) return { ok: true }
  let detail = ''
  try {
    const j = await r.json()
    detail = j?.error?.message || ''
  } catch {
    /* ignore */
  }
  return { ok: false, status: r.status, detail }
}

async function fetchModels(baseUrl, apiKey, requestedModel = '') {
  // Блокировка private IP и localhost
  let hostname
  try {
    const url = new URL(baseUrl)
    hostname = url.hostname
  } catch {
    return { ok: false, status: 400, models: [], preferredModel: '', error: 'Invalid URL' }
  }
  if (isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
    return { ok: false, status: 403, models: [], preferredModel: '', error: 'Access to internal networks is not allowed' }
  }

  const root = String(baseUrl).replace(/\/$/, '')
  const r = await fetch(`${root}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!r.ok) {
    return { ok: false, status: r.status, models: [], preferredModel: '' }
  }

  try {
    const data = await r.json()
    const models = normalizeModels(data)
    const ranked = rankModels(models, requestedModel)
    const preferredCandidates = ranked.slice(0, 8)
    for (const candidate of preferredCandidates) {
      const probe = await probeChatModel(root, apiKey, candidate)
      if (probe.ok) {
        return { ok: true, models, preferredModel: candidate }
      }
      if (probe.status === 401 || probe.status === 403) {
        return { ok: false, status: probe.status, models, preferredModel: '' }
      }
    }
    return {
      ok: true,
      models,
      preferredModel: ranked[0] || String(requestedModel || '').trim() || '',
    }
  } catch {
    return { ok: true, models: [], preferredModel: String(requestedModel || '').trim() || '' }
  }
}

// Автоблокировка: 0 = выкл, иначе минуты бездействия
function autoLockMinutes() {
  const v = parseInt(getMeta('vault_autolock') || '0', 10)
  return Number.isFinite(v) && v > 0 ? v : 0
}
function setAutoLockMinutes(min) {
  setMeta('vault_autolock', String(Math.max(0, parseInt(min, 10) || 0)))
}
// Отметить активность (продлевает таймер)
function touch() {
  lastActivity = Date.now()
}
// Сколько секунд осталось до автоблокировки (или null)
function autoLockRemaining() {
  const min = autoLockMinutes()
  if (!min || isLocked() || !vaultEnabled()) return null
  const elapsed = (Date.now() - lastActivity) / 1000
  return Math.max(0, Math.round(min * 60 - elapsed))
}
// Фоновая проверка: блокируем при простое
setInterval(() => {
  const min = autoLockMinutes()
  if (min && unlockedKey && Date.now() - lastActivity > min * 60 * 1000) {
    unlockedKey = null
    console.log('Vault auto-locked (idle)')
  }
}, 15 * 1000).unref?.()

function vaultState() {
  return {
    enabled: vaultEnabled(),
    locked: isLocked(),
    autoLockMinutes: autoLockMinutes(),
    autoLockRemaining: autoLockRemaining(),
  }
}

// ---- Vault ----
app.get('/api/vault/status', (req, res) => {
  res.json(vaultState())
})

app.post('/api/vault/setup', (req, res) => {
  const { passphrase } = req.body || {}
  if (!passphrase || passphrase.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (мин. 4 символа)' })
  }
  if (vaultEnabled()) {
    return res.status(400).json({ error: 'Хранилище уже защищено' })
  }
  const salt = generateSalt()
  const key = deriveKey(passphrase, salt)
  setMeta('vault_salt', salt)
  setMeta('vault_verifier', makeVerifier(key))
  setMeta('vault_enabled', '1')
  reencryptAll(null, key)
  unlockedKey = key
  touch()
  res.json({ ...vaultState(), keys: listKeys(encKey()), activeKeyId: getActiveKeyId() })
})

app.post('/api/vault/unlock', (req, res) => {
  const { passphrase } = req.body || {}
  if (!vaultEnabled()) return res.status(400).json({ error: 'Хранилище не настроено' })
  const { salt, verifier } = getVault()
  const key = deriveKey(passphrase || '', salt)
  if (!checkVerifier(verifier, key)) {
    return res.status(401).json({ error: 'Неверный пароль' })
  }
  unlockedKey = key
  touch()
  res.json({ ...vaultState(), keys: listKeys(encKey()), activeKeyId: getActiveKeyId() })
})

app.post('/api/vault/lock', (req, res) => {
  unlockedKey = null
  res.json(vaultState())
})

app.post('/api/vault/change', (req, res) => {
  if (isLocked()) return res.status(423).json({ error: 'Сначала разблокируйте хранилище' })
  const { passphrase } = req.body || {}
  if (!passphrase || passphrase.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (мин. 4 символа)' })
  }
  const salt = generateSalt()
  const newKey = deriveKey(passphrase, salt)
  reencryptAll(unlockedKey, newKey)
  setMeta('vault_salt', salt)
  setMeta('vault_verifier', makeVerifier(newKey))
  unlockedKey = newKey
  touch()
  res.json(vaultState())
})

app.post('/api/vault/disable', (req, res) => {
  if (!vaultEnabled()) return res.json(vaultState())
  if (isLocked()) return res.status(423).json({ error: 'Сначала разблокируйте хранилище' })
  reencryptAll(unlockedKey, null)
  delMeta('vault_salt')
  delMeta('vault_verifier')
  setMeta('vault_enabled', '0')
  unlockedKey = null
  res.json({ ...vaultState(), keys: listKeys(null), activeKeyId: getActiveKeyId() })
})

// Настроить автоблокировку (минуты, 0 = выкл)
app.post('/api/vault/autolock', (req, res) => {
  const { minutes } = req.body || {}
  setAutoLockMinutes(minutes)
  touch()
  res.json(vaultState())
})

// ---- Зашифрованный бэкап БД ----
app.get('/api/vault/backup', (req, res) => {
  const v = getVault()
  res.json({
    type: 'browserai-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    encrypted: vaultEnabled(),
    vault: vaultEnabled()
      ? { salt: v.salt, verifier: v.verifier, autoLockMinutes: autoLockMinutes() }
      : null,
    keys: dumpRawKeys(),
    params: getParams(),
  })
})

app.post('/api/vault/restore', (req, res) => {
  const b = req.body || {}
  if (b.type !== 'browserai-backup' || !Array.isArray(b.keys)) {
    return res.status(400).json({ error: 'Неверный формат бэкапа' })
  }
  restoreRawKeys(b.keys)
  if (b.params) setParams(b.params)
  if (b.encrypted && b.vault?.salt && b.vault?.verifier) {
    setMeta('vault_salt', b.vault.salt)
    setMeta('vault_verifier', b.vault.verifier)
    setMeta('vault_enabled', '1')
    setAutoLockMinutes(b.vault.autoLockMinutes || 0)
    unlockedKey = null // потребуется разблокировка
  } else {
    delMeta('vault_salt')
    delMeta('vault_verifier')
    setMeta('vault_enabled', '0')
    unlockedKey = null
  }
  res.json({
    ...vaultState(),
    keys: listKeys(encKey()),
    activeKeyId: getActiveKeyId(),
    params: getParams(),
  })
})

// Защита: операции с ключами требуют разблокировки, если хранилище включено
function requireUnlocked(req, res, next) {
  if (isLocked()) {
    return res.status(423).json({ error: 'Хранилище заблокировано', locked: true })
  }
  touch()
  next()
}

// ---- Settings (ключи + параметры) ----
app.get('/api/settings', (req, res) => {
  res.json({
    keys: listKeys(encKey()),
    activeKeyId: getActiveKeyId(),
    params: getParams(),
    vault: vaultState(),
  })
})

app.get('/api/keys', (req, res) => {
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys', requireUnlocked, (req, res) => {
  const k = req.body || {}
  if (!k.id) return res.status(400).json({ error: 'id required' })
  upsertKey(
    {
      id: k.id,
      name: k.name || '',
      baseUrl: k.baseUrl || '',
      apiKey: k.apiKey || '',
      model: k.model || '',
      availableModels: Array.isArray(k.availableModels) ? k.availableModels : [],
    },
    encKey(),
  )
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.delete('/api/keys/:id', requireUnlocked, (req, res) => {
  deleteKey(req.params.id)
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys/:id/activate', (req, res) => {
  setActiveKey(req.params.id)
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() })
})

app.post('/api/keys/import', requireUnlocked, (req, res) => {
  const { keys = [], activeKeyId = null } = req.body || {};
  
  // Валидация: keys должен быть массивом
  if (!Array.isArray(keys)) {
    return res.status(400).json({ error: 'keys must be an array' });
  }
  
  // Валидация каждого ключа
  for (const key of keys) {
    if (!key.id || typeof key.id !== 'string') {
      return res.status(400).json({ error: 'Each key must have a string id' });
    }
    if (key.name !== undefined && typeof key.name !== 'string') {
      return res.status(400).json({ error: 'key.name must be string' });
    }
    if (key.baseUrl !== undefined && typeof key.baseUrl !== 'string') {
      return res.status(400).json({ error: 'key.baseUrl must be string' });
    }
    if (key.apiKey !== undefined && typeof key.apiKey !== 'string') {
      return res.status(400).json({ error: 'key.apiKey must be string' });
    }
    if (key.model !== undefined && typeof key.model !== 'string') {
      return res.status(400).json({ error: 'key.model must be string' });
    }
  }
  
  // Валидация activeKeyId (если указан)
  if (activeKeyId !== null && typeof activeKeyId !== 'string') {
    return res.status(400).json({ error: 'activeKeyId must be string or null' });
  }
  
  replaceKeys(keys, activeKeyId, encKey());
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId(), vault: vaultState() });
})

app.get('/api/keys/export', requireUnlocked, (req, res) => {
  res.json({ keys: listKeys(encKey()), activeKeyId: getActiveKeyId() })
})

app.put('/api/params', (req, res) => {
  res.json({ params: setParams(req.body || {}) })
})

// ---- Проверка валидности ключа (исправлена от SSRF) ----
app.post('/api/validate', async (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {}
  if (!baseUrl || !apiKey) {
    return res.json({ ok: false, message: 'Укажите Base URL и ключ', models: [], preferredModel: '' })
  }

  // Блокировка private IP и localhost
  let hostname
  try {
    const url = new URL(baseUrl)
    hostname = url.hostname
  } catch {
    return res.json({ ok: false, message: 'Invalid URL' })
  }
  if (isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
    return res.json({ ok: false, message: 'Access to internal networks is not allowed' })
  }

  const root = String(baseUrl).replace(/\/$/, '')

  try {
    const modelsResult = await fetchModels(baseUrl, apiKey, model)
    if (modelsResult.ok) {
      return res.json({
        ok: true,
        message: modelsResult.models.length
          ? `Ключ валиден · моделей: ${modelsResult.models.length}`
          : 'Ключ валиден',
        models: modelsResult.models,
        preferredModel: modelsResult.preferredModel || model || '',
      })
    }
    if (modelsResult.status === 401 || modelsResult.status === 403) {
      return res.json({
        ok: false,
        message: `Ключ отклонён (${modelsResult.status})`,
        models: modelsResult.models || [],
        preferredModel: '',
      })
    }
  } catch {
    /* пробуем chat ниже */
  }

  try {
    const r = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    })
    if (r.ok) {
      return res.json({
        ok: true,
        message: 'Ключ валиден',
        models: model ? [model] : [],
        preferredModel: model || '',
      })
    }
    if (r.status === 401 || r.status === 403) {
      return res.json({ ok: false, message: `Ключ отклонён (${r.status})`, models: [], preferredModel: '' })
    }
    let detail = ''
    try {
      const j = await r.json()
      detail = j?.error?.message || ''
    } catch {
      /* ignore */
    }
    return res.json({
      ok: false,
      message: `Ошибка ${r.status}${detail ? ': ' + detail : ''}`,
      models: [],
      preferredModel: '',
    })
  } catch (e) {
    return res.json({
      ok: false,
      message: 'Не удалось проверить: ' + (e.message || 'сеть'),
      models: [],
      preferredModel: '',
    })
  }
})

// ---- Server Workspace (с частичной защитой, но основное в workspace.js) ----
app.get('/api/workspace/tree', async (req, res) => {
  try {
    const showHidden = String(req.query.hidden || '0') === '1'
    const tree = await getWorkspaceTree(showHidden)
    res.json({ tree })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать workspace' })
  }
})

app.get('/api/workspace/file', async (req, res) => {
  try {
    const file = await readWorkspaceFile(req.query.path || '')
    res.json(file)
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать файл' })
  }
})

app.get('/api/workspace/download', async (req, res) => {
  try {
    const rel = String(req.query.path || '')
    const stat = await statWorkspaceItem(rel)

    if (stat.isDirectory) {
      const folderFull = safePath(rel)
      const folderName = path.basename(rel) || 'workspace'
      const zip = new AdmZip()
      zip.addLocalFolder(folderFull, folderName)
      const buffer = zip.toBuffer()
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(folderName)}.zip"`,
      )
      res.setHeader('Content-Type', 'application/zip')
      res.end(buffer)
      return
    }

    if (stat.isFile) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(getDownloadName(rel))}"`,
      )
      res.setHeader('Content-Type', 'application/octet-stream')
      streamWorkspaceFile(rel).pipe(res)
      return
    }

    res.status(400).json({ error: 'Path is neither file nor directory' })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to download' })
  }
})

app.post('/api/workspace/folder', async (req, res) => {
  try {
    const { parentPath = '', name = 'New Folder' } = req.body || {}
    await createFolder(parentPath, name)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось создать папку' })
  }
})

app.post('/api/workspace/file', async (req, res) => {
  try {
    const { parentPath = '', name = 'untitled.txt', content = '' } = req.body || {}
    await createFile(parentPath, name, content)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось создать файл' })
  }
})

app.put('/api/workspace/file', async (req, res) => {
  try {
    const { path, content = '' } = req.body || {}
    if (!path) return res.status(400).json({ error: 'path required' })
    await writeFileContent(path, content)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось сохранить файл' })
  }
})

app.post('/api/workspace/rename', async (req, res) => {
  try {
    const { path, newName } = req.body || {}
    if (!path || !newName) return res.status(400).json({ error: 'path and newName required' })
    await renameItem(path, newName)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось переименовать' })
  }
})

app.post('/api/workspace/move', async (req, res) => {
  try {
    const { sourcePath, targetDirPath = '' } = req.body || {}
    if (!sourcePath) return res.status(400).json({ error: 'sourcePath required' })
    await moveItem(sourcePath, targetDirPath)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось переместить' })
  }
})

app.delete('/api/workspace/item', async (req, res) => {
  try {
    const { path } = req.body || {}
    if (!path) return res.status(400).json({ error: 'path required' })
    await deleteItem(path)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось удалить' })
  }
})

app.post('/api/workspace/upload', async (req, res) => {
  try {
    const { parentPath = '', files = [] } = req.body || {}
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files required' })
    }
    await uploadFiles(parentPath, files)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить файлы' })
  }
})

app.post('/api/workspace/upload-url', async (req, res) => {
  try {
    const { parentPath = '', url = '' } = req.body || {}
    if (!url) return res.status(400).json({ error: 'url required' })
    const result = await uploadFromUrl(parentPath, url)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить по URL' })
  }
})

app.get('/api/workspace/search', async (req, res) => {
  try {
    const q = String(req.query.q || '')
    const showHidden = String(req.query.hidden || '0') === '1'
    const results = await searchWorkspaceContent(q, showHidden)
    res.json({ results })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось выполнить поиск' })
  }
})

app.get('/api/workspace/history', async (req, res) => {
  try {
    const path = String(req.query.path || '')
    if (!path) return res.status(400).json({ error: 'path required' })
    const items = await getFileHistory(path)
    res.json({ items })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать историю файла' })
  }
})

app.post('/api/workspace/history/restore', async (req, res) => {
  try {
    const { path, revisionId } = req.body || {}
    if (!path || !revisionId) {
      return res.status(400).json({ error: 'path and revisionId required' })
    }
    await restoreFileRevision(path, revisionId)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось восстановить ревизию' })
  }
})

app.get('/api/web/search', async (req, res) => {
  try {
    const query = String(req.query.q || '')
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit || '5', 10) || 5))
    const results = await searchWeb(query, limit)
    res.json({ results })
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось выполнить web search' })
  }
})

app.get('/api/web/fetch', async (req, res) => {
  try {
    const url = String(req.query.url || '')
    // Дополнительная защита от SSRF
    let hostname
    try {
      const urlObj = new URL(url)
      hostname = urlObj.hostname
    } catch {
      return res.status(400).json({ error: 'Invalid URL' })
    }
    if (isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')) {
      return res.status(403).json({ error: 'Access to internal networks is not allowed' })
    }
    const page = await fetchWebPage(url)
    res.json(page)
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось загрузить web page' })
  }
})

app.get('/api/health', (req, res) => res.json({ ok: true }))

// доступно для расширений
void getActiveKeyDecrypted

// ---- Статика (production) ----
const distDir = join(__dirname, '..', 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(join(distDir, 'index.html'))
  })
}

try {
  await ensureWorkspaceRoot();
} catch (err) {
  console.error('FATAL: Failed to initialize workspace:', err.message);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`BrowserAI API + SQLite + Workspace на http://localhost:${PORT}`)
})