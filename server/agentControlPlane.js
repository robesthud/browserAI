import db from './db.js'
import { getAutomationPolicy, listAutomationPolicyEvents } from './automationPolicy.js'
import { listAutomationRecipes } from './agentWorkflows.js'
import { listCronJobs } from './cron.js'
import { listIncidents } from './incidents.js'
import { listJobs } from './jobs.js'
import { listPendingQuestions } from './askUserRegistry.js'

function count(sql, ...args) {
  try { return db.prepare(sql).get(...args).c || 0 } catch { return 0 }
}

function statusFromSignals(signals = {}) {
  if (signals.openIncidents > 0 || signals.failedWorkflows > 0 || signals.failedJobs > 0) return 'attention'
  if (signals.runningWorkflows > 0 || signals.runningJobs > 0 || signals.pendingQuestions > 0) return 'active'
  return 'ok'
}

export function getAgentControlPlane({ userId = '' } = {}) {
  const uid = String(userId || '')
  const openIncidents = listIncidents({ userId: uid, limit: 200 }).filter((i) => i.status !== 'resolved')
  const workflows = uid
    ? db.prepare(`SELECT status, COUNT(*) c FROM agent_workflows WHERE user_id=? GROUP BY status`).all(uid)
    : db.prepare(`SELECT status, COUNT(*) c FROM agent_workflows GROUP BY status`).all()
  const wfCounts = Object.fromEntries(workflows.map((r) => [r.status, r.c]))
  const jobs = listJobs({ userId: uid, limit: 100 })
  const cron = listCronJobs(uid)
  const pendingQuestions = listPendingQuestions({ userId: uid }).length
  const policyEvents = listAutomationPolicyEvents({ userId: uid, limit: 20 })
  const signals = {
    openIncidents: openIncidents.length,
    failedWorkflows: Number(wfCounts.failed || 0),
    runningWorkflows: Number(wfCounts.running || 0) + Number(wfCounts.queued || 0),
    failedJobs: jobs.filter((j) => j.status === 'failed').length,
    runningJobs: jobs.filter((j) => ['queued', 'running', 'waiting'].includes(j.status)).length,
    pendingQuestions,
  }
  return {
    schema: 'browserai.agent_control_plane.v1',
    generatedAt: new Date().toISOString(),
    status: statusFromSignals(signals),
    signals,
    capabilities: {
      recipes: listAutomationRecipes().length,
      scheduledAutomations: cron.length,
      enabledSchedules: cron.filter((j) => j.enabled).length,
      policy: getAutomationPolicy(),
      webhookSecretConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET || (() => { try { return db.prepare('SELECT value FROM meta WHERE key=?').get('github_webhook_secret')?.value } catch { return '' } })()),
    },
    recent: {
      incidents: openIncidents.slice(0, 8),
      failedJobs: jobs.filter((j) => j.status === 'failed').slice(0, 8),
      policyEvents,
    },
    database: {
      workflowsTotal: count('SELECT COUNT(*) c FROM agent_workflows WHERE user_id=?', uid),
      workflowStepsTotal: count('SELECT COUNT(*) c FROM agent_workflow_steps'),
      ledgerTotal: count('SELECT COUNT(*) c FROM agent_tool_ledger'),
      incidentsTotal: uid ? count(`SELECT COUNT(*) c FROM incidents WHERE (user_id=? OR user_id='')`, uid) : count('SELECT COUNT(*) c FROM incidents'),
      jobsTotal: uid ? count('SELECT COUNT(*) c FROM jobs WHERE user_id=?', uid) : count('SELECT COUNT(*) c FROM jobs'),
    },
  }
}

export default { getAgentControlPlane }
