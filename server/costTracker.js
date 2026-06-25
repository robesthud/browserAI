/**
 * costTracker.js
 *
 * Persistent per-user / per-chat cost accounting + daily cap.
 *
 * Schema:
 *   llm_spend (
 *     id INTEGER PK,
 *     user_id TEXT,
 *     chat_id TEXT,
 *     ts INTEGER,
 *     model TEXT,
 *     prompt_tokens INTEGER,
 *     completion_tokens INTEGER,
 *     cost_usd REAL
 *   )
 *
 * Hooked from agentLoop on every callLLM result.
 *
 * Daily cap: env BROWSERAI_DAILY_USD (default 5.00). If today's total
 * across all chats >= cap, runAgent refuses the next LLM call with a
 * clear error. Per-user override stored in user_facts key `daily_usd_cap`.
 */
import dbHandle from './db.js'
import { priceFor } from './modelKnowledge.js'

let _inited = false
function db() {
  const d = dbHandle
  if (!_inited) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS llm_spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS llm_spend_user_ts ON llm_spend(user_id, ts);
      CREATE INDEX IF NOT EXISTS llm_spend_chat ON llm_spend(chat_id);
    `)
    _inited = true
  }
  return d
}

/**
 * Record a single LLM call.
 * @returns {{cost: number, dailyTotal: number}}
 */
export function recordSpend({ userId = '', chatId = '', model = '', usage = {} } = {}) {
  try {
    const promptTokens     = Number(usage.prompt || usage.prompt_tokens || 0)
    const completionTokens = Number(usage.completion || usage.completion_tokens || 0)
    const priceResult = priceFor(model, promptTokens, completionTokens)
    const { cost = 0 } = priceResult || {}  // B — guard if priceFor returns undefined
    db().prepare(`INSERT INTO llm_spend
      (user_id, chat_id, ts, model, prompt_tokens, completion_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      String(userId || ''), String(chatId || ''), Date.now(),
      String(model || ''), promptTokens, completionTokens, cost,
    )
    return { cost, dailyTotal: dailyTotalUsd(userId) }
  } catch (e) {
    console.warn('[costTracker] record failed:', e?.message || e)
    return { cost: 0, dailyTotal: 0 }
  }
}

export function dailyTotalUsd(userId = '') {
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000
    const row = db().prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s
      FROM llm_spend WHERE user_id = ? AND ts >= ?`).get(String(userId || ''), since)
    return Number(row?.s || 0)
  } catch { return 0 }
}

export function chatTotalUsd(chatId = '') {
  try {
    const row = db().prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s, COUNT(*) AS n
      FROM llm_spend WHERE chat_id = ?`).get(String(chatId || ''))
    return { cost: Number(row?.s || 0), calls: Number(row?.n || 0) }
  } catch { return { cost: 0, calls: 0 } }
}

export function topModelsToday(userId = '', limit = 5) {
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000
    return db().prepare(`SELECT model, COUNT(*) AS calls,
      SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct, SUM(cost_usd) AS cost
      FROM llm_spend WHERE user_id = ? AND ts >= ?
      GROUP BY model ORDER BY cost DESC LIMIT ?`).all(String(userId || ''), since, limit)
  } catch { return [] }
}

/**
 * @returns {{ok: true} | {ok: false, reason: string, dailyTotal: number, cap: number}}
 */
export function checkCap(userId = '') {
  const cap = userDailyCap(userId)
  if (!cap) return { ok: true }
  const used = dailyTotalUsd(userId)
  if (used >= cap) {
    return { ok: false, reason: `Daily LLM spend cap reached: $${used.toFixed(3)} / $${cap.toFixed(2)}. Override with env BROWSERAI_DAILY_USD or remember_fact daily_usd_cap=NN.`, dailyTotal: used, cap }
  }
  return { ok: true, dailyTotal: used, cap }
}

function userDailyCap(userId = '') {
  // Per-user override via user_facts.
  try {
    const v = db().prepare(`SELECT value FROM user_facts WHERE user_id = ? AND key = 'daily_usd_cap'`).get(String(userId || ''))
    if (v?.value) {
      const n = Number(v.value)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch { /* table may not exist yet */ }
  const env = Number(process.env.BROWSERAI_DAILY_USD || '')
  return Number.isFinite(env) && env > 0 ? env : 5.0
}

export default { recordSpend, dailyTotalUsd, chatTotalUsd, topModelsToday, checkCap }
