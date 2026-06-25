import { describe, expect, it } from 'vitest'
import { classifyAgentTask, detectGoalObligations, validateToolCall } from './agentCore.js'

describe('agentCore universal task routing', () => {
  it('does not infer deploy obligations from negated deploy phrasing', () => {
    const text = 'Сделай фичу и протестируй локально, но ничего не деплой и не публикуй'
    const task = classifyAgentTask(text)
    const obligations = detectGoalObligations(text, task)

    expect(task.type).toBe('coding_change')
    expect(obligations.deploy).toBe(false)
    expect(obligations.healthCheck).toBe(false)
    expect(obligations.logsCheck).toBe(false)
    expect(obligations.verify).toBe(true)
  })

  it('normalizes scoped absolute workspace paths', () => {
    const res = validateToolCall('read_file', {
      path: '/workspace/chats/demo-chat/src/index.js',
    }, {
      params: {
        path: { type: 'string', required: true },
      },
    })

    expect(res.ok).toBe(true)
    expect(res.args.path).toBe('src/index.js')
  })
})
