/**
 * checkpoints.js
 *
 * Session-level "checkpoint" system: after every successful write/edit
 * tool we record a row that groups all the file revisions touched by
 * the current agent step. The actual rev files are already produced
 * by workspace.writeFileContent() / createFile() (saveRevisionSnapshot
 * format: `<base>.<ts>.<hash>.<reason>.rev`).
 *
 * Restoring a checkpoint = call workspace.restoreFileRevision() for
 * each file recorded under that (chatId, step). One-click "undo turn".
 *
 * Schema:
 *   checkpoints (
 *     id INTEGER PK,
 *     chat_id TEXT,
 *     step INTEGER,
 *     ts INTEGER,
 *     label TEXT,
 *     file_path TEXT,
 *     revision_id TEXT   -- the .rev filename, e.g. "App.jsx.1715900000000.abc12345.edit.rev"
 *   )
 */
import dbHandle from './db.js'
import { withWorkspaceScope, restoreFileRevision, getFileHistory } from './workspace.js'

let _inited = false
function db() {
  if (!_inited) {
    dbHandle.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL DEFAULT '',
        step INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL,
        revision_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS checkpoints_chat_step ON checkpoints(chat_id, step);
    `)
    _inited = true
  }
  return dbHandle
}

/**
 * Look up the most-recent revision id for a file inside the current
 * workspace scope. Returns '' if none found (e.g. file was created
 * before history existed, or pure delete without backup).
 */
async function latestRevisionId(chatId, filePath) {
  try {
    return await withWorkspaceScope(chatId, async () => {
      const items = await getFileHistory(filePath)
      // getFileHistory returns sorted DESC by createdAt; revisionId = .rev filename
      return items[0]?.revisionId || ''
    })
  } catch { return '' }
}

/**
 * Record a checkpoint snapshot for each touched file.
 * Called from agentLoop right after a successful write-class tool.
 *
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {number} opts.step
 * @param {string} opts.label    — usually the tool name ("edit_file")
 * @param {string[]} opts.files  — relative paths of files just modified
 */
export async function recordCheckpoint({ chatId, step, label, files = [] }) {
  const stmt = db().prepare(`INSERT INTO checkpoints
    (chat_id, step, ts, label, file_path, revision_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
  for (const fp of files) {
    if (!fp) continue
    const rev = await latestRevisionId(chatId, fp)
    try {
      stmt.run(String(chatId || ''), Number(step) || 0, Date.now(),
               String(label || ''), String(fp), String(rev || ''))
    } catch (e) {
      console.warn('[checkpoints] insert failed:', e?.message || e)
    }
  }
}

/**
 * List all checkpoints (grouped by step) for a chat.
 */
export function listCheckpoints(chatId = '') {
  try {
    const rows = db().prepare(`SELECT step, MIN(ts) AS ts, label,
      COUNT(*) AS file_count,
      GROUP_CONCAT(file_path, '|') AS files
      FROM checkpoints WHERE chat_id = ?
      GROUP BY step, label ORDER BY step DESC, ts DESC LIMIT 50`).all(String(chatId || ''))
    return rows.map((r) => ({
      step: r.step, ts: r.ts, label: r.label,
      fileCount: r.file_count,
      files: String(r.files || '').split('|').filter(Boolean),
    }))
  } catch { return [] }
}

/**
 * Restore every file in a given checkpoint to its snapshot. Uses
 * workspace.restoreFileRevision() which already handles the scoped
 * path resolution AND records a `restore` rev so the restore itself
 * is undoable.
 */
export async function restoreCheckpoint({ chatId, step }) {
  const rows = db().prepare(`SELECT file_path, revision_id FROM checkpoints
    WHERE chat_id = ? AND step = ?`).all(String(chatId || ''), Number(step) || 0)
  const restored = []
  const failed = []
  await withWorkspaceScope(chatId, async () => {
    for (const r of rows) {
      if (!r.revision_id) {
        failed.push({ path: r.file_path, error: 'no revision recorded — file was created with no prior version' })
        continue
      }
      try {
        await restoreFileRevision(r.file_path, r.revision_id)
        restored.push({ path: r.file_path })
      } catch (e) {
        failed.push({ path: r.file_path, error: e.message })
      }
    }
  })
  return { restored, failed }
}

export default { recordCheckpoint, listCheckpoints, restoreCheckpoint }
