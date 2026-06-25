// chatPurge.js — полное изолированное удаление чата
//
// Удаляет ВСЁ, связанное с chatId:
//   • semantic_memory + semantic_memory_fts
//   • agent_tasks (вся история)
//   • agent_workflows / agent_workflow_steps
//   • telegram_chats_v2 (AI-история бота)
//   • tg_chats / tg_messages (Telegram лог)
//   • deploy_sessions / deploy_session_events (если есть колонка chat_id)
//   • notifications (по chat_id)
//   • workspace/chats/<chatId>/ — все файлы (через deleteWorkspaceScope)
//   • replays/ и runs/ в /opt/browserai-data (по chatId в имени)
//
// Использование:
//   import { purgeChat } from './chatPurge.js'
//   await purgeChat('mqiedf1b1x5279su')
//
// Возвращает: { chatId, deleted: { semantic_memory: N, agent_tasks: N, ... }, filesDeleted: bool, bytesFreed: number }

import db from './db.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deleteWorkspaceScope, sanitizeScopeId } from './workspace.js'

// Кэшируем WORKSPACE_ROOT чтобы не дёргать env каждый раз
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace'

function safeDel(table, where, params) {
  try {
    const r = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params)
    return r.changes || 0
  } catch (e) {
    // таблица может не существовать или не иметь нужной колонки
    return 0
  }
}

function safeCount(table, where, params) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params)?.c || 0
  } catch {
    return 0
  }
}

// Рекурсивно вычисляет размер директории
async function getDirSize(dir, _depth = 0) {
  if (_depth > 20) return 0  // CP-1: symlink loop / deep tree protection
  let total = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue  // CP-1: skip symlinks entirely to avoid loops
      if (e.isDirectory()) {
        total += await getDirSize(full, _depth + 1)
      } else {
        const s = await fs.stat(full).catch(() => null)
        if (s) total += s.size
      }
    }
  } catch {
    /* dir doesn't exist or unreadable */
  }
  return total
}

export async function purgeChat(chatId) {
  if (!chatId) throw new Error('chatId required')
  const clean = sanitizeScopeId ? sanitizeScopeId(chatId) : String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!clean) throw new Error('invalid chatId')

  const stats = {
    chatId: clean,
    deleted: {},
    filesDeleted: false,
    bytesFreed: 0,
  }

  // 1. Считаем сколько будет удалено (для отчёта)
  stats.deleted.semantic_memory = safeCount('semantic_memory', 'chat_id = ?', [clean])
  stats.deleted.semantic_memory_fts = safeCount(
    'semantic_memory_fts',
    'mem_id NOT IN (SELECT id FROM semantic_memory)',
    []
  )
  stats.deleted.agent_tasks = safeCount('agent_tasks', 'chat_id = ?', [clean])
  stats.deleted.agent_workflows = safeCount('agent_workflows', 'chat_id = ?', [clean])
  stats.deleted.agent_workflow_steps = safeCount('agent_workflow_steps', 'chat_id = ?', [clean])
  stats.deleted.telegram_chats_v2 = safeCount('telegram_chats_v2', 'chat_id = ?', [clean])
  stats.deleted.tg_chats = safeCount('tg_chats', 'chat_id = ?', [clean])
  stats.deleted.tg_messages = safeCount('tg_messages', 'chat_id = ?', [clean])
  stats.deleted.deploy_sessions = safeCount('deploy_sessions', 'chat_id = ?', [clean])
  stats.deleted.deploy_session_events = safeCount(
    'deploy_session_events',
    'session_id IN (SELECT id FROM deploy_sessions WHERE chat_id = ?)',
    [clean]
  )
  stats.deleted.notifications = safeCount(
    'notifications',
    "entity_type = 'chat' AND entity_id = ?",
    [clean]
  )
  stats.deleted.checkpoints = safeCount('checkpoints', 'chat_id = ?', [clean])

  // 2. Транзакция для БД (всё атомарно — либо всё удалится, либо ничего)
  const tx = db.transaction(() => {
    safeDel('semantic_memory', 'chat_id = ?', [clean])
    // FTS: удаляем осиротевшие записи (на которые больше нет ссылок в semantic_memory)
    safeDel('semantic_memory_fts', 'mem_id NOT IN (SELECT id FROM semantic_memory)', [])

    safeDel('agent_tasks', 'chat_id = ?', [clean])
    safeDel('agent_workflows', 'chat_id = ?', [clean])
    safeDel('agent_workflow_steps', 'chat_id = ?', [clean])

    safeDel('telegram_chats_v2', 'chat_id = ?', [clean])
    safeDel('tg_chats', 'chat_id = ?', [clean])
    safeDel('tg_messages', 'chat_id = ?', [clean])

    safeDel('deploy_sessions', 'chat_id = ?', [clean])
    safeDel(
      'deploy_session_events',
      'session_id IN (SELECT id FROM deploy_sessions WHERE chat_id = ?)',
      [clean]
    )

    safeDel('notifications', "entity_type = 'chat' AND entity_id = ?", [clean])
    safeDel('checkpoints', 'chat_id = ?', [clean])
  })

  try {
    tx()
  } catch (e) {
    console.error('[purgeChat] transaction failed:', e.message)
    throw e
  }

  // 3. Удаляем файлы воркспейса
  // Используем тот же WORKSPACE_ROOT что и workspace.js (через env WORKSPACE_ROOT=/workspace)
  const target = path.join(WORKSPACE_ROOT, 'chats', clean)
  try {
    // Измеряем размер до удаления
    stats.bytesFreed = await getDirSize(target)
    // deleteWorkspaceScope делает безопасное удаление (с проверкой path traversal)
    await deleteWorkspaceScope(clean)
    stats.filesDeleted = true
  } catch (e) {
    stats.filesDeleted = false
    stats.fileError = e.message
    console.warn(`[purgeChat] workspace delete failed for ${clean}: ${e.message}`)
  }

  // 4. Удаляем replays / runs файлы по chatId в имени
  for (const dir of ['replays', 'runs']) {
    try {
      const dirPath = path.join('/opt/browserai-data', dir)
      const entries = await fs.readdir(dirPath).catch(() => [])
      for (const e of entries) {
        if (e.includes(clean)) {
          await fs.rm(path.join(dirPath, e), { force: true }).catch(() => {})
          stats.bytesFreed += 1024 // приблизительно
        }
      }
    } catch {
      /* ignore */
    }
  }

  return stats
}

export async function purgeMany(chatIds) {
  const results = []
  for (const id of chatIds) {
    try {
      results.push({ ok: true, ...(await purgeChat(id)) })
    } catch (e) {
      results.push({ ok: false, chatId: id, error: e.message })
    }
  }
  return results
}
