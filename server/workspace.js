import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import ipaddr from 'ipaddr.js'

const DEFAULT_DATA_DIR = '/data'
const workspaceRoot = path.resolve(
  process.env.WORKSPACE_ROOT
    || (fsSync.existsSync(DEFAULT_DATA_DIR)
      ? path.join(DEFAULT_DATA_DIR, 'workspace')
      : path.join(process.cwd(), 'workspace')),
)
const historyRoot = path.join(workspaceRoot, '.history')

const MAX_HISTORY_REVISIONS = 30
const MAX_PREVIEW_TEXT_BYTES = 200 * 1024
const MAX_SEARCH_TEXT_BYTES = 512 * 1024

// #12 FIX: квота на общий размер workspace — по умолчанию 500 МБ, настраивается через WORKSPACE_QUOTA_MB
const WORKSPACE_QUOTA_BYTES = (Number(process.env.WORKSPACE_QUOTA_MB) || 500) * 1024 * 1024
const MAX_SINGLE_FILE_BYTES = (Number(process.env.WORKSPACE_MAX_FILE_MB) || 50) * 1024 * 1024

async function getWorkspaceSizeBytes(dir = workspaceRoot) {
  let total = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.history') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += await getWorkspaceSizeBytes(full)
      } else {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  } catch {
    /* ignore read errors */
  }
  return total
}

async function assertQuota(additionalBytes = 0) {
  if (additionalBytes > MAX_SINGLE_FILE_BYTES) {
    throw new Error(`Файл слишком большой: максимум ${Math.round(MAX_SINGLE_FILE_BYTES / 1024 / 1024)} МБ`)
  }
  const used = await getWorkspaceSizeBytes()
  if (used + additionalBytes > WORKSPACE_QUOTA_BYTES) {
    throw new Error(`Превышена квота workspace: максимум ${Math.round(WORKSPACE_QUOTA_BYTES / 1024 / 1024)} МБ`)
  }
}

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss',
  'html', 'htm', 'xml', 'yml', 'yaml', 'csv', 'py', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'rb', 'php', 'sh', 'sql', 'env', 'ini', 'toml', 'log', 'vue',
  'svelte', 'config', 'gitignore', 'editorconfig', 'dockerfile', 'ps1', 'bat',
])

const IMAGE_EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

const MIME_BY_EXT = {
  ...IMAGE_EXT_TO_MIME,
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
}

function isInsideRoot(fullPath, rootPath) {
  const relative = path.relative(rootPath, fullPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeRelativePath(relativePath = '') {
  const raw = String(relativePath || '').replace(/\\/g, '/')
  // Отбрасываем null bytes — они вызывают information disclosure через сообщение Node.js
  if (raw.includes('\0')) throw new Error('Invalid path: null bytes not allowed')
  const normalized = path.posix.normalize(raw).replace(/^\/+/, '')
  if (normalized === '.' || normalized === '') return ''
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path traversal detected')
  }
  return normalized
}

function safePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  const full = path.resolve(workspaceRoot, normalized)
  if (!isInsideRoot(full, workspaceRoot)) {
    throw new Error('Path traversal detected')
  }
  return full
}

function safeHistoryPath(relativePath = '') {
  const normalized = normalizeRelativePath(relativePath)
  const full = path.resolve(historyRoot, normalized)
  if (!isInsideRoot(full, historyRoot)) {
    throw new Error('Path traversal detected in history')
  }
  return full
}

function extOf(name = '') {
  return String(name).split('.').pop()?.toLowerCase() || ''
}

function sanitizeReason(reason = 'edit') {
  return String(reason || 'edit')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'edit'
}

function fileNameToMime(name = '') {
  const ext = extOf(name)
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

function isProbablyTextBuffer(buffer) {
  const slice = buffer.subarray(0, Math.min(buffer.length, 4096))
  let suspicious = 0
  for (const byte of slice) {
    if (byte === 0) return false
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1
  }
  return suspicious < Math.max(8, Math.floor(slice.length * 0.05))
}

function isTextFileName(name = '') {
  const lower = String(name || '').toLowerCase()
  const ext = extOf(lower)
  if (TEXT_EXT.has(ext)) return true
  const base = path.basename(lower)
  return TEXT_EXT.has(base)
}

function isImageFileName(name = '') {
  return Boolean(IMAGE_EXT_TO_MIME[extOf(name)])
}

function isPdfFileName(name = '') {
  return extOf(name) === 'pdf'
}

function encodeDataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function revisionFileName(baseName, timestamp, hash, reason) {
  return `${baseName}.${timestamp}.${hash}.${sanitizeReason(reason)}.rev`
}

function parseRevisionMeta(baseName, fileName) {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = fileName.match(new RegExp(`^${escaped}\\.(\\d+)\\.([a-f0-9]{8})(?:\\.([a-z0-9_-]+))?\\.rev$`, 'i'))
  if (!match) return null
  return {
    id: fileName,
    createdAt: Number(match[1]),
    hash: match[2],
    reason: match[3] || 'edit',
  }
}

async function ensureWorkspaceRoot() {
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.mkdir(historyRoot, { recursive: true })
}

async function saveRevisionSnapshot(relPath, content, reason = 'edit') {
  const normalizedRel = normalizeRelativePath(relPath)
  if (!normalizedRel) return

  const buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content ?? ''), 'utf8')

  const baseName = path.basename(normalizedRel)
  const dirRel = path.dirname(normalizedRel)
  const revisionDir = safeHistoryPath(dirRel)
  await fs.mkdir(revisionDir, { recursive: true })

  const timestamp = Date.now()
  const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 8)
  const fileName = revisionFileName(baseName, timestamp, hash, reason)
  const revisionPath = safeHistoryPath(path.join(dirRel, fileName))
  await fs.writeFile(revisionPath, buffer)

  const entries = await fs.readdir(revisionDir).catch(() => [])
  const revisions = entries
    .map((entry) => ({ entry, meta: parseRevisionMeta(baseName, entry) }))
    .filter((item) => item.meta)
    .sort((a, b) => b.meta.createdAt - a.meta.createdAt)

  for (const stale of revisions.slice(MAX_HISTORY_REVISIONS)) {
    await fs.unlink(safeHistoryPath(path.join(dirRel, stale.entry))).catch(() => {})
  }
}

async function buildTree(currentPath, currentRel = '', showHidden = false) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true })
  const nodes = []

  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith('.')) continue
    if (entry.name === '.history') continue

    const rel = currentRel ? path.posix.join(currentRel, entry.name) : entry.name
    const full = safePath(rel)

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: rel,
        type: 'dir',
        children: await buildTree(full, rel, showHidden),
      })
      continue
    }

    const stat = await fs.stat(full)
    nodes.push({
      name: entry.name,
      path: rel,
      type: 'file',
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    })
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

async function getWorkspaceTree(showHidden = false) {
  return {
    name: 'workspace',
    path: '',
    type: 'dir',
    children: await buildTree(workspaceRoot, '', showHidden),
  }
}

async function readWorkspaceFile(relPath) {
  const normalizedRel = normalizeRelativePath(relPath)
  if (!normalizedRel) throw new Error('path required')

  const full = safePath(normalizedRel)
  const stat = await fs.stat(full)
  if (!stat.isFile()) throw new Error('Not a file')

  const name = path.basename(normalizedRel)
  const mime = fileNameToMime(name)
  const buffer = await fs.readFile(full)

  const base = {
    name,
    path: normalizedRel,
    size: stat.size,
    mime,
    modifiedAt: stat.mtimeMs,
    truncated: false,
  }

  if (isImageFileName(name)) {
    return {
      ...base,
      kind: 'image',
      dataUrl: encodeDataUrl(mime, buffer),
    }
  }

  if (isPdfFileName(name)) {
    return {
      ...base,
      kind: 'pdf',
      dataUrl: encodeDataUrl(mime, buffer),
    }
  }

  if (isTextFileName(name) || mime.startsWith('text/') || isProbablyTextBuffer(buffer)) {
    let textBuffer = buffer
    let truncated = false
    if (buffer.length > MAX_PREVIEW_TEXT_BYTES) {
      textBuffer = buffer.subarray(0, MAX_PREVIEW_TEXT_BYTES)
      truncated = true
    }
    return {
      ...base,
      kind: 'text',
      text: textBuffer.toString('utf8'),
      truncated,
    }
  }

  return {
    ...base,
    kind: 'binary',
  }
}

async function createFolder(parentRel, name) {
  const cleanName = path.basename(String(name || '').trim())
  if (!cleanName) throw new Error('Folder name required')
  const target = safePath(path.posix.join(normalizeRelativePath(parentRel), cleanName))
  await fs.mkdir(target, { recursive: true })
}

async function createFile(parentRel, name, content = '') {
  const cleanName = path.basename(String(name || '').trim())
  if (!cleanName) throw new Error('File name required')

  const rel = path.posix.join(normalizeRelativePath(parentRel), cleanName)
  const full = safePath(rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, String(content ?? ''), 'utf8')
  await saveRevisionSnapshot(rel, String(content ?? ''), 'create')
}

async function writeFileContent(relPath, content = '') {
  const normalizedRel = normalizeRelativePath(relPath)
  if (!normalizedRel) throw new Error('path required')

  const full = safePath(normalizedRel)
  await fs.mkdir(path.dirname(full), { recursive: true })

  const previous = await fs.readFile(full).catch(() => null)
  const nextContent = typeof content === 'string' ? content : String(content ?? '')
  const newBytes = Buffer.byteLength(nextContent, 'utf8')
  const oldBytes = previous ? previous.length : 0

  // #12 FIX: проверяем квоту — учитываем только прирост относительно старого файла
  await assertQuota(Math.max(0, newBytes - oldBytes))

  if (previous) {
    await saveRevisionSnapshot(normalizedRel, previous, 'edit')
  }

  await fs.writeFile(full, nextContent, 'utf8')

  if (!previous) {
    await saveRevisionSnapshot(normalizedRel, nextContent, 'create')
  }
}

async function renameItem(relPath, newName) {
  const normalizedRel = normalizeRelativePath(relPath)
  const cleanName = path.basename(String(newName || '').trim())
  if (!normalizedRel || !cleanName) throw new Error('path and newName required')

  const oldFull = safePath(normalizedRel)
  const newRel = path.posix.join(path.posix.dirname(normalizedRel), cleanName)
  const newFull = safePath(newRel)
  await fs.rename(oldFull, newFull)
}

async function moveItem(sourceRel, targetDirRel = '') {
  const normalizedSource = normalizeRelativePath(sourceRel)
  const normalizedTargetDir = normalizeRelativePath(targetDirRel)
  if (!normalizedSource) throw new Error('sourcePath required')

  const sourceFull = safePath(normalizedSource)
  const targetDirFull = safePath(normalizedTargetDir)
  await fs.mkdir(targetDirFull, { recursive: true })

  const targetRel = path.posix.join(normalizedTargetDir, path.posix.basename(normalizedSource))
  const targetFull = safePath(targetRel)

  if (targetFull === sourceFull) return
  if (isInsideRoot(targetFull, sourceFull)) {
    throw new Error('Cannot move a folder into itself')
  }

  await fs.rename(sourceFull, targetFull)
}

async function deleteItem(relPath) {
  const normalizedRel = normalizeRelativePath(relPath)
  if (!normalizedRel) throw new Error('path required')

  const full = safePath(normalizedRel)
  const stat = await fs.stat(full)
  if (stat.isDirectory()) {
    await fs.rm(full, { recursive: true, force: true })
  } else {
    await fs.unlink(full)
  }
}

function isPrivateIpAddress(address) {
  if (!net.isIP(address)) return false
  const parsed = ipaddr.parse(address)
  return parsed.range() !== 'unicast' || parsed.isLoopback() || parsed.isLinkLocal()
}

async function assertPublicUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed')
  }

  const hostname = parsed.hostname
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Access to internal networks is not allowed')
  }

  if (isPrivateIpAddress(hostname)) {
    throw new Error('Access to internal networks is not allowed')
  }

  try {
    const resolved = await dns.lookup(hostname, { all: true })
    if (resolved.some((item) => isPrivateIpAddress(item.address))) {
      throw new Error('Access to internal networks is not allowed')
    }
  } catch (error) {
    if (String(error?.message || '').includes('internal networks')) {
      throw error
    }
    // если DNS не разрешился, оставляем дальнейшую сетевую ошибку fetch
  }

  return parsed
}

function detectArchiveType(name = '', contentType = '') {
  const lower = String(name || '').toLowerCase()
  const type = String(contentType || '').toLowerCase()

  if (
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    type === 'application/gzip' ||
    type === 'application/x-gzip'
  ) {
    return 'tgz'
  }

  if (
    lower.endsWith('.tar') ||
    type === 'application/x-tar' ||
    type === 'application/tar'
  ) {
    return 'tar'
  }

  if (
    lower.endsWith('.zip') ||
    type === 'application/zip' ||
    type === 'application/x-zip-compressed'
  ) {
    return 'zip'
  }

  return null
}

function isSafeArchiveEntry(entryName = '') {
  const raw = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!raw) return false
  const normalized = path.posix.normalize(raw)
  if (!normalized || normalized === '.' || normalized === '..') return false
  if (normalized.startsWith('../')) return false
  return true
}

async function writeUploadedFile(targetRel, buffer, reason = 'create') {
  // #12 FIX: проверяем квоту перед записью загруженного файла
  await assertQuota(buffer.length)
  const full = safePath(targetRel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, buffer)
  await saveRevisionSnapshot(targetRel, buffer, reason)
}

async function extractZipBuffer(parentRel, archiveRel, buffer, options = {}) {
  const destRel = path.posix.join(normalizeRelativePath(parentRel), path.posix.dirname(archiveRel))
  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()
  const topLevel = options.stripTopLevel
    ? commonTopLevelDir(entries.map((entry) => entry.entryName))
    : ''
  const written = []

  for (const entry of entries) {
    const rawName = stripTopLevel(String(entry.entryName || ''), topLevel)
    if (!rawName || !isSafeArchiveEntry(rawName)) continue

    const entryRel = path.posix.join(destRel, normalizeRelativePath(rawName))
    if (entry.isDirectory) {
      await fs.mkdir(safePath(entryRel), { recursive: true })
      continue
    }

    const data = entry.getData()
    await writeUploadedFile(entryRel, data, 'create')
    written.push(entryRel)
  }

  return written
}

async function extractTarBuffer(parentRel, archiveRel, buffer, archiveType = 'tar', options = {}) {
  const destRel = path.posix.join(normalizeRelativePath(parentRel), path.posix.dirname(archiveRel))
  const destFull = safePath(destRel)
  await fs.mkdir(destFull, { recursive: true })

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserai-archive-'))
  const ext = archiveType === 'tgz' ? '.tar.gz' : '.tar'
  const tempFile = path.join(tempDir, `archive${ext}`)
  await fs.writeFile(tempFile, buffer)

  const extractedFiles = []

  try {
    const entries = []
    await tar.list({
      file: tempFile,
      onentry: (entry) => {
        const entryPath = String(entry.path || '')
        if (!isSafeArchiveEntry(entryPath)) {
          throw new Error('Archive contains unsafe paths')
        }
        if (entry.type !== 'File' && entry.type !== 'Directory') {
          throw new Error('Archive contains unsupported entry types')
        }
        entries.push({ path: normalizeRelativePath(entryPath), type: entry.type })
      },
    })

    const topLevel = options.stripTopLevel
      ? commonTopLevelDir(entries.map((entry) => entry.path))
      : ''

    await tar.extract({
      file: tempFile,
      cwd: destFull,
      strict: true,
      preservePaths: false,
      strip: topLevel ? 1 : 0,
      filter: (_entryPath, entry) => entry.type === 'File' || entry.type === 'Directory',
    })

    for (const entry of entries) {
      if (entry.type !== 'File') continue
      const stripped = stripTopLevel(entry.path, topLevel)
      if (!stripped) continue
      const fileRel = path.posix.join(destRel, stripped)
      const fileBuffer = await fs.readFile(safePath(fileRel))
      await saveRevisionSnapshot(fileRel, fileBuffer, 'create')
      extractedFiles.push(fileRel)
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  return extractedFiles
}

async function uploadFiles(parentRel, files) {
  const normalizedParent = normalizeRelativePath(parentRel)

  for (const file of files) {
    const relativeTarget = normalizeRelativePath(file.path || file.name || '')
    const fileName = path.posix.basename(relativeTarget)
    const contentBase64 = file.content || file.contentBase64
    if (!relativeTarget || !fileName || !contentBase64) {
      throw new Error('Invalid uploaded file payload')
    }

    const buffer = Buffer.from(contentBase64, 'base64')
    const archiveType = detectArchiveType(fileName, file.type)
    if (archiveType === 'zip') {
      await extractZipBuffer(normalizedParent, relativeTarget, buffer)
      continue
    }
    if (archiveType === 'tar' || archiveType === 'tgz') {
      await extractTarBuffer(normalizedParent, relativeTarget, buffer, archiveType)
      continue
    }

    const targetRel = path.posix.join(normalizedParent, relativeTarget)
    await writeUploadedFile(targetRel, buffer, 'create')
  }
}

function fileNameFromResponse(url, response) {
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i)
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1].replace(/"/g, ''))
    } catch {
      return match[1].replace(/"/g, '')
    }
  }

  const parsed = new URL(url)
  return path.posix.basename(parsed.pathname) || 'downloaded'
}

function commonTopLevelDir(entryNames = []) {
  const files = entryNames
    .map((name) => String(name || '').replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter(Boolean)
    .filter((name) => !name.endsWith('/'))
  if (!files.length) return ''

  const first = files[0].split('/')[0]
  if (!first) return ''
  const allUnderFirst = files.every((name) => name === first || name.startsWith(`${first}/`))
  return allUnderFirst ? first : ''
}

function stripTopLevel(entryName = '', topLevel = '') {
  const clean = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!topLevel) return clean
  if (clean === topLevel) return ''
  return clean.startsWith(`${topLevel}/`) ? clean.slice(topLevel.length + 1) : clean
}

function normalizeGithubDownloadUrl(inputUrl, branch = '') {
  const raw = String(inputUrl || '').trim()
  if (!raw) return raw

  let u
  try {
    u = new URL(raw)
  } catch {
    return raw
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'github.com') return raw

  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return raw

  const owner = parts[0]
  const repo = String(parts[1] || '').replace(/\.git$/i, '')
  const kind = parts[2]

  if ((kind === 'blob' || kind === 'raw') && parts.length >= 5) {
    const ref = parts[3]
    const filePath = parts.slice(4).join('/')
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`
  }

  if (!kind || kind === 'tree') {
    const ref = branch || parts[3] || 'main'
    return `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(ref)}`
  }

  return raw
}

function isGithubRepositoryUrl(inputUrl = '') {
  try {
    const u = new URL(String(inputUrl || '').trim())
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const parts = u.pathname.split('/').filter(Boolean)
    const kind = parts[2]
    return host === 'github.com' && parts.length >= 2 && (!kind || kind === 'tree')
  } catch {
    return false
  }
}

async function uploadFromUrl(parentRel, url, options = {}) {
  const originalUrl = String(url || '')
  const normalizedUrl = normalizeGithubDownloadUrl(originalUrl, options.branch || '')
  await assertPublicUrl(normalizedUrl)

  const response = await fetch(normalizedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BrowserAI/1.0)',
    },
  })

  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  const filename = fileNameFromResponse(normalizedUrl, response)
  const archiveType = detectArchiveType(filename, response.headers.get('content-type') || '')
  const stripRoot = Boolean(options.stripTopLevel ?? isGithubRepositoryUrl(originalUrl))

  if (archiveType === 'zip') {
    const files = await extractZipBuffer(parentRel, filename, buffer, { stripTopLevel: stripRoot })
    return { filename, extracted: true, files, fetchedUrl: normalizedUrl, strippedTopLevel: stripRoot }
  }
  if (archiveType === 'tar' || archiveType === 'tgz') {
    const files = await extractTarBuffer(parentRel, filename, buffer, archiveType, { stripTopLevel: stripRoot })
    return { filename, extracted: true, files, fetchedUrl: normalizedUrl, strippedTopLevel: stripRoot }
  }

  const targetRel = path.posix.join(normalizeRelativePath(parentRel), path.posix.basename(filename))
  await writeUploadedFile(targetRel, buffer, 'create')
  return { filename, extracted: false, files: [targetRel], fetchedUrl: normalizedUrl }
}

async function searchWorkspaceContent(query, showHidden = false) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return []

  const results = []

  async function searchDir(currentFull, currentRel) {
    if (results.length >= 100) return

    const entries = await fs.readdir(currentFull, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= 100) return
      if (!showHidden && entry.name.startsWith('.')) continue
      if (entry.name === '.history') continue

      const rel = currentRel ? path.posix.join(currentRel, entry.name) : entry.name
      const full = safePath(rel)

      if (entry.isDirectory()) {
        await searchDir(full, rel)
        continue
      }

      const stat = await fs.stat(full)
      if (stat.size > MAX_SEARCH_TEXT_BYTES) continue

      const buffer = await fs.readFile(full).catch(() => null)
      if (!buffer || !(isTextFileName(entry.name) || isProbablyTextBuffer(buffer))) {
        continue
      }

      const text = buffer.toString('utf8')
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length && results.length < 100; index += 1) {
        const line = lines[index]
        const lower = line.toLowerCase()
        const at = lower.indexOf(needle)
        if (at === -1) continue

        const start = Math.max(0, at - 80)
        const end = Math.min(line.length, at + needle.length + 80)
        results.push({
          path: rel,
          type: 'file',
          line: index + 1,
          snippet: line.slice(start, end).trim(),
          matches: 1,
        })
      }
    }
  }

  await searchDir(workspaceRoot, '')
  return results
}

async function getFileHistory(relPath) {
  const normalizedRel = normalizeRelativePath(relPath)
  if (!normalizedRel) throw new Error('path required')

  const dirRel = path.posix.dirname(normalizedRel)
  const baseName = path.basename(normalizedRel)
  const revisionDir = safeHistoryPath(dirRel)
  const entries = await fs.readdir(revisionDir).catch(() => [])

  const items = []
  for (const entry of entries) {
    const meta = parseRevisionMeta(baseName, entry)
    if (!meta) continue

    const full = safeHistoryPath(path.join(dirRel, entry))
    const stat = await fs.stat(full).catch(() => null)
    if (!stat?.isFile()) continue

    items.push({
      id: meta.id,
      revisionId: meta.id,
      createdAt: meta.createdAt,
      timestamp: meta.createdAt,
      size: stat.size,
      reason: meta.reason,
    })
  }

  return items.sort((a, b) => b.createdAt - a.createdAt)
}

async function restoreFileRevision(relPath, revisionId) {
  const normalizedRel = normalizeRelativePath(relPath)
  const cleanRevisionId = path.basename(String(revisionId || ''))
  if (!normalizedRel || !cleanRevisionId) {
    throw new Error('path and revisionId required')
  }

  const revisionFull = safeHistoryPath(path.join(path.posix.dirname(normalizedRel), cleanRevisionId))
  const content = await fs.readFile(revisionFull)
  const current = await fs.readFile(safePath(normalizedRel)).catch(() => null)
  if (current) {
    await saveRevisionSnapshot(normalizedRel, current, 'restore')
  }

  await fs.mkdir(path.dirname(safePath(normalizedRel)), { recursive: true })
  await fs.writeFile(safePath(normalizedRel), content)
}

function streamWorkspaceFile(relPath) {
  return fsSync.createReadStream(safePath(relPath))
}

async function statWorkspaceItem(relPath) {
  const stat = await fs.stat(safePath(relPath))
  return {
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
  }
}

function getDownloadName(relPath) {
  const normalizedRel = normalizeRelativePath(relPath)
  return path.basename(normalizedRel || 'workspace')
}

export {
  ensureWorkspaceRoot,
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
  streamWorkspaceFile,
  statWorkspaceItem,
  getDownloadName,
  safePath,
}
