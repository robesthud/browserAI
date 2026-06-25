import express from 'express'
import AdmZip from 'adm-zip'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { requireAuth } from '../authz.js'
import { safeErrorMessage } from '../errorSanitizer.js'
import {
  getWorkspaceTree,
  readWorkspaceFile,
  createFolder,
  createFile,
  writeFileContent,
  renameItem,
  moveItem,
  deleteItem,
  uploadFiles,
  uploadFromUrl,
  searchWorkspaceContent,
  getFileHistory,
  restoreFileRevision,
  statWorkspaceItem,
  getDownloadName,
  fileNameToMime,
  getWorkspaceMetadata,
  safePath,
  withWorkspaceScope,
  ensureWorkspaceRoot,
  deleteWorkspaceScope,
  sanitizeScopeId,
} from '../workspace.js'
import { readWorkspaceDiffs, readWorkspaceEvents } from '../workspaceEventLog.js'

const router = express.Router()

router.use(requireAuth)

function scopeFromReq(req) {
  return sanitizeScopeId(
    req.headers['x-browserai-chat-id']
      || req.query?.chatId
      || req.body?.chatId
      || ''
  )
}

function scoped(handler, { ensure = true } = {}) {
  return async (req, res) => {
    const chatId = scopeFromReq(req)
    const run = async () => {
      if (ensure) await ensureWorkspaceRoot()
      await handler(req, res, chatId)
    }
    try {
      if (chatId) await withWorkspaceScope(chatId, run)
      else await run()
    } catch (e) {
      res.status(400).json({ error: safeErrorMessage(e) })
    }
  }
}

router.post('/chat/init', scoped(async (_req, res) => {
  res.json({ ok: true, metadata: await getWorkspaceMetadata() })
}))

router.delete('/chat', scoped(async (_req, res, chatId) => {
  if (!chatId) throw new Error('chatId required')
  await deleteWorkspaceScope(chatId)
  res.json({ ok: true })
}, { ensure: false }))

router.get('/metadata', scoped(async (_req, res) => {
  res.json({ metadata: await getWorkspaceMetadata() })
}))

router.get('/tree', scoped(async (req, res) => {
  const showHidden = req.query.hidden === '1'
  res.json({ tree: await getWorkspaceTree(showHidden) })
}))

router.get('/file', scoped(async (req, res) => {
  res.json(await readWorkspaceFile(req.query.path))
}))

router.get('/events', scoped(async (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200))
  const runId = String(req.query.runId || '')
  const wantedPath = String(req.query.path || '').trim().replace(/^\/+/, '')
  const events = await readWorkspaceEvents({ limit, runId, path: wantedPath })
  res.json({ schema: 'browserai.workspace_events.v1', runId: runId || null, path: wantedPath || null, count: events.length, events })
}))

router.get('/diff', scoped(async (req, res) => {
  const wantedPath = String(req.query.path || '').trim().replace(/^\/+/, '')
  const runId = String(req.query.runId || '')
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 500))
  const diffs = await readWorkspaceDiffs({ limit, runId, path: wantedPath })
  res.json({ schema: 'browserai.workspace_diffs.v1', runId: runId || null, path: wantedPath || null, count: diffs.length, diffs })
}))

router.get('/download', scoped(async (req, res) => {
  const rel = String(req.query.path || '')
  if (!rel || rel === '.' || rel === '/') return res.status(400).json({ error: 'Укажите путь' })
  const stat = await statWorkspaceItem(rel)

  if (stat.isDirectory) {
    const zip = new AdmZip()
    zip.addLocalFolder(safePath(rel), path.basename(rel) || 'folder')
    const buffer = zip.toBuffer()
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(rel))}.zip"`)
    res.setHeader('Content-Type', 'application/zip')
    return res.end(buffer)
  }

  const fileName = getDownloadName(rel)
  const mime = req.query.inline === '1' ? fileNameToMime(fileName) : 'application/octet-stream'
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`)
  res.setHeader('Content-Type', mime)
  createReadStream(safePath(rel)).pipe(res)
}))

router.post('/folder', scoped(async (req, res) => {
  await createFolder(req.body.parentPath, req.body.name)
  res.json({ ok: true })
}))

router.post('/file', scoped(async (req, res) => {
  await createFile(req.body.parentPath, req.body.name, req.body.content)
  res.json({ ok: true })
}))

router.put('/file', scoped(async (req, res) => {
  await writeFileContent(req.body.path, req.body.content)
  res.json({ ok: true })
}))

router.post('/rename', scoped(async (req, res) => {
  await renameItem(req.body.path, req.body.newName)
  res.json({ ok: true })
}))

router.post('/move', scoped(async (req, res) => {
  await moveItem(req.body.sourcePath, req.body.targetDirPath)
  res.json({ ok: true })
}))

router.delete('/item', scoped(async (req, res) => {
  await deleteItem(req.body.path)
  res.json({ ok: true })
}))

router.post('/upload', scoped(async (req, res) => {
  await uploadFiles(req.body.parentPath, req.body.files)
  res.json({ ok: true })
}))

router.post('/upload-url', scoped(async (req, res) => {
  res.json({ ok: true, ...await uploadFromUrl(req.body.parentPath, req.body.url, req.body) })
}))

router.get('/search', scoped(async (req, res) => {
  res.json({ results: await searchWorkspaceContent(req.query.q, req.query.hidden === '1') })
}))

router.get('/history', scoped(async (req, res) => {
  res.json({ items: await getFileHistory(req.query.path) })
}))

router.post('/history/restore', scoped(async (req, res) => {
  await restoreFileRevision(req.body.path, req.body.revisionId)
  res.json({ ok: true })
}))

export default router
