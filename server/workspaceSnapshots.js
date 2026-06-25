import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { safePath } from './workspace.js'

const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.history', '.snapshots'])
const SNAP_DIR = '.snapshots'

async function add(zip, abs, rel, outAbs) {
  const st = await fs.stat(abs).catch(() => null)
  if (!st) return
  if (st.isDirectory()) {
    if (EXCLUDED.has(path.basename(abs))) return
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const e of entries) await add(zip, path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, outAbs)
    return
  }
  if (!st.isFile()) return
  if (path.resolve(abs) === path.resolve(outAbs)) return
  if (st.size > 50 * 1024 * 1024) return
  zip.addFile(rel.replace(/\\/g, '/'), await fs.readFile(abs))
}

export async function createWorkspaceSnapshot({ label = 'snapshot' } = {}) {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const outRel = `${SNAP_DIR}/${id}.zip`
  const outAbs = safePath(outRel)
  await fs.mkdir(path.dirname(outAbs), { recursive: true })
  const zip = new AdmZip()
  await add(zip, safePath(''), '', outAbs)
  const buffer = zip.toBuffer()
  await fs.writeFile(outAbs, buffer)
  const meta = { id, label, createdAt: Date.now(), file: outRel, bytes: buffer.length, entries: zip.getEntries().length }
  await fs.writeFile(safePath(`${SNAP_DIR}/${id}.json`), JSON.stringify(meta, null, 2))
  return meta
}

export async function listWorkspaceSnapshots() {
  const dir = safePath(SNAP_DIR)
  const entries = await fs.readdir(dir).catch(() => [])
  const out = []
  for (const e of entries.filter((x) => x.endsWith('.json'))) {
    try { out.push(JSON.parse(await fs.readFile(path.join(dir, e), 'utf8'))) } catch { /* ignore */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)
}

async function cleanWorkspaceRoot() {
  const root = safePath('')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name === '.history' || e.name === SNAP_DIR) continue
    await fs.rm(path.join(root, e.name), { recursive: true, force: true })
  }
}

export async function restoreWorkspaceSnapshot({ id } = {}) {
  if (!id) throw new Error('id required')
  const metaPath = safePath(`${SNAP_DIR}/${path.basename(id)}.json`)
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
  // A — verify meta.file is inside .snapshots/ (prevent reading arbitrary files via tampered meta)
  const resolvedFile = safePath(String(meta.file || ''))
  const snapDir = safePath(SNAP_DIR)
  if (!resolvedFile.startsWith(snapDir + '/') && !resolvedFile.startsWith(snapDir + path.sep)) {
    throw new Error('Snapshot meta.file points outside snapshots directory (tampered metadata)')
  }
  const zip = new AdmZip(resolvedFile)
  await cleanWorkspaceRoot()
  zip.extractAllTo(safePath(''), true)
  return { restored: true, ...meta }
}

export default { createWorkspaceSnapshot, listWorkspaceSnapshots, restoreWorkspaceSnapshot }
