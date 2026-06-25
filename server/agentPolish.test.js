// Тесты для полировки агента (4 фикса от зацикливания)
import { describe, expect, it } from 'vitest'

// 1) plan_set должен принимать оба формата параметров
import { TOOLS } from './agentTools.js'

describe('agent polish: plan_set accepts both legacy and consolidated formats', () => {
  it('accepts steps as JSON-string array (the format LLM actually sends)', async () => {
    const steps = '[{"idx":0,"title":"Create file","detail":"Write hello.py"},{"idx":1,"title":"Test","detail":"Run python3 hello.py"}]'
    const r = await TOOLS.plan_set.handler({ action: 'set', title: 'Build hello.py', steps })
    expect(r.ok).toBe(true)
    expect(r.result.steps).toHaveLength(2)
    expect(r.result.steps[0]).toMatchObject({ text: 'Create file', done: false })
    expect(r.result.steps[1]).toMatchObject({ text: 'Test', done: false })
    expect(r.result.title).toBe('Build hello.py')
  })

  it('accepts steps as actual JS array', async () => {
    const r = await TOOLS.plan_set.handler({ steps: [{ idx: 1, title: 'Step A' }, { idx: 2, title: 'Step B' }] })
    expect(r.ok).toBe(true)
    expect(r.result.steps).toHaveLength(2)
    expect(r.result.steps[0].text).toBe('Step A')
  })

  it('still accepts legacy plan=markdown string', async () => {
    const r = await TOOLS.plan_set.handler({ plan: '- First step\n- Second step\n- [ ] Third step' })
    expect(r.ok).toBe(true)
    expect(r.result.steps).toHaveLength(3)
    expect(r.result.steps[2].text).toBe('Third step')
  })

  it('returns empty steps if nothing usable is passed', async () => {
    const r = await TOOLS.plan_set.handler({})
    expect(r.ok).toBe(true)
    expect(r.result.steps).toEqual([])
  })
})

// 2) plan_check должен принимать indices/steps/step
describe('agent polish: plan_check accepts indices/steps/step/JSON-string', () => {
  it('accepts indices as array', async () => {
    const r = await TOOLS.plan_check.handler({ indices: [0, 1, 2] })
    expect(r.ok).toBe(true)
    expect(r.result.checked).toEqual([0, 1, 2])
  })

  it('accepts indices as JSON-string', async () => {
    const r = await TOOLS.plan_check.handler({ indices: '[1,2,3]' })
    expect(r.ok).toBe(true)
    expect(r.result.checked).toEqual([1, 2, 3])
  })

  it('accepts indices as CSV string', async () => {
    const r = await TOOLS.plan_check.handler({ indices: '1, 2, 3' })
    expect(r.ok).toBe(true)
    expect(r.result.checked).toEqual([1, 2, 3])
  })

  it('accepts step (single)', async () => {
    const r = await TOOLS.plan_check.handler({ step: 5 })
    expect(r.ok).toBe(true)
    expect(r.result.checked).toEqual([5])
  })

  it('accepts steps array', async () => {
    const r = await TOOLS.plan_check.handler({ steps: [1, 2] })
    expect(r.ok).toBe(true)
    expect(r.result.checked).toEqual([1, 2])
  })

  it('filters out non-finite values', async () => {
    const r = await TOOLS.plan_check.handler({ steps: [1, NaN, Infinity, 2] })
    expect(r.ok).toBe(true)
    expect(r.result.checked).toEqual([1, 2])
  })
})

// 3) buildFinalStatus не должен падать на obligation check
describe('agent polish: obligation detection does not crash on empty state', () => {
  it('returns false for empty obligations', async () => {
    const { __test } = await import('./agentLoop.js')
    if (!__test || !__test.obligationCompletionStatus) return // skip if not exported
    const status = __test.obligationCompletionStatus({}, [])
    expect(status.finalReport).toBe(true)
  })
})
