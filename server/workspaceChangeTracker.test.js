import { afterEach, describe, expect, it } from 'vitest'
import { createFolder, deleteWorkspaceScope, writeFileContent, withWorkspaceScope } from './workspace.js'
import { captureWorkspaceState, diffWorkspaceStates } from './workspaceChangeTracker.js'

describe('workspaceChangeTracker', () => {
  const chatId = 'change-tracker-test'
  afterEach(async () => {
    await deleteWorkspaceScope(chatId).catch(() => {})
  })

  it('detects created and modified code-like files', async () => {
    await withWorkspaceScope(chatId, async () => {
      await createFolder('', 'src')
      const before = await captureWorkspaceState()
      await writeFileContent('src/hello.js', 'console.log("hi")\n')
      const afterCreate = await captureWorkspaceState()
      let diff = diffWorkspaceStates(before, afterCreate)
      expect(diff.created).toContain('src/hello.js')
      expect(diff.codeChanged).toBe(true)

      await writeFileContent('src/hello.js', 'console.log("bye")\n')
      const afterModify = await captureWorkspaceState()
      diff = diffWorkspaceStates(afterCreate, afterModify)
      expect(diff.modified).toContain('src/hello.js')
      expect(diff.code).toContain('src/hello.js')
      expect(diff.diffs[0]?.path).toBe('src/hello.js')
      expect(diff.diffs[0]?.patch).toContain('-console.log("hi")')
      expect(diff.diffs[0]?.patch).toContain('+console.log("bye")')
    })
  })
})
