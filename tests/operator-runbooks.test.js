import { describe, expect, it } from 'vitest'
import { appendLesson, listRunbooks, readRunbook, renderRunbooksForPrompt, writeRunbook } from '../server/operatorRunbooks.js'

describe('operator runbook memory', () => {
  it('creates default runbooks, writes custom runbook and appends lessons', async () => {
    const listed = await listRunbooks()
    expect(listed.runbooks.map((r) => r.name)).toContain('deploy.md')
    await writeRunbook('test-runbook.md', '# Test Runbook\n\nHello')
    const rb = await readRunbook('test-runbook.md')
    expect(rb.text).toContain('Hello')
    const lesson = await appendLesson({ title: 'Test lesson', body: 'Remember this', source: 'vitest', tags: ['test'] })
    expect(lesson.ok).toBe(true)
    const prompt = await renderRunbooksForPrompt({ maxChars: 20000 })
    expect(prompt).toContain('Deploy Runbook')
    expect(prompt).toContain('Test lesson')
  })
})
