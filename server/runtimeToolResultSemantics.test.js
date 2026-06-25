import { describe, expect, it } from 'vitest'
import { toolSucceeded, summarizeToolOutcome } from './runtimeToolResultSemantics.js'

/**
 * Approach 2 — Runtime Unification parity for tool-result semantics.
 *
 * After the refactor, `toolSucceeded(tool, r, args)` and
 * `summarizeToolOutcome(tool, r, args)` dispatch by semantic family+action,
 * not by raw tool name. So `file(action:"write")` and `write_file` MUST
 * return identical results, and likewise for every other consolidated↔legacy
 * pair.
 */

function ok(result) { return { ok: true, result } }
function fail(error) { return { ok: false, error } }

describe('runtimeToolResultSemantics: toolSucceeded parity (consolidated vs legacy)', () => {
  it('file(action:read) ≡ read_file', () => {
    const r = ok({ content: 'hello' })
    expect(toolSucceeded('file', r, { action: 'read' })).toBe(true)
    expect(toolSucceeded('read_file', r, { path: 'x' })).toBe(true)
  })

  it('file(action:write) ≡ write_file', () => {
    const r = ok({ bytes: 120 })
    expect(toolSucceeded('file', r, { action: 'write', content: 'x' })).toBe(true)
    expect(toolSucceeded('write_file', r, { content: 'x' })).toBe(true)
  })

  it('file(action:edit) ≡ edit_file', () => {
    const r = ok({ replaced: 1 })
    expect(toolSucceeded('file', r, { action: 'edit' })).toBe(true)
    expect(toolSucceeded('edit_file', r, {})).toBe(true)
  })

  it('shell(action:run) ≡ bash', () => {
    const r0 = ok({ exitCode: 0, stdout: 'ok' })
    const r1 = ok({ exitCode: 1, stderr: 'fail' })
    expect(toolSucceeded('shell', r0, { action: 'run', command: 'ls' })).toBe(true)
    expect(toolSucceeded('bash', r0, { command: 'ls' })).toBe(true)
    expect(toolSucceeded('shell', r1, { action: 'run', command: 'ls' })).toBe(false)
    expect(toolSucceeded('bash', r1, { command: 'ls' })).toBe(false)
  })

  it('verify(action:code) success/failure parity with verify_code', () => {
    const rOk = ok({ valid: true, ok: true })
    const rBad = ok({ valid: false, ok: false })
    expect(toolSucceeded('verify', rOk, { action: 'code' })).toBe(true)
    expect(toolSucceeded('verify_code', rOk, {})).toBe(true)
    expect(toolSucceeded('verify', rBad, { action: 'code' })).toBe(false)
    expect(toolSucceeded('verify_code', rBad, {})).toBe(false)
  })

  it('verify(action:npm_test) ≡ npm_test on passed/failed', () => {
    const rPass = ok({ passed: true })
    const rFail = ok({ passed: false })
    expect(toolSucceeded('verify', rPass, { action: 'npm_test' })).toBe(true)
    expect(toolSucceeded('npm_test', rPass, {})).toBe(true)
    expect(toolSucceeded('verify', rFail, { action: 'npm_test' })).toBe(false)
    expect(toolSucceeded('npm_test', rFail, {})).toBe(false)
  })

  it('verify(action:task) ≡ verify_task on passed/failed', () => {
    const rPass = ok({ passed: true, results: [{}, {}] })
    const rFail = ok({ passed: false, results: [{}] })
    expect(toolSucceeded('verify', rPass, { action: 'task' })).toBe(true)
    expect(toolSucceeded('verify_task', rPass, {})).toBe(true)
    expect(toolSucceeded('verify', rFail, { action: 'task' })).toBe(false)
    expect(toolSucceeded('verify_task', rFail, {})).toBe(false)
  })

  it('failed envelope always returns false regardless of tool', () => {
    const r = fail('boom')
    expect(toolSucceeded('write_file', r, {})).toBe(false)
    expect(toolSucceeded('bash', r, {})).toBe(false)
    expect(toolSucceeded('verify', r, { action: 'code' })).toBe(false)
  })

  it('docker(action:ps) ≡ docker_ps', () => {
    const r = ok({ containers: [{ name: 'browserai' }] })
    expect(toolSucceeded('docker', r, { action: 'ps' })).toBe(true)
    expect(toolSucceeded('docker_ps', r, {})).toBe(true)
  })

  it('git(action:commit) success iff committed !== false', () => {
    const rOk = ok({ committed: true, pushed: false })
    const rFail = ok({ committed: false })
    expect(toolSucceeded('git', rOk, { action: 'commit' })).toBe(true)
    expect(toolSucceeded('git_commit', rOk, {})).toBe(true)
    expect(toolSucceeded('git', rFail, { action: 'commit' })).toBe(false)
    expect(toolSucceeded('git_commit', rFail, {})).toBe(false)
  })

  it('git(action:clone) success iff cloned !== false', () => {
    const rOk = ok({ cloned: true, path: '/workspace/repo' })
    const rFail = ok({ cloned: false })
    expect(toolSucceeded('git', rOk, { action: 'clone' })).toBe(true)
    expect(toolSucceeded('git_clone', rOk, {})).toBe(true)
    expect(toolSucceeded('git', rFail, { action: 'clone' })).toBe(false)
    expect(toolSucceeded('git_clone', rFail, {})).toBe(false)
  })
})

describe('runtimeToolResultSemantics: summarizeToolOutcome parity (consolidated vs legacy)', () => {
  it('file(action:write) and write_file return the same summary', () => {
    const r = ok({ bytes: 120 })
    expect(summarizeToolOutcome('file', r, { action: 'write', content: 'x' }))
      .toBe(summarizeToolOutcome('write_file', r, { content: 'x' }))
  })

  it('file(action:read) and read_file return the same summary', () => {
    const r = ok({ content: 'hello world' })
    expect(summarizeToolOutcome('file', r, { action: 'read', path: 'x' }))
      .toBe(summarizeToolOutcome('read_file', r, { path: 'x' }))
  })

  it('file(action:edit) and edit_file return the same summary', () => {
    const r = ok({ replaced: 1 })
    expect(summarizeToolOutcome('file', r, { action: 'edit', path: 'x' }))
      .toBe(summarizeToolOutcome('edit_file', r, { path: 'x' }))
  })

  it('shell(action:run) and bash return the same summary', () => {
    const r = ok({ exitCode: 0, durationMs: 100 })
    expect(summarizeToolOutcome('shell', r, { action: 'run', command: 'ls' }))
      .toBe(summarizeToolOutcome('bash', r, { command: 'ls' }))
  })

  it('verify(action:code) and verify_code return the same summary', () => {
    const rOk = ok({ valid: true })
    const rBad = ok({ valid: false })
    expect(summarizeToolOutcome('verify', rOk, { action: 'code' }))
      .toBe(summarizeToolOutcome('verify_code', rOk, {}))
    expect(summarizeToolOutcome('verify', rBad, { action: 'code' }))
      .toBe(summarizeToolOutcome('verify_code', rBad, {}))
  })

  it('verify(action:npm_test) and npm_test return the same summary', () => {
    const rPass = ok({ passed: true })
    const rFail = ok({ passed: false, exitCode: 1 })
    expect(summarizeToolOutcome('verify', rPass, { action: 'npm_test' }))
      .toBe(summarizeToolOutcome('npm_test', rPass, {}))
    expect(summarizeToolOutcome('verify', rFail, { action: 'npm_test' }))
      .toBe(summarizeToolOutcome('npm_test', rFail, {}))
  })

  it('failed envelope returns error string regardless of tool', () => {
    expect(summarizeToolOutcome('write_file', fail('boom'))).toBe('boom')
    expect(summarizeToolOutcome('bash', fail('boom'))).toBe('boom')
  })

  it('git(action:commit) summary includes pushed and stderr', () => {
    const r = ok({ committed: true, pushed: true, stderr: 'warning' })
    const consolidated = summarizeToolOutcome('git', r, { action: 'commit', message: 'x' })
    const legacy = summarizeToolOutcome('git_commit', r, { message: 'x' })
    expect(consolidated).toBe(legacy)
    expect(consolidated).toMatch(/committed=true/)
    expect(consolidated).toMatch(/pushed=true/)
  })
})

describe('runtimeToolResultSemantics: edge cases', () => {
  it('returns true for unknown tools with ok envelope (parity default)', () => {
    expect(toolSucceeded('weird_tool', ok({}), {})).toBe(true)
  })

  it('returns false for failed envelopes regardless of tool', () => {
    expect(toolSucceeded('weird_tool', fail('x'), {})).toBe(false)
  })

  it('shell success without exitCode falls back to true', () => {
    expect(toolSucceeded('bash', ok({ stdout: 'ok' }), { command: 'ls' })).toBe(true)
  })

  it('file family success: even with empty result, ok envelope counts', () => {
    expect(toolSucceeded('file', ok({}), { action: 'delete' })).toBe(true)
  })
})
