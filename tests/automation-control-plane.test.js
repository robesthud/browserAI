import { describe, expect, it } from 'vitest'
import { evaluateWorkflowStart } from '../server/automationPolicy.js'
import { listAutomationRecipes } from '../server/agentWorkflows.js'
import { createIncident, resolveIncident, generateIncidentRcaFromWorkflow } from '../server/incidents.js'
import { nextRunFromSchedule, upsertCronJob, deleteCronJob } from '../server/cron.js'
import { createDeploySession, getDeploySession, renderDeploySessionReport } from '../server/deploySessions.js'

describe('agent automation control plane', () => {
  it('exposes production-grade automation recipes', () => {
    const recipes = listAutomationRecipes()
    const ids = recipes.map((r) => r.id)
    expect(ids).toContain('browserai_full_diagnostic')
    expect(ids).toContain('browserai_deploy_safe')
    expect(ids).toContain('production_self_heal_restart')
    expect(recipes.find((r) => r.id === 'browserai_deploy_safe')?.requiresConfirmation).toBe(true)
  })

  it('policy blocks scheduled production writes but allows safe schedules', () => {
    const safe = { id: 'production_health_check', risk: 'safe' }
    const prod = { id: 'browserai_deploy_safe', risk: 'production-write', requiresConfirmation: true }
    const userId = `policy-${Date.now()}-${Math.random().toString(36).slice(2)}`
    expect(evaluateWorkflowStart({ recipe: safe, userId, source: 'schedule', confirm: false }).ok).toBe(true)
    const denied = evaluateWorkflowStart({ recipe: prod, userId, source: 'schedule', confirm: true })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('POLICY_SCHEDULE_DENY')
    const needsConfirm = evaluateWorkflowStart({ recipe: prod, userId, source: 'manual', confirm: false })
    expect(needsConfirm.ok).toBe(false)
    expect(needsConfirm.code).toBe('CONFIRM_REQUIRED')
  })

  it('supports workflow cron trigger syntax', () => {
    const userId = `cron-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const next = nextRunFromSchedule('*/15 minutes', Date.now())
    expect(next).toBeGreaterThan(Date.now())
    const job = upsertCronJob(userId, { name: 'safe health', schedule: 'hourly', trigger: 'workflow', prompt: 'production_health_check' })
    expect(job.id).toMatch(/^cron-/)
    expect(deleteCronJob(userId, job.id).deleted).toBe(1)
  })

  it('deduplicates incidents and can generate RCA from workflow output', () => {
    const fp = `fp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const a = createIncident({ source: 'test', title: 'Health failed', fingerprint: fp, details: { one: 1 } })
    const b = createIncident({ source: 'test', title: 'Health failed again', fingerprint: fp, details: { two: 2 } })
    expect(b.id).toBe(a.id)
    const rca = generateIncidentRcaFromWorkflow({
      id: 'wf-test', title: 'diagnostic', status: 'failed',
      steps: [{ idx: 1, title: 'Health', status: 'failed', error: 'curl connection refused health' }],
    })
    expect(rca.primaryCategory).toBe('health_check_failure')
    expect(rca.recommendedActions.length).toBeGreaterThan(0)
    expect(resolveIncident(a.id, { note: 'test' })?.status).toBe('resolved')
  })

  it('creates deploy sessions and renders reports', () => {
    const userId = `dep-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const session = createDeploySession({ userId, title: 'Test deploy', input: { test: true }, autostart: false })
    expect(session.id).toMatch(/^dep-/)
    expect(getDeploySession(session.id)?.events.length).toBeGreaterThan(0)
    expect(renderDeploySessionReport(getDeploySession(session.id))).toContain('Test deploy')
  })
})
