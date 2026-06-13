import { describe, expect, it } from 'vitest'
import { createAgentTask, finishAgentTask, latestAgentTask, buildResumeSystemMessage } from '../server/agentTasks.js'

describe('agent task persistence', () => {
  it('creates, updates and renders resume notes', () => {
    const chatId = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const task = createAgentTask({
      userId: 'u1', chatId, goal: 'fix bug', taskType: 'coding_change', phase: 'execute',
      state: { currentStep: 'Patch file', plan: { steps: [{ idx: 1, text: 'Read', done: true }, { idx: 2, text: 'Patch', done: false }] }, touchedFiles: ['src/App.jsx'], lastErrors: [] },
      history: [{ role: 'user', content: 'fix bug' }],
    })
    expect(task.id).toMatch(/^task-/)
    finishAgentTask(task.id, { status: 'failed', state: task.state, history: task.history })
    const latest = latestAgentTask({ chatId })
    expect(latest.id).toBe(task.id)
    const note = buildResumeSystemMessage(latest)
    expect(note).toContain('Resume previous BrowserAI task')
    expect(note).toContain('fix bug')
    expect(note).toContain('[ ] 2. Patch')
  })
})
