import db from './db.js'

let inited = false
function init() {
  if (inited) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      chat_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      goal TEXT NOT NULL DEFAULT '',
      task_type TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL DEFAULT '{}',
      history_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_chat ON agent_tasks(chat_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
  `)
  inited = true
}

function id() { return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(s, fallback) { try { return JSON.parse(s || '') } catch { return fallback } }

function rowToTask(r) {
  if (!r) return null
  return {
    id: r.id,
    userId: r.user_id,
    chatId: r.chat_id,
    status: r.status,
    goal: r.goal,
    taskType: r.task_type,
    phase: r.phase,
    state: parse(r.state_json, {}),
    history: parse(r.history_json, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  }
}

export function createAgentTask({ userId = '', chatId = '', goal = '', taskType = '', phase = '', state = {}, history = [] } = {}) {
  init()
  const taskId = id()
  const ts = Date.now()
  db.prepare(`INSERT INTO agent_tasks (id,user_id,chat_id,status,goal,task_type,phase,state_json,history_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    taskId, String(userId || ''), String(chatId || ''), 'running', String(goal || '').slice(0, 4000), String(taskType || ''), String(phase || ''),
    JSON.stringify(state || {}), JSON.stringify(history || []), ts, ts,
  )
  return getAgentTask(taskId)
}

export function updateAgentTask(id, patch = {}) {
  init()
  const cur = getAgentTask(id)
  if (!cur) return null
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  db.prepare(`UPDATE agent_tasks SET status=?, goal=?, task_type=?, phase=?, state_json=?, history_json=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status || cur.status,
    String(next.goal || '').slice(0, 4000),
    next.taskType || '',
    next.phase || '',
    JSON.stringify(next.state || {}),
    JSON.stringify(next.history || []),
    next.updatedAt,
    next.finishedAt || null,
    id,
  )
  return getAgentTask(id)
}

export function finishAgentTask(id, { status = 'succeeded', state = null, history = null } = {}) {
  const patch = { status, finishedAt: Date.now() }
  if (state) patch.state = state
  if (history) patch.history = history
  return updateAgentTask(id, patch)
}

export function getAgentTask(id) {
  init()
  return rowToTask(db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(String(id || '')))
}

export function latestAgentTask({ chatId = '', userId = '', includeDone = true } = {}) {
  init()
  const statuses = includeDone ? "'running','failed','succeeded','cancelled'" : "'running','failed'"
  const row = chatId
    ? db.prepare(`SELECT * FROM agent_tasks WHERE chat_id=? AND status IN (${statuses}) ORDER BY updated_at DESC LIMIT 1`).get(String(chatId))
    : db.prepare(`SELECT * FROM agent_tasks WHERE user_id=? AND status IN (${statuses}) ORDER BY updated_at DESC LIMIT 1`).get(String(userId || ''))
  return rowToTask(row)
}

export function listAgentTasks({ chatId = '', userId = '', limit = 20 } = {}) {
  init()
  const max = Math.max(1, Math.min(100, Number(limit) || 20))
  const rows = chatId
    ? db.prepare('SELECT * FROM agent_tasks WHERE chat_id=? ORDER BY updated_at DESC LIMIT ?').all(String(chatId), max)
    : db.prepare('SELECT * FROM agent_tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(String(userId || ''), max)
  return rows.map(rowToTask)
}

export function buildResumeSystemMessage(task) {
  if (!task) return ''
  const state = task.state || {}
  return `<arena-system-message>\nResume previous BrowserAI task.\nTask id: ${task.id}\nStatus: ${task.status}\nGoal: ${task.goal}\nType: ${task.taskType}\nPhase: ${task.phase}\nCurrent step: ${state.currentStep || ''}\nPlan: ${(state.plan?.steps || []).map(s => `${s.done ? '[x]' : '[ ]'} ${s.idx}. ${s.text}`).join('\n')}\nTouched files: ${(state.touchedFiles || []).join(', ')}\nLast errors: ${(state.lastErrors || []).join(' | ')}\nContinue from this state. Do not restart from scratch unless necessary.\n</arena-system-message>`
}

export default { createAgentTask, updateAgentTask, finishAgentTask, getAgentTask, latestAgentTask, listAgentTasks, buildResumeSystemMessage }
