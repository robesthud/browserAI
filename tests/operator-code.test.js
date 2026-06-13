import { describe, expect, it } from 'vitest'
import { initOperatorCode, startOperatorCodeTask, getOperatorCodeTask, renderCodeTaskReport, riskForChangedFile } from '../server/operatorCode.js'

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

  it('renders code task verification reports', () => {
    const report = renderCodeTaskReport({ id: 'code-1', goal: 'add button', repo: 'owner/repo', branch: 'operator/x', workdir: '/workspace/projects/repo' }, { passed: true, results: [{ name: 'npm test', ok: true, exitCode: 0 }] })
    expect(report).toContain('Code Operator task verified')
    expect(report).toContain('npm test')
    expect(report).toContain('Branch: operator/x')
  })

  it('scores risky file paths for merge gates', () => {
    expect(riskForChangedFile('server/index.js').level).toBe('high')
    expect(riskForChangedFile('.env').level).toBe('critical')
    expect(riskForChangedFile('src/App.jsx').level).toBe('medium')
  })
})
