import { describe, expect, it } from 'vitest'
import { parseGithubAutomationCommand, planGithubAutomationAction, renderGithubCommandHelp } from '../server/githubAutomation.js'

describe('github automation commands', () => {
  it('parses slash and mention commands', () => {
    expect(parseGithubAutomationCommand('/browserai run add tests').verb).toBe('run')
    expect(parseGithubAutomationCommand('@browserai review').verb).toBe('review')
    expect(parseGithubAutomationCommand('/agent fix-ci failing build').verb).toBe('fix-ci')
    expect(parseGithubAutomationCommand('regular comment')).toBe(null)
  })

  it('plans PR review missions from comments', () => {
    const payload = {
      repository: { full_name: 'owner/repo' },
      issue: { number: 7, title: 'Improve UI', html_url: 'https://github.com/owner/repo/pull/7', pull_request: {} },
      comment: { body: '/browserai review', html_url: 'https://github.com/owner/repo/pull/7#issuecomment-1' },
    }
    const plan = planGithubAutomationAction({ event: 'issue_comment', payload, command: parseGithubAutomationCommand(payload.comment.body) })
    expect(plan.kind).toBe('mission')
    expect(plan.missionType).toBe('code_task')
    expect(plan.goal).toContain('Review GitHub PR #7')
  })

  it('plans status/help comments', () => {
    const payload = { repository: { full_name: 'owner/repo' }, issue: { number: 2 } }
    expect(planGithubAutomationAction({ payload, command: parseGithubAutomationCommand('/browserai status') }).kind).toBe('status')
    const help = planGithubAutomationAction({ payload, command: parseGithubAutomationCommand('/browserai help') })
    expect(help.kind).toBe('comment')
    expect(help.body).toContain('/browserai run')
    expect(renderGithubCommandHelp()).toContain('fix-ci')
  })
})
