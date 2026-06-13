import db from './db.js'
import { createWorkflow, getWorkflow, startWorkflow } from './agentWorkflows.js'
import { createJob, getJob, startJob } from './jobs.js'
import { getActiveKeyDecrypted } from './db.js'
import { runOpsAction } from './ops.js'
import { initOperatorCode, startOperatorCodeTask, getOperatorCodeTask } from './operatorCode.js'

let initialized = false

function now() { return Date.now() }
function id(prefix = 'op') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function parse(raw, fallback) { try { return JSON.parse(raw || '') } catch { return fallback } }

export const OPERATOR_MISSION_TYPES = [
  {
    id: 'universal_dev_task',
    title: 'Universal developer task',
    icon: '🧠',
    description: 'Одна кнопка для любой задачи разработки: агент сам выбирает путь — кодинг, диагностика, деплой, CI, исследование.',
    risk: 'agent',
  },
  {
    id: 'code_task',
    title: 'Code Operator task',
    icon: '💻',
    description: 'Полноценная задача разработки: изучить проект, править файлы, запускать verify/test/build, готовить diff/report.',
    risk: 'agent',
  },
  {
    id: 'fix_tests',
    title: 'Fix tests / build',
    icon: '🧪',
    description: 'Найти и исправить ошибки тестов/сборки: npm test/build → diagnose → patch → verify.',
    risk: 'agent',
  },
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
  initOperatorCode()
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
  if (mission.result?.codeTaskId) mission.codeTask = getOperatorCodeTask(mission.result.codeTaskId)
  const linkedStatus = mission.workflow?.status || mission.job?.status || mission.codeTask?.status || ''
  if (linkedStatus && mission.status === 'running' && ['succeeded', 'failed', 'cancelled'].includes(linkedStatus)) {
    mission.status = linkedStatus
    mission.finishedAt = mission.workflow?.finishedAt || mission.job?.finishedAt || mission.codeTask?.finishedAt || mission.finishedAt
  }
  return mission
}

function ensureDefaultProject() {
  initOperatorMode()
  const existing = db.prepare(`SELECT * FROM operator_projects WHERE id='browserai'`).get()
  if (existing) {
    if (existing.user_id !== '') {
      db.prepare(`UPDATE operator_projects SET user_id='', updated_at=? WHERE id='browserai'`).run(now())
      return rowToProject(db.prepare(`SELECT * FROM operator_projects WHERE id='browserai'`).get())
    }
    return rowToProject(existing)
  }
  const ts = now()
  db.prepare(`INSERT OR IGNORE INTO operator_projects (id,user_id,name,repo,local_path,production_path,default_branch,meta_json,created_at,updated_at)
    VALUES ('browserai','',?,?,?,?,?,?,?,?)`).run(
    'BrowserAI',
    process.env.GITHUB_REPO || 'robesthud/browserAI',
    '/workspace/projects/browserAI',
    process.env.OPS_APP_DIR || '/opt/browserai',
    'main',
    JSON.stringify({ role: 'primary-self-project', operatorMode: true, global: true }),
    ts,
    ts,
  )
  return rowToProject(db.prepare(`SELECT * FROM operator_projects WHERE id='browserai'`).get())
}

export function listOperatorProjects({ userId = '' } = {}) {
  initOperatorMode()
  ensureDefaultProject(userId)
  return db.prepare(`SELECT * FROM operator_projects WHERE user_id=? OR user_id='' ORDER BY updated_at DESC`).all(String(userId || '')).map(rowToProject)
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


export function classifyOperatorGoal(goal = '') {
  const text = String(goal || '').toLowerCase()
  const has = (...words) => words.some((w) => text.includes(w))
  const wantsDeploy = has('деплой', 'депол', 'deploy', 'разверни', 'задеплой', 'production')
  const wantsFixDeploy = wantsDeploy && has('ошиб', 'слом', 'падает', 'почини', 'fix', 'error', 'failed', 'логи', 'logs')
  const wantsRestart = has('restart', 'перезапусти', 'self-heal', 'self heal')
  const wantsCi = has('ci', 'github actions', 'workflow failed', 'actions failed')
  const wantsDiagnostic = has('диагност', 'проверь', 'health', 'логи', 'logs', 'статус', 'status', 'почему')
  const wantsProdWrite = wantsDeploy && !wantsFixDeploy && has('задеплой', 'deploy', 'разверни')
  if (wantsRestart) return { route: 'self_heal_restart', reason: 'restart/self-heal requested', requiresConfirmation: true }
  if (wantsProdWrite) return { route: 'safe_deploy', reason: 'production deploy requested', requiresConfirmation: true }
  if (wantsFixDeploy) return { route: 'fix_deploy', reason: 'deploy failure investigation requested' }
  if (wantsCi) return { route: 'full_diagnostic', reason: 'CI/GitHub status requested' }
  if (wantsDiagnostic && !isCodingGoal(text)) return { route: 'full_diagnostic', reason: 'diagnostic/status requested' }
  if (isCodingGoal(text)) return { route: 'code_task', reason: 'software development task' }
  return { route: 'custom_agent', reason: 'general development/operator task' }
}


function isCodingGoal(goal = '') {
  const t = String(goal || '').toLowerCase()
  return /(код|фич|feature|bug|исправ|почини|реализ|добав|измен|перепиш|refactor|frontend|backend|ui|api|endpoint|test|build|npm|vite|eslint|кнопк|страниц|компонент|модул)/i.test(t)
}

function buildCodeOperatorPrompt(project, goal = '', missionType = 'code_task') {
  return [
    operatorSystemPrompt(project, missionType),
    '',
    '[code-operator-contract]',
    'You are doing a real software development task. Use the available tools, not prose-only answers.',
    'Default repository workflow:',
    `1. Ensure repository is local. If needed, use git_clone for ${project?.repo || 'the target repo'} into a stable project folder.`,
    '2. Read project rules and inspect package.json/README/entry files before editing.',
    '3. Make minimal coherent changes with edit_file/write_file.',
    '4. After each code/config edit, run verify_code or verify_task.',
    '5. Run npm_test and, when available, npm run build via bash/verify_task before final success.',
    '6. Run secret_scan before any commit/deploy recommendation.',
    '7. Produce a final report with changed files, tests/build results, and exact remaining blockers if any.',
    '8. If the user requested production deploy, do NOT run risky production changes silently: use ops workflows/actions and ask for approval when required.',
    'If tests fail, diagnose from the actual output, patch, and retry. Do not stop at the first failure unless blocked by missing credentials or policy.',
    `User goal: ${goal}`,
    '[/code-operator-contract]',
  ].join('\n')
}

function operatorSystemPrompt(project, missionType) {
  return [
    '[operator-mode]',
    'You are BrowserAI Operator Mode: act like a senior developer/operator agent similar to Arena Agent Mode.',
    'Your job is to complete software engineering and DevOps tasks end-to-end, not just advise.',
    'Mandatory loop: inspect → understand architecture → plan → act with tools → verify → deploy/follow logs if requested → fix failures → final report.',
    'For coding: read before edit, apply patches with tools, run verify_code/verify_task/npm_test/build, run secret_scan before commit/deploy.',
    'For deploy/production: prefer ops workflows, read logs, wait for health, use rollback-safe actions, and require approval when policy requires it.',
    'For unknown tasks: discover first; do not ask user unless blocked by missing credentials/decision/risky production action.',
    'Never claim success without tool evidence. If a tool fails, diagnose and retry with a different safe approach.',
    `Project: ${project?.name || 'BrowserAI'} (${project?.repo || ''})`,
    `Repository: ${project?.repo || ''}`,
    `Workspace/project path: ${project?.localPath || '/workspace/projects/browserAI'}`,
    `Production path: ${project?.productionPath || '/opt/browserai'}`,
    `Default branch: ${project?.defaultBranch || 'main'}`,
    `Mission type: ${missionType}`,
    'Final answer must include: what changed/checked, commands/tools run, verification result, deploy/log status, and any next actions.',
    '[/operator-mode]',
  ].join('\n')
}

export function startOperatorMission({ userId = '', projectId = 'browserai', type = 'full_diagnostic', goal = '', confirm = false } = {}) {
  initOperatorMode()
  const project = listOperatorProjects({ userId }).find((p) => p.id === projectId) || ensureDefaultProject(userId)
  let effectiveType = String(type || 'universal_dev_task')
  let routeInfo = null
  if (effectiveType === 'universal_dev_task') {
    routeInfo = classifyOperatorGoal(goal)
    effectiveType = routeInfo.route
  }
  const missionType = OPERATOR_MISSION_TYPES.find((m) => m.id === effectiveType) || OPERATOR_MISSION_TYPES[0]
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
    if (['code_task', 'fix_tests'].includes(missionType.id)) {
      const codeTask = startOperatorCodeTask({ userId, missionId, project, goal: goal || missionType.description, mode: missionType.id })
      return patchMission(missionId, { status: 'running', jobId: codeTask.jobId || '', result: { codeTaskId: codeTask.id, routeInfo } })
    }
    if (missionType.recipeId) {
      const wf = createWorkflow({
        userId,
        chatId: '',
        recipeId: missionType.recipeId,
        input: { operatorMissionId: missionId, project, goal, routeInfo, notifyTelegram: missionType.risk === 'production-write' },
        confirm,
        source: 'operator',
      })
      startWorkflow(wf.id)
      return patchMission(missionId, { status: 'running', workflowId: wf.id, result: { workflowId: wf.id, routeInfo } })
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
        extraSystem: [(['code_task', 'fix_tests'].includes(missionType.id) ? buildCodeOperatorPrompt(project, prompt, missionType.id) : operatorSystemPrompt(project, missionType.id)), routeInfo ? `\n[operator-route] ${JSON.stringify(routeInfo)} [/operator-route]` : ''].filter(Boolean).join('\n'),
        provider: { baseUrl: provider.baseUrl, model: provider.model, authType: provider.authType, authHeader: provider.authHeader, extraHeaders: provider.extraHeaders, temperature: 0.2 },
      },
    })
    startJob(job.id)
    return patchMission(missionId, { status: 'running', jobId: job.id, result: { jobId: job.id, routeInfo } })
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

export default { initOperatorMode, listOperatorProjects, upsertOperatorProject, startOperatorMission, listOperatorMissions, getOperatorStatus, classifyOperatorGoal }
