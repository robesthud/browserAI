import { describe, expect, it } from 'vitest'

import {
  finalRejectionForNoAction,
  hasRealActionEvidence,
  shouldExecuteTextShellCommand,
  shouldPushShellFirst,
} from './agentActionPolicy.js'

const codingContext = { task: { type: 'coding_change', complexity: 'high' } }

describe('agentActionPolicy runtime gates', () => {
  it('rejects a final answer for action tasks when no real tool ran', () => {
    const rejection = finalRejectionForNoAction({
      decision: { type: 'final', text: 'Готово.' },
      agentContext: codingContext,
      recentToolHistory: [{ tool: 'plan_set', ok: true }],
      pushbackCount: 0,
    })

    expect(rejection?.code).toBe('real_action_required')
    expect(rejection.userPrompt).toMatch(/shell/i)
  })

  it('does not reject simple answers without tools', () => {
    const rejection = finalRejectionForNoAction({
      decision: { type: 'final', text: 'Привет!' },
      agentContext: { task: { type: 'simple_answer', complexity: 'low' } },
      recentToolHistory: [],
      pushbackCount: 0,
    })
    expect(rejection).toBeNull()
  })

  it('pushes multi-step workspace batches toward one shell call', () => {
    expect(shouldPushShellFirst({
      calls: [
        { tool: 'list_files', args: {} },
        { tool: 'read_file', args: { path: 'a.js' } },
        { tool: 'verify_task', args: {} },
      ],
      agentContext: codingContext,
    })).toBe(true)
  })

  it('does not re-run quoted shell commands after real work unless draft says it will act now', () => {
    const history = [{ tool: 'shell', ok: true, args: '{"action":"run","command":"npm test"}' }]
    expect(hasRealActionEvidence(history)).toBe(true)
    expect(shouldExecuteTextShellCommand({ command: 'npm test', draftText: 'Проверка: `npm test` прошла.', recentToolHistory: history })).toBe(false)
    expect(shouldExecuteTextShellCommand({ command: 'npm test', draftText: 'Сейчас запущу `npm test`.', recentToolHistory: history })).toBe(true)
  })
})
