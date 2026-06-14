import { describe, expect, it } from 'vitest'
import { TOOLS, renderToolsForPrompt } from '../server/agentTools.js'
import { profileToolNames } from '../server/toolAllowlist.js'
import { buildAutonomousRuntimeDirective } from '../server/agentCore.js'

describe('persistent shell session tools', () => {
  it('exposes persistent and background shell tools to the agent', () => {
    for (const name of ['shell_session_run', 'shell_session_reset', 'shell_background_start', 'shell_background_read', 'shell_background_stop', 'shell_background_list']) {
      expect(TOOLS[name]).toBeTruthy()
      expect(renderToolsForPrompt(null, { toolNames: [name] })).toContain(`### ${name}`)
    }
  })

  it('allows shell session tools in code and ops profiles', () => {
    for (const profile of ['general', 'code', 'ops']) {
      const tools = profileToolNames(profile)
      expect(tools).toContain('shell_session_run')
      expect(tools).toContain('shell_background_start')
      expect(tools).toContain('shell_background_read')
    }
  })

  it('teaches autonomous runtime to prefer sessions for persistent/long commands', () => {
    const text = buildAutonomousRuntimeDirective({ task: { type: 'coding_change', complexity: 'high', obligations: { verify: true } } })
    expect(text).toContain('shell_session_run')
    expect(text).toContain('shell_background_start')
  })
})
