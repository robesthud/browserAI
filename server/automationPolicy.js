import db from './db.js'

let initialized = false

const DEFAULT_POLICY = {
  version: 1,
  scheduledAllowRisk: ['safe'],
  manualAllowRisk: ['safe', 'production-write'],
  requireConfirmRisk: ['production-write'],
  maxRunningWorkflowsPerUser: 3,
  maxProductionWritesPerHour: 3,
  denyRecipes: [],
}

export function initAutomationPolicy() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_policy_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      recipe_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  initialized = true
}

function eventId() { return `pol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

export function getAutomationPolicy() {
  return { ...DEFAULT_POLICY }
}

function audit({ userId = '', recipeId = '', source = '', decision = '', reason = '', risk = '' } = {}) {
  initAutomationPolicy()
  db.prepare(`INSERT INTO automation_policy_events (id,user_id,recipe_id,source,decision,reason,risk,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(eventId(), String(userId || ''), String(recipeId || ''), String(source || ''), String(decision || ''), String(reason || ''), String(risk || ''), Date.now())
}

export function listAutomationPolicyEvents({ userId = '', limit = 100 } = {}) {
  initAutomationPolicy()
  const max = Math.max(1, Math.min(500, Number(limit) || 100))
  const rows = userId
    ? db.prepare('SELECT * FROM automation_policy_events WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(String(userId), max)
    : db.prepare('SELECT * FROM automation_policy_events ORDER BY created_at DESC LIMIT ?').all(max)
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, recipeId: r.recipe_id, source: r.source,
    decision: r.decision, reason: r.reason, risk: r.risk, createdAt: r.created_at,
  }))
}

function countRunning(userId = '') {
  try {
    return db.prepare(`SELECT COUNT(*) c FROM agent_workflows WHERE user_id=? AND status IN ('queued','running')`).get(String(userId || '')).c || 0
  } catch { return 0 }
}

function countRecentProductionWrites(userId = '') {
  try {
    return db.prepare(`
      SELECT COUNT(*) c FROM automation_policy_events
       WHERE user_id=? AND decision='allow' AND risk='production-write' AND created_at > ?
    `).get(String(userId || ''), Date.now() - 60 * 60 * 1000).c || 0
  } catch { return 0 }
}

export function evaluateWorkflowStart({ recipe, userId = '', source = 'manual', confirm = false } = {}) {
  initAutomationPolicy()
  const policy = getAutomationPolicy()
  if (!recipe?.id) return { ok: false, code: 'UNKNOWN_RECIPE', reason: 'Unknown recipe' }
  const risk = recipe.risk || 'safe'

  let decision = { ok: true, code: 'ALLOW', reason: 'Allowed by policy', requiresConfirmation: false, policy }

  if (policy.denyRecipes.includes(recipe.id)) {
    decision = { ok: false, code: 'POLICY_DENY', reason: `Recipe ${recipe.id} is denied by policy`, policy }
  } else if (source === 'schedule' && !policy.scheduledAllowRisk.includes(risk)) {
    decision = { ok: false, code: 'POLICY_SCHEDULE_DENY', reason: `Scheduled automations may run only risks: ${policy.scheduledAllowRisk.join(', ')}`, policy }
  } else if (source !== 'schedule' && !policy.manualAllowRisk.includes(risk)) {
    decision = { ok: false, code: 'POLICY_MANUAL_DENY', reason: `Manual automations may run only risks: ${policy.manualAllowRisk.join(', ')}`, policy }
  } else if (countRunning(userId) >= policy.maxRunningWorkflowsPerUser) {
    decision = { ok: false, code: 'TOO_MANY_RUNNING', reason: `Max running workflows per user is ${policy.maxRunningWorkflowsPerUser}`, policy }
  } else if (risk === 'production-write' && countRecentProductionWrites(userId) >= policy.maxProductionWritesPerHour) {
    decision = { ok: false, code: 'PROD_RATE_LIMIT', reason: `Max production-write workflows per hour is ${policy.maxProductionWritesPerHour}`, policy }
  } else if ((recipe.requiresConfirmation || policy.requireConfirmRisk.includes(risk)) && confirm !== true) {
    decision = { ok: false, code: 'CONFIRM_REQUIRED', reason: `Recipe ${recipe.id} requires confirmation`, requiresConfirmation: true, policy }
  }

  audit({ userId, recipeId: recipe.id, source, decision: decision.ok ? 'allow' : 'deny', reason: decision.reason, risk })
  return { ...decision, risk, source }
}

export default { initAutomationPolicy, getAutomationPolicy, evaluateWorkflowStart, listAutomationPolicyEvents }
