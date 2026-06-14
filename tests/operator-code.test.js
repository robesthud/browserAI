import { describe, expect, it } from 'vitest'
import { initOperatorCode, startOperatorCodeTask, getOperatorCodeTask, renderCodeTaskReport, riskForChangedFile, parseSemanticReviewResponse, buildSemanticReviewPrompt, combineReviewGates } from '../server/operatorCode.js'

describe('operator code pipeline', () => {
  it('creates a queued code task with checkout metadata', () => {
    initOperatorCode()
    const userId = `code-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const task = startOperatorCodeTask({
      userId,
      missionId: '',
      project: { id: 'p-test', repo: 'robesthud/browserAI', localPath: '/workspace/projects/browserAI-test' },
      goal: 'inspect project only',
      mode: 'code_task',
      autostart: false,
    })
    expect(task.id).toMatch(/^code-/)
    expect(task.status).toBe('queued')
    expect(task.repo).toBe('robesthud/browserAI')
    expect(task.branch).toContain('operator/code_task')
    expect(getOperatorCodeTask(task.id)?.goal).toContain('inspect project')
  })

  it('renders code task verification reports', () => {
    const report = renderCodeTaskReport({ id: 'code-1', goal: 'add button', repo: 'owner/repo', branch: 'operator/x', workdir: '/workspace/projects/repo' }, { passed: true, results: [{ name: 'npm test', ok: true, exitCode: 0 }] })
    expect(report).toContain('Code Operator task verified')
    expect(report).toContain('npm test')
    expect(report).toContain('Branch: operator/x')
  })

  it('scores risky file paths for merge gates', () => {
    expect(riskForChangedFile('server/index.js').level).toBe('high')
    expect(riskForChangedFile('.env').level).toBe('critical')
    expect(riskForChangedFile('src/App.jsx').level).toBe('medium')
  })

  it('parses semantic reviewer json and escalates blocker risk', () => {
    const semantic = parseSemanticReviewResponse('```json\n{"summary":"race condition", "risk":"medium", "confidence":0.8, "dimensions":[{"name":"correctness","risk":"medium","findings":["missing await"]}], "blockers":[{"severity":"high","category":"correctness","file":"server/a.js","message":"async write is not awaited"}], "warnings":["add regression test"]}\n```')
    expect(semantic.available).toBe(true)
    expect(semantic.risk).toBe('high')
    expect(semantic.blockers[0].message).toContain('not awaited')
  })

  it('combines deterministic and semantic review gates', () => {
    const gates = combineReviewGates({
      files: ['src/App.jsx'],
      fileRisks: [{ file: 'src/App.jsx', level: 'medium', reason: 'source code' }],
      verification: { passed: true, ciOk: true, secretOk: true },
      semantic: { available: true, risk: 'high', blockers: [{ message: 'unsafe state migration' }], warnings: [] },
    })
    expect(gates.risk).toBe('high')
    expect(gates.approvedForMerge).toBe(false)
    expect(gates.blockers.join('\n')).toContain('Semantic review blockers')
  })

  it('builds semantic review prompts with required dimensions', () => {
    const prompt = buildSemanticReviewPrompt({ task: { goal: 'improve deploy flow' }, files: ['server/ops.js'], fileRisks: [], verification: { passed: true }, git: { diffPreview: '+ change' } })
    expect(prompt).toContain('correctness|security|test_coverage|architecture|ux_accessibility|deploy_risk')
    expect(prompt).toContain('server/ops.js')
    expect(prompt).toContain('+ change')
  })
})
