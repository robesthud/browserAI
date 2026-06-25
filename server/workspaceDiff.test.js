import { describe, expect, it } from 'vitest'
import { createUnifiedDiff } from './workspaceDiff.js'

describe('workspaceDiff', () => {
  it('creates compact unified-style diff for text changes', () => {
    const diff = createUnifiedDiff({ path: 'src/a.js', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\nfour\n', type: 'modified' })
    expect(diff.path).toBe('src/a.js')
    expect(diff.patch).toContain('--- a/src/a.js')
    expect(diff.patch).toContain('+++ b/src/a.js')
    expect(diff.patch).toContain('-two')
    expect(diff.patch).toContain('+TWO')
    expect(diff.patch).toContain('+four')
  })
})
