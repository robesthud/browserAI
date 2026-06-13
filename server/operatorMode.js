import db from './db.js'
import { createWorkflow, getWorkflow, startWorkflow } from './agentWorkflows.js'
import { createJob, getJob, startJob } from './jobs.js'
import { getActiveKeyDecrypted } from './db.js'
import { runOpsAction } from './ops.js'

let initialized = false

function now() { return Date.now() }
function id(prefix = 'op') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }

export const OPERATOR_MISSION_TYPES = [
  {
    id: 'full_diagnostic',
    title: 'Full diagnostic',
    icon: '🔎',
    description: 'Собрать полную безопасную диагностику BrowserAI: health, docker, logs, git sync, GitHub CI.',
    risk: 'safe',
    recipeId: 'browserai_full_diagnostic',
  },
  {
    id: 'fix_deploy',
    title: 'Fix deploy / investigate',
    icon: '🧯',
    description: 'Начать с полной диагностики деплоя и создать отчёт/RCA. Следующий repair/deploy — только по подтверждению.',
    risk: 'safe',
    recipeId: 'browserai_full_diagnostic',
  },
  {
    id: 'safe_deploy',
    title: 'Safe deploy',
    icon: '🚀',
    description: 'Production deploy через policy, rollback и health checks. Требует подтверждения.',
    risk: 'production-write',
    recipeId: 'browserai_deploy_safe',
    requiresConfirmation: true,
  },
  {
    id: 'self_heal_restart',
    title: 'Self-heal restart',
    icon: '🛠️',
    description: 'Диагностика + restart browserai + health verification. Требует подтверждения.',
    risk: 'production-write',
    recipeId: 'production_self_heal_restart',
    requiresConfirmation: true,
  },
  {
    id: 'custom_agent',
    title: 'Custom operator agent',
    icon: '🤖',
    description: 'Запустить фонового агента с operator-инструкциями по произвольной задаче.',
    risk: 'agent',
  },
]

export function initOperatorMode() {
  if (initialized) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL DEFAULT '',
      local_path TEXT NOT NULL DEFAULT '',
      production_path TEXT NOT NULL DEFAULT '',
      default_branch TEXT NOT NULL DEFAULT 'main',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operator_projects_user ON operator_projects(user_id, updated_at);
    CREATE TABLE IF NOT EXISTS operator_missions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      goal TEXT NOT NULL DEFAULT '',
      workflow_id TEXT NOT NULL DEFAULT '',
      job_id TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_operator_missions_user ON operator_missions(user_id, updated_at);
  `)
  initialized = true
}

function rowToProject(r) {
  if (!r) return null
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    repo: r.repo,
    localPath: r.local_path,
    productionPath: r.production_path,
    defaultBranch: r.default_branch,
    meta: parse(r.meta_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToMission(r) {
  if (!r) return null
  const mission = {
    id: r.id,
    userId: r.user_id,
    projectId: r.project_id,
    type: r.type,
    title: r.title,
    status: r.status,
    goal: r.goal,
    workflowId: r.workflow_id || '',
    jobId: r.job_id || '',
    result: parse(r.result_json, {}),
    error: r.error || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  }
  if (mission.workflowId) mission.workflow = getWorkflow(mission.workflowId)
  if (mission.jobId) mission.job = getJob(mission.jobId)
  return mission
}

function ensureDefaultProject(userId = '') {
  initOperatorMode()
  const existing = db.prepare(`SELECT * FROM operator_projects WHERE user_id=? AND id='browserai'`).get(String(userId || ''))
  if (existing) return rowToProject(existing)
  const ts = now()
  db.prepare(`INSERT OR IGNORE INTO operator_projects (id,user_id,name,repo,local_path,production_path,default_branch,meta_json,created_at,updated_at)
    VALUES ('browserai',?,?,?,?,?,?,?, ?, ?)`).run(
    String(userId || ''),
    'BrowserAI',
    process.env.GITHUB_REPO || 'robesthud/browserAI',
    '/workspace/projects/browserAI',
    process.env.OPS_APP_DIR || '/opt/browserai',
    'main',
    JSON.stringify({ role: 'primary-self-project', operatorMode: true }),
    ts,
    ts,
  )
  return rowToProject(db.prepare(`SELECT * FROM operator_projects WHERE user_id=? AND id='browserai'`).get(String(userId || '')))
}

export function listOperatorProjects({ userId = '' } = {}) {
  initOperatorMode()
  ensureDefaultProject(userId)
  return db.prepare('SELECT * FROM operator_projects WHERE user_id=? ORDER BY updated_at DESC').all(String(userId || '')).map(rowToProject)
}

export function upsertOperatorProject({ userId = '', id: projectId = '', name = '', repo = '', localPath = '', productionPath = '', defaultBranch = 'main', meta = {} } = {}) {
  initOperatorMode()
  const projectKey = String(projectId || name || id('project')).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)
  const ts = now()
  db.prepare(`INSERT INTO operator_projects (id,user_id,name,repo,local_path,production_path,default_branch,meta_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, repo=excluded.repo, local_path=excluded.local_path,
      production_path=excluded.production_path, default_branch=excluded.default_branch, meta_json=excluded.meta_json, updated_at=excluded.updated_at`).run(
    projectKey, String(userId || ''), String(name || projectKey), String(repo || ''), String(localPath || ''), String(productionPath || ''), String(defaultBranch || 'main'), JSON.stringify(meta || {}), ts, ts,
  )
  return rowToProject(db.prepare('SELECT * FROM operator_projects WHERE id=?').get(projectKey))
}

function patchMission(missionId, patch = {}) {
  const cur = db.prepare('SELECT * FROM operator_missions WHERE id=?').get(missionId)
  if (!cur) return null
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE operator_missions SET status=?, workflow_id=?, job_id=?, result_json=?, error=?, updated_at=?, finished_at=? WHERE id=?`).run(
    next.status || cur.status,
    next.workflow_id ?? next.workflowId ?? cur.workflow_id ?? '',
    next.job_id ?? next.jobId ?? cur.job_id ?? '',
    JSON.stringify(next.result || parse(cur.result_json, {})),
    next.error || '',
    now(),
    next.finished_at ?? next.finishedAt ?? cur.finished_at ?? null,
    missionId,
  )
  return getOperatorMission(missionId)
}

export function getOperatorMission(missionId) {
  initOperatorMode()
  return rowToMission(db.prepare('SELECT * FROM operator_missions WHERE id=?').get(String(missionId || '')))
}

export function listOperatorMissions({ userId = '', limit = 30 } = {}) {
  initOperatorMode()
  const max = Math.max(1, Math.min(100, Number(limit) || 30))
  return db.prepare('SELECT * FROM operator_missions WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(String(userId || ''), max).map(rowToMission)
}

function operatorSystemPrompt(project, missionType) {
  return [
    '[operator-mode]',
    'You are BrowserAI Operator Mode: act like a senior developer/operator agent.',
    'Work until the task is actually done, not merely described.',
    'Mandatory loop: inspect → plan → change via tools → verify → deploy/follow logs when requested → report.',
    'Never claim success without tool evidence. Use workflows/ops tools for production actions and ask for approval when policy requires it.',
    `Project: ${project?.name || 'BrowserAI'} (${project?.repo || ''})`,
    `Production path: ${project?.productionPath || '/opt/browserai'}`,
    `Mission type: ${missionType}`,
    'If blocked, produce a precise blocker and next action instead of hallucinating completion.',
    '[/operator-mode]',
  ].join('\n')
}

export function startOperatorMission({ userId = '', projectId = 'browserai', type = 'full_diagnostic', goal = '', confirm = false } = {}) {
  initOperatorMode()
  const project = listOperatorProjects({ userId }).find((p) => p.id === projectId) || ensureDefaultProject(userId)
  const missionType = OPERATOR_MISSION_TYPES.find((m) => m.id === type) || OPERATOR_MISSION_TYPES[0]
  if (missionType.requiresConfirmation && confirm !== true) {
    const err = new Error(`Mission ${type} requires confirmation`)
    err.code = 'CONFIRM_REQUIRED'
    throw err
  }
  const missionId = id('op')
  const ts = now()
  db.prepare(`INSERT INTO operator_missions (id,user_id,project_id,type,title,status,goal,result_json,created_at,updated_at)
    VALUES (?,?,?,?,?,'queued',?,'{}',?,?)`).run(
    missionId, String(userId || ''), project.id, missionType.id, missionType.title, String(goal || missionType.description || '').slice(0, 4000), ts, ts,
  )

  try {
    if (missionType.recipeId) {
      const wf = createWorkflow({
        userId,
        chatId: '',
        recipeId: missionType.recipeId,
        input: { operatorMissionId: missionId, project, goal, notifyTelegram: missionType.risk === 'production-write' },
        confirm,
        source: 'operator',
      })
      startWorkflow(wf.id)
      return patchMission(missionId, { status: 'running', workflowId: wf.id, result: { workflowId: wf.id } })
    }

    const provider = getActiveKeyDecrypted(null)
    if (!provider?.baseUrl || !provider?.model) throw new Error('No active provider configured for custom operator agent')
    const prompt = String(goal || 'Run operator mission').trim()
    const job = createJob({
      userId,
      chatId: '',
      type: 'agent_run',
      title: `operator: ${prompt.slice(0, 80)}`,
      input: {
        prompt,
        history: [{ role: 'user', content: prompt }],
        extraSystem: operatorSystemPrompt(project, missionType.id),
        provider: { baseUrl: provider.baseUrl, model: provider.model, authType: provider.authType, authHeader: provider.authHeader, extraHeaders: provider.extraHeaders, temperature: 0.2 },
      },
    })
    startJob(job.id)
    return patchMission(missionId, { status: 'running', jobId: job.id, result: { jobId: job.id } })
  } catch (e) {
    return patchMission(missionId, { status: 'failed', error: e?.message || String(e), finishedAt: now() })
  }
}

export async function getOperatorStatus({ userId = '' } = {}) {
  initOperatorMode()
  const projects = listOperatorProjects({ userId })
  const missions = listOperatorMissions({ userId, limit: 10 })
  const status = { health: null, docker: null, sync: null }
  try { status.health = await runOpsAction({ service: 'browserai', action: 'health', confirm: true }) } catch (e) { status.health = { exitCode: 1, stderr: e.message } }
  try { status.docker = await runOpsAction({ service: 'browserai', action: 'docker_ps', confirm: true }) } catch (e) { status.docker = { exitCode: 1, stderr: e.message } }
  try { status.sync = await runOpsAction({ service: 'browserai', action: 'sync_check', confirm: true }) } catch (e) { status.sync = { exitCode: 1, stderr: e.message } }
  return {
    schema: 'browserai.operator_status.v1',
    generatedAt: new Date().toISOString(),
    ok: [status.health, status.docker, status.sync].every((x) => Number(x?.exitCode || 0) === 0),
    projects,
    missions,
    missionTypes: OPERATOR_MISSION_TYPES,
    status,
  }
}

export default { initOperatorMode, listOperatorProjects, upsertOperatorProject, startOperatorMission, listOperatorMissions, getOperatorStatus }
