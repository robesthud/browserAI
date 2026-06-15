import { describe, expect, it } from 'vitest'
import { classifyToolFailure, buildFailurePlaybook, buildToolStrategyDirective } from '../server/failurePlaybooks.js'
import { getRecoveryAction } from '../server/recoveryEngine.js'
import { commandLooksDangerous, requiresApproval } from '../server/approvalGate.js'

describe('failure playbooks and tool strategy', () => {
  it('classifies missing modules and produces diagnostic steps', () => {
    const cls = classifyToolFailure({ tool: 'bash', error: 'Error: Cannot find module vite', args: { command: 'npm test' } })
    expect(cls.primary.id).toBe('missing_module')
    const pb = buildFailurePlaybook(cls)
    expect(pb.instruction).toContain('[failure_playbook]')
    expect(pb.steps.map((s) => s.tool)).toContain('read_file')
  })

  it('turns command failures into recovery playbook hints', () => {
    const r = getRecoveryAction({ tool: 'bash', error: 'npm ERR! test failed: AssertionError', args: { command: 'npm test' } })
    expect(r?.recoverable).toBe(true)
    expect(r?.message).toContain('[failure_playbook]')
    expect(r?.classification?.categories.some((c) => c.id === 'test_failure')).toBe(true)
  })

  it('recommends automatic dependency installation instead of manual instructions', () => {
    const cls = classifyToolFailure({ tool: 'npm_test', error: 'vitest: not found', args: { command: 'npm test' } })
    expect(cls.categories.some((c) => c.id === 'missing_dependencies')).toBe(true)
    const pb = buildFailurePlaybook(cls)
    expect(pb.steps.some((s) => s.tool === 'shell_session_run' && String(s.args.command).includes('npm ci'))).toBe(true)
    expect(pb.instruction).not.toMatch(/вручную|manually/i)
  })

  it('adds tool strategy for non-trivial tasks', () => {
    const text = buildToolStrategyDirective({ task: { type: 'coding_change', complexity: 'high' } })
    expect(text).toContain('[tool_strategy]')
    expect(text).toContain('shell_session_run')
    expect(text).toContain('secret_scan')
  })

  it('forces approval for dangerous shell commands even when bash policy is auto', () => {
    expect(commandLooksDangerous('git push origin main')).toBe(true)
    expect(commandLooksDangerous('ls -la && cat package.json')).toBe(false)
    expect(requiresApproval('bash', '', { command: 'git push origin main' })).toBe(true)
  })
})
