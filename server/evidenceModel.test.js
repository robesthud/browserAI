import { describe, expect, it } from 'vitest'
import {
  categorizeEvidence,
  evidenceGapForTaskType,
  validateClaimsAgainstEvidence,
  evidenceModelToText,
  EVIDENCE_CATEGORIES,
} from './evidenceModel.js'

describe('categorizeEvidence', () => {
  it('categorizes inspect tools', () => {
    const cats = categorizeEvidence([
      { tool: 'list_files', ok: true, semantic: { isList: true, isInspect: true } },
      { tool: 'read_file', ok: true, semantic: { isRead: true, isInspect: true } },
      { tool: 'write_file', ok: true, semantic: { isWrite: true } },
    ])
    expect(cats.inspect.length).toBe(2)
    expect(cats.codeChange.length).toBe(1)
    expect(cats.test.length).toBe(0)
  })

  it('categorizes test tools', () => {
    const cats = categorizeEvidence([
      { tool: 'npm_test', ok: true, semantic: { isLocalTest: true, isVerify: true } },
      { tool: 'verify_code', ok: false, semantic: { isVerify: true } },
    ])
    expect(cats.test.length).toBe(2)
  })

  it('categorizes deploy tools', () => {
    const cats = categorizeEvidence([
      { tool: 'ops_run_action', ok: true, semantic: { isDeploy: true } },
      { tool: 'git_commit', ok: true, semantic: { isCommit: true } },
    ])
    expect(cats.deploy.length).toBe(2)
  })

  it('categorizes blockers (failed tools)', () => {
    const cats = categorizeEvidence([
      { tool: 'read_file', ok: false, semantic: { isRead: true } },
      { tool: 'bash', ok: false, semantic: { family: 'shell' } },
    ])
    expect(cats.blocker.length).toBe(2)
  })
})

describe('evidenceGapForTaskType', () => {
  it('requires inspect for repo_analysis', () => {
    const gaps = evidenceGapForTaskType('repo_analysis', {})
    expect(gaps.length).toBe(1)
    expect(gaps[0].type).toBe('missing_inspect')
  })

  it('requires code_change for code tasks', () => {
    const gaps = evidenceGapForTaskType('code_fix', {})
    expect(gaps.some((g) => g.type === 'missing_code_change')).toBe(true)
  })

  it('requires test for test tasks', () => {
    const gaps = evidenceGapForTaskType('test_run', {})
    expect(gaps.some((g) => g.type === 'missing_test')).toBe(true)
  })

  it('requires deploy for deploy tasks', () => {
    const gaps = evidenceGapForTaskType('deploy', {})
    expect(gaps.some((g) => g.type === 'missing_deploy')).toBe(true)
  })

  it('returns no gaps when evidence is present', () => {
    const gaps = evidenceGapForTaskType('repo_analysis', {
      inspect: [{ tool: 'list_files', ok: true }],
      codeChange: [],
      test: [],
      deploy: [],
      blocker: [],
    })
    expect(gaps.length).toBe(0)
  })
})

describe('validateClaimsAgainstEvidence', () => {
  it('flags unsupported test claim', () => {
    const v = validateClaimsAgainstEvidence({
      text: 'All tests passed successfully.',
      categories: { test: [], inspect: [], codeChange: [], deploy: [], blocker: [] },
    })
    expect(v.some((x) => x.type === 'unsupported_test_claim')).toBe(true)
  })

  it('allows test claim when test evidence exists', () => {
    const v = validateClaimsAgainstEvidence({
      text: 'All tests passed successfully.',
      categories: { test: [{ ok: true }], inspect: [], codeChange: [], deploy: [], blocker: [] },
    })
    expect(v.some((x) => x.type === 'unsupported_test_claim')).toBe(false)
  })

  it('flags unsupported file claim', () => {
    const v = validateClaimsAgainstEvidence({
      text: 'File config.js was updated.',
      categories: { test: [], inspect: [], codeChange: [], deploy: [], blocker: [] },
    })
    expect(v.some((x) => x.type === 'unsupported_file_claim')).toBe(true)
  })

  it('flags unsupported ready claim', () => {
    const v = validateClaimsAgainstEvidence({
      text: 'Project is ready for production.',
      categories: { test: [], inspect: [], codeChange: [], deploy: [], blocker: [] },
    })
    expect(v.some((x) => x.type === 'unsupported_ready_claim')).toBe(true)
  })

  it('flags fabrication when text cites failed reads', () => {
    const v = validateClaimsAgainstEvidence({
      text: 'The content of missing.js is...',
      categories: { test: [], inspect: [], codeChange: [], deploy: [], blocker: [] },
      failedReadPaths: new Set(['/workspace/chats/abc/missing.js']),
      okReadPaths: new Set(),
    })
    expect(v.some((x) => x.type === 'fabrication')).toBe(true)
  })
})

describe('evidenceModelToText', () => {
  it('renders categories with counts', () => {
    const text = evidenceModelToText({
      inspect: [{ ok: true }, { ok: false }],
      codeChange: [{ ok: true }],
      test: [],
      deploy: [],
      blocker: [],
    })
    expect(text).toContain('inspect: 2 events')
    expect(text).toContain('codeChange: 1 events')
  })

  it('returns "No evidence" when empty', () => {
    expect(evidenceModelToText({})).toBe('No evidence recorded.')
  })
})
