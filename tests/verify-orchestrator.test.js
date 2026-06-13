import { describe, expect, it } from 'vitest'
import { buildVerificationPlan } from '../server/verifyOrchestrator.js'

describe('verify orchestrator', () => {
  const profile = {
    root: 'browserAI',
    packageManager: 'npm',
    scripts: { test: 'vitest run', build: 'vite build' },
    dockerCompose: 'browserAI/docker-compose.yml',
  }

  it('plans syntax checks and package tests for JS changes', () => {
    const plan = buildVerificationPlan({ profile, touchedFiles: ['browserAI/server/index.js'], taskType: 'coding_change' })
    expect(plan.actions.some(a => a.tool === 'verify_code' && a.args.path === 'browserAI/server/index.js')).toBe(true)
    expect(plan.actions.some(a => a.tool === 'npm_test')).toBe(true)
  })

  it('plans build for frontend changes', () => {
    const plan = buildVerificationPlan({ profile, touchedFiles: ['browserAI/src/App.jsx'], taskType: 'coding_change' })
    expect(plan.actions.some(a => a.kind === 'command' && a.command.includes('npm run build'))).toBe(true)
  })

  it('plans docker compose config for compose changes', () => {
    const plan = buildVerificationPlan({ profile, touchedFiles: ['browserAI/docker-compose.yml'], taskType: 'deploy_ops' })
    expect(plan.actions.some(a => a.kind === 'command' && a.command.includes('docker compose'))).toBe(true)
  })
})
