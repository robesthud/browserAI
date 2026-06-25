import { describe, expect, it } from 'vitest'
import { runAgentSelfTest } from './agentSelfTest.js'

describe('agentSelfTest universal diagnostics', () => {
  it('awaits scoped workspace I/O diagnostics when chatId is provided', async () => {
    const result = await runAgentSelfTest({
      userId: 'vitest-user',
      chatId: 'vitest-chat-scope',
    })

    expect(result.ok).toBe(true)
    expect(result.failed).toBe(0)
    expect(result.checks.some((c) => c.name === 'workspace_scoped_io' && c.ok)).toBe(true)
    expect(result.passed).toBeGreaterThanOrEqual(6)
  })
})
