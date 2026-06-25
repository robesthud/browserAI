import { describe, expect, it } from 'vitest'
import {
  normalizeRuntimeCall,
  narrateRuntimeCall,
  shouldReadBackCall,
  violatesPreDeployVerifyCall,
} from './runtimeCallSemantics.js'

describe('runtimeCallSemantics', () => {
  it('normalizes consolidated file write calls for read-back generation', () => {
    const call = normalizeRuntimeCall({ tool: 'file', args: { action: 'write', path: 'src/app.js' } })
    expect(call.semantic.family).toBe('file')
    expect(call.semantic.action).toBe('write')
    expect(shouldReadBackCall(call)).toBe(true)
  })

  it('narrates consolidated verify calls through the unified path', () => {
    const call = normalizeRuntimeCall({ tool: 'verify', args: { action: 'task' } })
    expect(narrateRuntimeCall(call, { task: { type: 'coding_change' } })).toContain('проверк')
  })

  it('blocks commit-like calls without prior verification evidence', () => {
    const commitCall = normalizeRuntimeCall({ tool: 'git', args: { action: 'commit', message: 'x' } })
    const noVerifyHistory = [{ tool: 'file', ok: true, args: JSON.stringify({ action: 'write', path: 'src/app.js' }), outcome: '20 bytes written' }]
    const verifiedHistory = [...noVerifyHistory, { tool: 'verify', ok: true, args: JSON.stringify({ action: 'task' }), outcome: 'passed 2 checks', semantic: { isVerify: true, command: '', action: 'task', family: 'verify' } }]
    expect(violatesPreDeployVerifyCall(commitCall, noVerifyHistory)).toBe(true)
    expect(violatesPreDeployVerifyCall(commitCall, verifiedHistory)).toBe(false)
  })
})
