import { describe, expect, it } from 'vitest'
import { cancelSuperWorkflow, getSuperWorkflow, listSuperWorkflows, startSuperOperatorWorkflow } from '../server/operatorSuperWorkflow.js'

describe('super operator workflow', () => {
  it('creates, lists and cancels a super workflow without autostart', () => {
    const userId = `super-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const sw = startSuperOperatorWorkflow({
      userId,
      missionId: '',
      project: { id: 'browserai', repo: 'robesthud/browserAI' },
      goal: 'implement test feature',
      options: { autoFinalize: false },
      autostart: false,
    })
    expect(sw.id).toMatch(/^super-/)
    expect(sw.status).toBe('queued')
    expect(listSuperWorkflows({ userId }).some((x) => x.id === sw.id)).toBe(true)
    expect(cancelSuperWorkflow(sw.id).status).toBe('cancelled')
    expect(getSuperWorkflow(sw.id).status).toBe('cancelled')
  })
})
