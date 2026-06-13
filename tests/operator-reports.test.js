import { describe, expect, it } from 'vitest'
import { renderCodeTaskFullReport, renderIncidentReport } from '../server/operatorReports.js'

describe('operator reports', () => {
  it('renders code task reports', () => {
    const md = renderCodeTaskFullReport({
      id: 'code-1', status: 'succeeded', goal: 'add feature', repo: 'owner/repo', branch: 'operator/x', workdir: '/workspace/projects/repo',
      verify: { passed: true, results: [{ name: 'npm test', ok: true, exitCode: 0 }] },
      result: { review: { risk: 'low', approvedForMerge: true, approvedForDeploy: true }, finalize: { committed: true, commit: 'abc', branch: 'operator/x', pullRequest: { url: 'https://example.test/pr/1' } }, ci: { status: 'succeeded', ok: true, runs: [] } },
    })
    expect(md).toContain('Code Operator Report')
    expect(md).toContain('npm test')
    expect(md).toContain('Risk')
  })

  it('renders incident reports', () => {
    const md = renderIncidentReport({ id: 'inc-1', title: 'Health failed', status: 'open', severity: 'high', source: 'test', createdAt: Date.now(), details: { rca: { primaryCategory: 'health_check_failure', summary: 'Health failed', evidence: [], recommendedActions: ['check logs'] } } })
    expect(md).toContain('Incident Report')
    expect(md).toContain('health_check_failure')
  })
})
