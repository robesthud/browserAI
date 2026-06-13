import { describe, expect, it } from 'vitest'
import { initOperatorCode, startOperatorCodeTask, getOperatorCodeTask } from '../server/operatorCode.js'

describe('operator code pipeline', () => {
  it('creates a queued code task with checkout metadata', () => {
    initOperatorCode()
    const userId = `code-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const task = startOperatorCodeTask({
      userId,
      missionId: '',
      project: { id: 'p-test', repo: 'robesthud/browserAI', localPath: '/workspace/projects/browserAI-test' },
      goal: 'inspect project only',
      mode: 'code_task',
      autostart: false,
    })
    expect(task.id).toMatch(/^code-/)
    expect(task.status).toBe('queued')
    expect(task.repo).toBe('robesthud/browserAI')
    expect(task.branch).toContain('operator/code_task')
    expect(getOperatorCodeTask(task.id)?.goal).toContain('inspect project')
  })
})
