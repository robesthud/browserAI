import { describe, expect, it } from 'vitest'
import { buildAgentSystemPrompt } from './agentPrompt.js'

describe('agentPrompt universal development contract', () => {
  it('includes import-safe and secret-independent testing guidance', () => {
    const prompt = buildAgentSystemPrompt()

    expect(prompt).toContain('Node.js module awareness is mandatory')
    expect(prompt).toContain('Make code import-safe and testable by default')
    expect(prompt).toContain('without requiring production secrets')
  })
})
