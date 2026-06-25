import { describe, expect, it } from 'vitest'
import {
  PHASES, PHASE_ORDER, TRANSITIONS, TOOL_FAMILY_CONSTRAINTS, DISALLOWED_TOOLS_BY_PHASE,
  isTransitionAllowed, isToolAllowedInPhase,
  createRetryBudget, recordToolCall, isRetryBudgetExceeded, isConsecutiveSameToolExceeded,
  isVerifyRetryBudgetExceeded, incrementVerifyRetry,
  detectStuck, derivePhaseFromEvidence, shouldEscalate, buildEscalationPrompt,
  guardToolCall, nextPhase,
} from './agentStateMachine.js'

describe('phase constants', () => {
  it('has all expected phases', () => {
    expect(PHASES.DISCOVER).toBe('discover')
    expect(PHASES.PLAN).toBe('plan')
    expect(PHASES.EXECUTE).toBe('execute')
    expect(PHASES.VERIFY).toBe('verify')
    expect(PHASES.FINALIZE).toBe('finalize')
    expect(PHASES.BLOCKED).toBe('blocked')
  })

  it('has correct phase order', () => {
    expect(PHASE_ORDER).toEqual(['discover', 'plan', 'execute', 'verify', 'finalize'])
  })
})

describe('isTransitionAllowed', () => {
  it('allows discover→plan, execute, finalize, blocked', () => {
    expect(isTransitionAllowed(PHASES.DISCOVER, PHASES.PLAN)).toBe(true)
    expect(isTransitionAllowed(PHASES.DISCOVER, PHASES.EXECUTE)).toBe(true)
    expect(isTransitionAllowed(PHASES.DISCOVER, PHASES.FINALIZE)).toBe(true)
    expect(isTransitionAllowed(PHASES.DISCOVER, PHASES.BLOCKED)).toBe(true)
  })

  it('disallows discover→verify', () => {
    expect(isTransitionAllowed(PHASES.DISCOVER, PHASES.VERIFY)).toBe(false)
  })

  it('allows execute→verify, finalize, execute, blocked', () => {
    expect(isTransitionAllowed(PHASES.EXECUTE, PHASES.VERIFY)).toBe(true)
    expect(isTransitionAllowed(PHASES.EXECUTE, PHASES.FINALIZE)).toBe(true)
    expect(isTransitionAllowed(PHASES.EXECUTE, PHASES.EXECUTE)).toBe(true)
  })

  it('allows verify→finalize, execute, blocked', () => {
    expect(isTransitionAllowed(PHASES.VERIFY, PHASES.FINALIZE)).toBe(true)
    expect(isTransitionAllowed(PHASES.VERIFY, PHASES.EXECUTE)).toBe(true)
  })

  it('disallows finalize→discover', () => {
    expect(isTransitionAllowed(PHASES.FINALIZE, PHASES.DISCOVER)).toBe(false)
  })

  it('blocked has no outgoing transitions', () => {
    expect(isTransitionAllowed(PHASES.BLOCKED, PHASES.FINALIZE)).toBe(false)
    expect(isTransitionAllowed(PHASES.BLOCKED, PHASES.EXECUTE)).toBe(false)
  })
})

describe('isToolAllowedInPhase', () => {
  it('disallows write_file in discover', () => {
    expect(isToolAllowedInPhase('write_file', PHASES.DISCOVER)).toBe(false)
    expect(isToolAllowedInPhase('edit_file', PHASES.DISCOVER)).toBe(false)
    expect(isToolAllowedInPhase('bash', PHASES.DISCOVER)).toBe(false)
  })

  it('allows list_files in discover', () => {
    expect(isToolAllowedInPhase('list_files', PHASES.DISCOVER)).toBe(true)
  })

  it('disallows write_file in finalize', () => {
    expect(isToolAllowedInPhase('write_file', PHASES.FINALIZE)).toBe(false)
    expect(isToolAllowedInPhase('edit_file', PHASES.FINALIZE)).toBe(false)
    expect(isToolAllowedInPhase('bash', PHASES.FINALIZE)).toBe(false)
  })

  it('allows read_file in finalize', () => {
    expect(isToolAllowedInPhase('read_file', PHASES.FINALIZE)).toBe(true)
  })

  it('disallows all tools in blocked', () => {
    expect(isToolAllowedInPhase('read_file', PHASES.BLOCKED)).toBe(false)
    expect(isToolAllowedInPhase('list_files', PHASES.BLOCKED)).toBe(false)
  })
})

describe('retry budget', () => {
  it('tracks tool call counts', () => {
    const budget = createRetryBudget()
    recordToolCall(budget, 'write_file', { path: 'a.js' }, 1)
    recordToolCall(budget, 'write_file', { path: 'a.js' }, 2)
    expect(budget.toolCalls.get('write_file:a.js').count).toBe(2)
  })

  it('exceeds after 3 retries', () => {
    const budget = createRetryBudget()
    for (let i = 1; i <= 4; i++) recordToolCall(budget, 'bash', {}, i)
    expect(isRetryBudgetExceeded(budget, 'bash', {})).toBe(true)
  })

  it('does not exceed at 2 retries', () => {
    const budget = createRetryBudget()
    for (let i = 1; i <= 2; i++) recordToolCall(budget, 'bash', {}, i)
    expect(isRetryBudgetExceeded(budget, 'bash', {})).toBe(false)
  })

  it('detects consecutive same tool exceeded', () => {
    const history = Array(5).fill({ tool: 'read_file', args: '{"path":"a.js"}' })
    expect(isConsecutiveSameToolExceeded({ maxConsecutiveSameTool: 5 }, history)).toBe(true)
  })

  it('does not detect with mixed tools', () => {
    const history = [
      { tool: 'read_file', args: '{}' },
      { tool: 'list_files', args: '{}' },
      { tool: 'read_file', args: '{}' },
    ]
    expect(isConsecutiveSameToolExceeded({ maxConsecutiveSameTool: 5 }, history)).toBe(false)
  })

  it('tracks verify retry budget', () => {
    const budget = createRetryBudget()
    budget.maxVerifyRetries = 3
    incrementVerifyRetry(budget)
    incrementVerifyRetry(budget)
    expect(isVerifyRetryBudgetExceeded(budget)).toBe(false)
    incrementVerifyRetry(budget)
    expect(isVerifyRetryBudgetExceeded(budget)).toBe(true)
  })
})

describe('detectStuck', () => {
  it('detects consecutive same tool', () => {
    const budget = createRetryBudget()
    const history = Array(5).fill({ tool: 'read_file', args: '{"path":"a.js"}' })
    const s = detectStuck({ recentToolHistory: history, budget, phase: PHASES.DISCOVER, step: 5, planState: { done: new Set() } })
    expect(s.stuck).toBe(true)
    expect(s.type).toBe('consecutive_same_tool')
  })

  it('detects phase stuck', () => {
    const s = detectStuck({ recentToolHistory: [], budget: createRetryBudget(), phase: PHASES.EXECUTE, step: 15, lastPhaseChangeStep: 5, maxStepsWithoutProgress: 8 })
    expect(s.stuck).toBe(true)
    expect(s.type).toBe('phase_stuck')
  })

  it('detects plan stuck', () => {
    const s = detectStuck({ recentToolHistory: [], budget: createRetryBudget(), phase: PHASES.PLAN, step: 5, planState: { done: new Set() } })
    expect(s.stuck).toBe(true)
    expect(s.type).toBe('plan_stuck')
  })

  it('detects oscillation', () => {
    const history = [
      { phase: 'execute', tool: 'write_file' },
      { phase: 'verify', tool: 'npm_test' },
      { phase: 'execute', tool: 'edit_file' },
      { phase: 'verify', tool: 'npm_test' },
      { phase: 'execute', tool: 'write_file' },
    ]
    const s = detectStuck({ recentToolHistory: history, budget: createRetryBudget(), phase: PHASES.VERIFY, step: 5 })
    expect(s.stuck).toBe(true)
    expect(s.type).toBe('oscillation')
  })

  it('returns not stuck when healthy', () => {
    const s = detectStuck({ recentToolHistory: [], budget: createRetryBudget(), phase: PHASES.DISCOVER, step: 2 })
    expect(s.stuck).toBe(false)
  })
})

describe('derivePhaseFromEvidence', () => {
  it('stays discover without inspect', () => {
    const r = derivePhaseFromEvidence({ currentPhase: PHASES.DISCOVER, step: 1 })
    expect(r.phase).toBe(PHASES.DISCOVER)
  })

  it('moves discover→plan when inspect + plan exist', () => {
    const r = derivePhaseFromEvidence({
      currentPhase: PHASES.DISCOVER,
      recentToolHistory: [{ ok: true, semantic: { isInspect: true } }],
      agentContext: { task: { plan: { steps: [{ idx: 1, text: 't' }] } } },
      step: 3,
    })
    expect(r.phase).toBe(PHASES.PLAN)
  })

  it('moves discover→execute when inspect + no plan + step>2', () => {
    const r = derivePhaseFromEvidence({
      currentPhase: PHASES.DISCOVER,
      recentToolHistory: [{ ok: true, semantic: { isInspect: true } }],
      step: 3,
    })
    expect(r.phase).toBe(PHASES.EXECUTE)
  })

  it('moves execute→verify when code changes + verify', () => {
    const r = derivePhaseFromEvidence({
      currentPhase: PHASES.EXECUTE,
      recentToolHistory: [
        { ok: true, semantic: { isWrite: true } },
        { ok: true, semantic: { isVerify: true } },
      ],
    })
    expect(r.phase).toBe(PHASES.VERIFY)
  })

  it('moves execute→finalize when no changes + inspect', () => {
    const r = derivePhaseFromEvidence({
      currentPhase: PHASES.EXECUTE,
      recentToolHistory: [{ ok: true, semantic: { isInspect: true } }],
    })
    expect(r.phase).toBe(PHASES.FINALIZE)
  })

  it('moves verify→finalize when test passed', () => {
    const r = derivePhaseFromEvidence({
      currentPhase: PHASES.VERIFY,
      recentToolHistory: [
        { ok: true, semantic: { isLocalTest: true } },
        { ok: true, semantic: { isVerify: true } },
      ],
    })
    expect(r.phase).toBe(PHASES.FINALIZE)
  })

  it('moves verify→execute when no test + step>4', () => {
    const r = derivePhaseFromEvidence({
      currentPhase: PHASES.VERIFY,
      recentToolHistory: [{ ok: true, semantic: { isWrite: true } }],
      step: 5,
    })
    expect(r.phase).toBe(PHASES.EXECUTE)
  })
})

describe('shouldEscalate', () => {
  it('escalates when stuck', () => {
    const e = shouldEscalate({ stuck: { stuck: true, reason: 'loop', type: 'loop' }, step: 10 })
    expect(e.escalate).toBe(true)
    expect(e.type).toBe('loop')
  })

  it('escalates near max steps', () => {
    const e = shouldEscalate({ step: 21, maxSteps: 25 })
    expect(e.escalate).toBe(true)
    expect(e.type).toBe('max_steps_warning')
  })

  it('does not escalate early', () => {
    const e = shouldEscalate({ step: 5, maxSteps: 25 })
    expect(e.escalate).toBe(false)
  })
})

describe('guardToolCall', () => {
  it('blocks disallowed tool in phase', () => {
    const g = guardToolCall({ tool: 'write_file', phase: PHASES.DISCOVER, budget: createRetryBudget(), step: 1 })
    expect(g.blocked).toBe(true)
    expect(g.reason).toContain('not allowed')
  })

  it('allows allowed tool', () => {
    const g = guardToolCall({ tool: 'read_file', phase: PHASES.DISCOVER, budget: createRetryBudget(), step: 1 })
    expect(g.blocked).toBe(false)
  })

  it('blocks on retry budget exceeded', () => {
    const budget = createRetryBudget()
    for (let i = 1; i <= 4; i++) recordToolCall(budget, 'bash', {}, i)
    const g = guardToolCall({ tool: 'bash', phase: PHASES.EXECUTE, budget, step: 5 })
    expect(g.blocked).toBe(true)
    expect(g.reason).toContain('Retry budget')
  })
})

describe('nextPhase', () => {
  it('approves allowed transition', () => {
    const n = nextPhase({ currentPhase: PHASES.DISCOVER, targetPhase: PHASES.EXECUTE })
    expect(n.changed).toBe(true)
    expect(n.phase).toBe(PHASES.EXECUTE)
  })

  it('rejects disallowed transition', () => {
    const n = nextPhase({ currentPhase: PHASES.FINALIZE, targetPhase: PHASES.EXECUTE })
    expect(n.changed).toBe(false)
    expect(n.phase).toBe(PHASES.FINALIZE)
  })
})
