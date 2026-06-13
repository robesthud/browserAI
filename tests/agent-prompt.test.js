import { describe, expect, it } from 'vitest'
import { buildAgentSystemPrompt } from '../server/agentPrompt.js'

describe('autonomous agent prompt', () => {
  it('contains the autonomous agent contract and avoids Cline-specific framing', () => {
    const prompt = buildAgentSystemPrompt({ toolNames: ['read_file', 'write_file', 'verify_code', 'npm_test', 'plan_set', 'plan_check'] })
    expect(prompt).toContain('BrowserAI autonomous agent contract')
    expect(prompt).toContain('After editing code/config, verify')
    expect(prompt).not.toContain('Cline')
    expect(prompt).not.toContain('VSCode')
  })

  it('keeps simple download tasks constrained', () => {
    const prompt = buildAgentSystemPrompt({ toolNames: ['git_clone', 'zip_files'] })
    expect(prompt).toContain('Do not install/build/test unless user asks')
    expect(prompt).toContain('Do not do extra work')
  })
})
