import { describe, expect, it } from 'vitest'

import { resolveAgentTurn } from './agentTurnOrchestrator.js'

const codingContext = { task: { type: 'coding_change', complexity: 'high' } }

describe('agentTurnOrchestrator', () => {
  it('routes markdown bash text into executable tool calls', () => {
    const turn = resolveAgentTurn({
      reply: { text: 'Проверю.\n```bash\nnpm test\n```' },
      agentContext: codingContext,
      toolExists: (name) => name === 'shell',
    })
    expect(turn.kind).toBe('tool_calls')
    expect(turn.source).toBe('markdown_shell')
    expect(turn.calls[0]).toMatchObject({ tool: 'shell', args: { action: 'run', command: 'npm test' } })
  })

  it('pushes back final answers for action tasks without real tool evidence', () => {
    const turn = resolveAgentTurn({
      reply: { text: 'Готово.' },
      agentContext: codingContext,
      recentToolHistory: [{ tool: 'plan_set', ok: true }],
      noToolsPushbackCount: 0,
    })
    expect(turn.kind).toBe('pushback')
    expect(turn.code).toBe('real_action_required')
  })

  it('keeps quoted shell command as final after real work', () => {
    const turn = resolveAgentTurn({
      reply: { text: 'Проверка выполнена командой `npm test`.' },
      agentContext: codingContext,
      recentToolHistory: [{ tool: 'shell', ok: true, args: '{"action":"run","command":"npm test"}' }],
      toolExists: (name) => name === 'shell',
    })
    expect(turn.kind).toBe('final')
    expect(turn.source).toBe('assistant_text_with_quoted_shell')
  })

  it('detects unapplied code drafts for code tasks', () => {
    const code = `\n\`\`\`js\n${'console.log("x")\n'.repeat(20)}\n\`\`\``
    const turn = resolveAgentTurn({
      reply: { text: code },
      agentContext: codingContext,
      history: [{ role: 'user', content: 'создай файл app.js' }],
      noToolsPushbackCount: 2,
      unappliedCodePushbackCount: 0,
    })
    expect(turn.kind).toBe('pushback')
    expect(turn.code).toBe('unapplied_code')
  })
})
