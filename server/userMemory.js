/**
 * Cross-session "facts about the user" — small key/value memory the agent
 * uses to remember preferences ('Tailwind v3, not v4'), recurring contexts
 * ('main repo lives at /opt/browserai'), and project conventions.
 *
 * Lives in the existing SQLite next to user accounts. Limited per user:
 *   - 200 facts max
 *   - each fact text ≤ 1 KB
 *   - whole bundle ≤ 16 KB (we only ever inject this much into the LLM
 *     prompt anyway)
 *
 * Exposed to the agent via two tools (server/agentTools.js):
 *   remember_fact({key, value})  — upserts a fact
 *   forget_fact({key})           — deletes a fact
 *
 * The agent receives the current fact bundle as part of every system
 * prompt (injected by /api/agent/chat).
 */
import db from './db.js'

let initialized = false
function init() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_facts (
      user_id   TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_facts_user ON user_facts(user_id);
  `)
  initialized = true
}

const MAX_FACTS_PER_USER = 200
const MAX_VALUE_LEN = 1024
const MAX_BUNDLE_BYTES = 16 * 1024

function normaliseKey(k) {
  return String(k || '').trim().slice(0, 120).replace(/\s+/g, '_')
}

export function listFacts(userId) {
  init()
  if (!userId) return []
  return db.prepare(
    'SELECT key, value, updated_at FROM user_facts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?'
  ).all(userId, MAX_FACTS_PER_USER)
}

export function upsertFact(userId, key, value) {
  init()
  if (!userId) throw new Error('userId required')
  const k = normaliseKey(key)
  if (!k) throw new Error('key required')
  const v = String(value || '').slice(0, MAX_VALUE_LEN)
  const ts = Date.now()
  db.prepare(`
    INSERT INTO user_facts (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, k, v, ts)

  // Enforce per-user cap by trimming the oldest.
  // D — LIMIT -1 is implementation-defined in some SQLite builds; use subquery COUNT instead
  //   We simply delete all rows beyond the cap ordered by oldest.
  const over = db.prepare(
    'SELECT key FROM user_facts WHERE user_id = ? ORDER BY updated_at ASC LIMIT max(0, (SELECT COUNT(*) FROM user_facts WHERE user_id=?) - ?)'
  ).all(userId, userId, MAX_FACTS_PER_USER)
  for (const r of over) {
    db.prepare('DELETE FROM user_facts WHERE user_id = ? AND key = ?').run(userId, r.key)
  }
  return { key: k, value: v, updated_at: ts }
}

export function forgetFact(userId, key) {
  init()
  if (!userId) throw new Error('userId required')
  const k = normaliseKey(key)
  const r = db.prepare('DELETE FROM user_facts WHERE user_id = ? AND key = ?').run(userId, k)
  return { deleted: r.changes }
}

/**
 * Render the current fact bundle as a markdown block for system-prompt
 * injection. Capped to MAX_BUNDLE_BYTES.
 */
export function renderFactsForPrompt(userId) {
  init()
  const facts = listFacts(userId)
  if (!facts.length) return ''
  const lines = ['# What I remember about you (cross-session facts)', '']
  let used = 0
  for (const f of facts) {
    const line = `- **${f.key}**: ${f.value}`
    if (used + line.length + 1 > MAX_BUNDLE_BYTES) break
    lines.push(line)
    used += line.length + 1
  }
  if (used === 0) return ''
  lines.push('')
  lines.push('Use these whenever they apply. If the user explicitly tells you to update or forget one, call remember_fact or forget_fact.')
  return lines.join('\n')
}
