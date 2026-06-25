import fs from 'node:fs/promises'
import path from 'node:path'
import { safePath } from './workspace.js'

const EVENT_LOG_REL = '.browserai/events.jsonl'
const MAX_EVENT_LOG_BYTES = Number(process.env.WORKSPACE_EVENT_LOG_MAX_BYTES || 2 * 1024 * 1024)
const READ_TAIL_BYTES = Number(process.env.WORKSPACE_EVENT_LOG_READ_TAIL_BYTES || 768 * 1024)

function nowIso() { return new Date().toISOString() }
function uniq(arr = []) { return [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))] }
function safeRunId(runId = '') { return String(runId || '').replace(/[/\\\0]/g, '_').slice(0, 128) }

function normalizeChangeEvent(evt = {}) {
  const pathValue = String(evt.path || '').replace(/^\/+/, '')
  if (!pathValue) return null
  return {
    schema: 'browserai.workspace_event.v1',
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: nowIso(),
    runId: safeRunId(evt.runId || evt.meta?.runId || ''),
    type: evt.type || 'file_changed',
    path: pathValue,
    tool: evt.tool || '',
    step: evt.step ?? null,
    sub: evt.sub ?? null,
    source: evt.source || 'agent_tool',
    meta: evt.meta && typeof evt.meta === 'object' ? { ...evt.meta, runId: safeRunId(evt.runId || evt.meta?.runId || '') || undefined } : {},
  }
}

async function rotateEventLogIfNeeded(full) {
  if (!MAX_EVENT_LOG_BYTES || MAX_EVENT_LOG_BYTES < 128 * 1024) return false
  const st = await fs.stat(full).catch(() => null)
  if (!st || st.size <= MAX_EVENT_LOG_BYTES) return false
  const rotated = `${full}.1`
  await fs.rm(rotated, { force: true }).catch(() => {})
  await fs.rename(full, rotated).catch(() => {})
  return true
}

async function readTailText(full, maxBytes = READ_TAIL_BYTES) {
  const st = await fs.stat(full).catch(() => null)
  if (!st?.isFile()) return ''
  const size = st.size
  const start = Math.max(0, size - Math.max(1024, Number(maxBytes) || READ_TAIL_BYTES))
  const fh = await fs.open(full, 'r')
  try {
    const len = size - start
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const firstNl = text.indexOf('\n')
      text = firstNl >= 0 ? text.slice(firstNl + 1) : ''
    }
    return text
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function appendWorkspaceEvents(events = []) {
  const normalized = events.map(normalizeChangeEvent).filter(Boolean)
  if (!normalized.length) return []
  const full = safePath(EVENT_LOG_REL)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await rotateEventLogIfNeeded(full)
  await fs.appendFile(full, normalized.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return normalized
}

export async function readWorkspaceEvents({ limit = 200, runId = '', path: wantedPath = '' } = {}) {
  const full = safePath(EVENT_LOG_REL)
  const text = await readTailText(full).catch(() => '')
  if (!text.trim()) return []
  const max = Math.max(1, Math.min(1000, Number(limit) || 200))
  const targetRunId = safeRunId(runId)
  const targetPath = String(wantedPath || '').replace(/^\/+/, '')
  const out = []
  const lines = text.trim().split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
    let evt = null
    try { evt = JSON.parse(lines[i]) } catch { continue }
    if (targetRunId && evt.runId !== targetRunId && evt.meta?.runId !== targetRunId) continue
    if (targetPath && evt.path !== targetPath && evt.meta?.diff?.path !== targetPath) continue
    out.push(evt)
  }
  return out.reverse()
}

export async function readWorkspaceDiffs({ limit = 200, runId = '', path = '' } = {}) {
  const events = await readWorkspaceEvents({ limit, runId, path })
  const diffs = []
  for (const event of events) {
    const diff = event?.meta?.diff
    if (!diff?.patch) continue
    diffs.push({ eventId: event.id, runId: event.runId || event.meta?.runId || '', ts: event.ts, tool: event.tool, type: event.type, path: event.path, diff })
  }
  return diffs
}

export function buildToolWorkspaceEvents({ tool = '', args = {}, result = {}, ok = true, step = null, sub = null, runId = '' } = {}) {
  if (!ok) return []
  const events = []
  const safeRid = safeRunId(runId)
  const diffsByPath = new Map((result?.changedFiles?.diffs || (result?.diffPreview ? [result.diffPreview] : [])).map((d) => [String(d?.path || ''), d]).filter(([p]) => p))
  const push = (type, p, meta = {}) => {
    const diff = diffsByPath.get(String(p || ''))
    events.push({ type, path: p, tool, step, sub, runId: safeRid, meta: diff ? { ...meta, diff, runId: safeRid || undefined } : { ...meta, runId: safeRid || undefined } })
  }

  const changed = result?.changedFiles
  if (changed && typeof changed === 'object') {
    for (const p of uniq(changed.created || [])) push('file_created', p, { via: 'changedFiles' })
    for (const p of uniq(changed.modified || [])) push('file_modified', p, { via: 'changedFiles' })
    for (const p of uniq(changed.deleted || [])) push('file_deleted', p, { via: 'changedFiles' })
    return events
  }

  const p = result?.path || result?.file_path || args?.path || args?.file_path || ''
  if (tool === 'write_file') push('file_written', p, { bytes: result?.bytes ?? null })
  else if (tool === 'edit_file') push('file_modified', p, { replaced: result?.replaced ?? null })
  else if (tool === 'delete_file') push('file_deleted', result?.deleted || p)
  else if (tool === 'create_folder') push('folder_created', result?.path || p)
  else if (tool === 'rename_item') {
    if (result?.old_path) push('file_deleted', result.old_path, { renamedTo: result?.path || '' })
    if (result?.path) push('file_created', result.path, { renamedFrom: result?.old_path || '' })
  } else if (tool === 'zip_files') push('file_created', result?.file_path || result?.path || p, { entries: result?.entries ?? null })
  else if (tool === 'git_clone') push('folder_created', result?.path || args?.dest || '', { url: args?.url || '' })
  else if (tool === 'generate_image' || tool === 'edit_image' || tool === 'generate_video' || tool === 'text_to_speech') push('file_created', result?.file_path || p)

  return events
}

export async function recordToolWorkspaceEvents(input = {}) {
  const events = buildToolWorkspaceEvents(input)
  return appendWorkspaceEvents(events)
}

export const __test = { normalizeChangeEvent, safeRunId }
export default recordToolWorkspaceEvents
