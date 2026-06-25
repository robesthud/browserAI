/**
 * projectMemory.js — Project-specific persistent memory.
 *
 * Отличие от user_facts (глобальные предпочтения пользователя):
 * project_memory привязана к конкретному chatId/workspaceScope и хранит
 * технический контекст проекта: стек, сервер, команды, токены-placeholders.
 *
 * Структура записи:
 *   { userId, chatId, key, value, updated_at }
 *
 * Агент читает её автоматически при первом шаге в чате.
 * Агент записывает через инструмент remember_fact (уже существующий),
 * но с привязкой к chatId.
 *
 * Лимиты: 100 записей/чат, 600 символов/значение.
 */

import db from './db.js'

let initialized = false

function init() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL DEFAULT '',
      chat_id     TEXT NOT NULL DEFAULT '',
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pm_chat ON project_memory(user_id, chat_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_key ON project_memory(user_id, chat_id, key);
  `)
  initialized = true
}

const MAX_PER_CHAT = 100
const MAX_VALUE_LEN = 600

function normalizeKey(k) {
  return String(k || '').trim().slice(0, 120).replace(/\s+/g, '_').toLowerCase()
}

export function upsertProjectFact(userId, chatId, key, value) {
  init()
  if (!userId || !chatId) return null
  const k = normalizeKey(key)
  if (!k) return null
  const v = String(value || '').slice(0, MAX_VALUE_LEN)
  const ts = Date.now()
  // P4: wrap upsert + cap enforcement in a transaction
  db.transaction(() => {
    db.prepare(`
      INSERT INTO project_memory (user_id, chat_id, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, chat_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(userId, chatId, k, v, ts)

    // Enforce per-chat cap — delete oldest beyond limit
    const over = db.prepare(`
      SELECT id FROM project_memory WHERE user_id=? AND chat_id=?
      ORDER BY updated_at ASC LIMIT max(0, (SELECT COUNT(*) FROM project_memory WHERE user_id=? AND chat_id=?) - ?)
    `).all(userId, chatId, userId, chatId, MAX_PER_CHAT)
    for (const r of over) db.prepare('DELETE FROM project_memory WHERE id=?').run(r.id)
  })()

  return { key: k, value: v, updated_at: ts }
}

export function listProjectFacts(userId, chatId) {
  init()
  if (!userId || !chatId) return []
  return db.prepare(
    'SELECT key, value, updated_at FROM project_memory WHERE user_id=? AND chat_id=? ORDER BY updated_at DESC LIMIT ?'
  ).all(userId, chatId, MAX_PER_CHAT)
}

export function forgetProjectFact(userId, chatId, key) {
  init()
  if (!userId || !chatId) return { deleted: 0 }
  // P5: sanitize chatId (same pattern as sanitizeScopeId in workspace.js)
  const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  if (!safeChatId) return { deleted: 0 }
  const k = normalizeKey(key)
  const r = db.prepare('DELETE FROM project_memory WHERE user_id=? AND chat_id=? AND key=?').run(userId, safeChatId, k)
  return { deleted: r.changes }
}

export function renderProjectMemoryForPrompt(userId, chatId) {
  const facts = listProjectFacts(userId, chatId)
  if (!facts.length) return ''
  const lines = ['# Project context (from previous sessions in this chat)', '']
  for (const f of facts) {
    lines.push(`- **${f.key}**: ${f.value}`)
  }
  lines.push('')
  lines.push('Use these when relevant. Update via remember_fact if they change.')
  return lines.join('\n')
}

export default { upsertProjectFact, listProjectFacts, forgetProjectFact, renderProjectMemoryForPrompt }
