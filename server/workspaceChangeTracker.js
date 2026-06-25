import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { safePath } from './workspace.js'
import { WORKSPACE_EXCLUDED_DIRS } from './sandboxPolicy.js'
import { createUnifiedDiff } from './workspaceDiff.js'

const EXTRA_EXCLUDED = new Set([
  '.git', '.history', '.snapshots', 'node_modules', 'dist', 'build', 'coverage',
  '.cache', '.vite', '.turbo', '.next', '.nuxt', '.output', '.parcel-cache',
  '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox', '.nox', '.venv', 'target',
])

const CODE_EXT_RE = /\.(js|mjs|cjs|jsx|ts|tsx|json|css|scss|html|htm|yml|yaml|md|py|sh|sql|go|rs|java|php|rb|vue|svelte|dockerfile|toml|ini|env)$/i
const MAX_FILES = Number(process.env.WORKSPACE_CHANGE_SCAN_MAX_FILES || 5000)
const HASH_MAX_BYTES = Number(process.env.WORKSPACE_CHANGE_HASH_MAX_BYTES || 1024 * 1024)
const DIFF_MAX_BYTES = Number(process.env.WORKSPACE_DIFF_MAX_BYTES || 96 * 1024)

function isExcludedName(name = '') {
  return EXTRA_EXCLUDED.has(name) || WORKSPACE_EXCLUDED_DIRS.includes(name)
}

function toPosix(rel = '') {
  return String(rel || '').replace(/\\/g, '/')
}

async function hashFile(abs, size) {
  if (size > HASH_MAX_BYTES) return ''
  try {
    const data = await fs.readFile(abs)
    return crypto.createHash('sha1').update(data).digest('hex')
  } catch {
    return ''
  }
}

async function readDiffText(abs, rel, size) {
  if (size > DIFF_MAX_BYTES) return null
  if (!(CODE_EXT_RE.test(rel) || /(^|\/)Dockerfile$/i.test(rel))) return null
  try {
    const text = await fs.readFile(abs, 'utf8')
    if (text.includes('\0')) return null
    return text
  } catch {
    return null
  }
}

export async function captureWorkspaceState({ rootRel = '' } = {}) {
  const root = safePath(rootRel || '')
  const files = new Map()
  let truncated = false

  async function walk(absDir, relDir = '') {
    if (files.size >= MAX_FILES) { truncated = true; return }
    let entries = []
    try { entries = await fs.readdir(absDir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.size >= MAX_FILES) { truncated = true; return }
      if (isExcludedName(entry.name)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      const st = await fs.stat(abs).catch(() => null)
      if (!st?.isFile()) continue
      const relPosix = toPosix(rel)
      files.set(relPosix, {
        path: relPosix,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        hash: await hashFile(abs, st.size),
        text: await readDiffText(abs, relPosix, st.size),
      })
    }
  }

  await walk(root, '')
  return { files, truncated, capturedAt: Date.now(), rootRel: rootRel || '' }
}

export function diffWorkspaceStates(before, after) {
  const beforeFiles = before?.files instanceof Map ? before.files : new Map()
  const afterFiles = after?.files instanceof Map ? after.files : new Map()
  const created = []
  const modified = []
  const deleted = []

  for (const [p, next] of afterFiles.entries()) {
    const prev = beforeFiles.get(p)
    if (!prev) {
      created.push(p)
      continue
    }
    if (prev.size !== next.size || prev.mtimeMs !== next.mtimeMs || (prev.hash && next.hash && prev.hash !== next.hash)) {
      modified.push(p)
    }
  }
  for (const p of beforeFiles.keys()) {
    if (!afterFiles.has(p)) deleted.push(p)
  }

  const all = [...created, ...modified, ...deleted].sort()
  const code = all.filter((p) => CODE_EXT_RE.test(p) || /(^|\/)Dockerfile$/i.test(p)).sort()
  const diffs = []
  for (const p of created) {
    const next = afterFiles.get(p)
    if (next?.text != null) diffs.push(createUnifiedDiff({ path: p, before: '', after: next.text, type: 'created' }))
  }
  for (const p of modified) {
    const prev = beforeFiles.get(p)
    const next = afterFiles.get(p)
    if (prev?.text != null && next?.text != null) diffs.push(createUnifiedDiff({ path: p, before: prev.text, after: next.text, type: 'modified' }))
  }
  for (const p of deleted) {
    const prev = beforeFiles.get(p)
    if (prev?.text != null) diffs.push(createUnifiedDiff({ path: p, before: prev.text, after: '', type: 'deleted' }))
  }
  return {
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    all,
    code,
    diffs,
    diffCount: diffs.length,
    total: all.length,
    codeChanged: code.length > 0,
    truncated: Boolean(before?.truncated || after?.truncated),
  }
}

export async function detectWorkspaceChangesAround(fn, options = {}) {
  const before = await captureWorkspaceState(options).catch(() => null)
  const value = await fn()
  const after = await captureWorkspaceState(options).catch(() => null)
  const changes = before && after ? diffWorkspaceStates(before, after) : {
    created: [], modified: [], deleted: [], all: [], code: [], diffs: [], diffCount: 0, total: 0, codeChanged: false, truncated: true,
  }
  return { value, changes }
}

export default detectWorkspaceChangesAround
