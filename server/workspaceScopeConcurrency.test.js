import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Approach 2 — Workspace scope invariants under concurrent chat runs.
 *
 * Two chatIds must NEVER collide on the filesystem, even when both agent
 * runs hit workspace operations at the same instant. AsyncLocalStorage should
 * keep `withWorkspaceScope('A', ...)` and `withWorkspaceScope('B', ...)`
 * isolated, and parallel writes must land in separate scope roots.
 */
describe('workspace scope invariants under concurrency', () => {
  it('two parallel withWorkspaceScope writes land in separate scope dirs', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-concurrency-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope, writeFileContent, getWorkspaceTree } = await import('./workspace.js')

      const chatA = 'parallel-chat-A'
      const chatB = 'parallel-chat-B'

      await Promise.all([
        withWorkspaceScope(chatA, async () => {
          await ensureWorkspaceRoot()
          await writeFileContent('from-a.txt', 'content-from-A')
        }),
        withWorkspaceScope(chatB, async () => {
          await ensureWorkspaceRoot()
          await writeFileContent('from-b.txt', 'content-from-B')
        }),
      ])

      await withWorkspaceScope(chatA, async () => {
        const tree = await getWorkspaceTree()
        const names = tree.children.map((c) => c.name).sort()
        expect(names).toContain('from-a.txt')
        expect(names).not.toContain('from-b.txt')
      })
      await withWorkspaceScope(chatB, async () => {
        const tree = await getWorkspaceTree()
        const names = tree.children.map((c) => c.name).sort()
        expect(names).toContain('from-b.txt')
        expect(names).not.toContain('from-a.txt')
      })

      // On-disk verification: scope roots are siblings under chats/.
      const chatsDir = join(baseRoot, 'chats')
      expect(existsSync(join(chatsDir, chatA))).toBe(true)
      expect(existsSync(join(chatsDir, chatB))).toBe(true)
      expect(readFileSync(join(chatsDir, chatA, 'from-a.txt'), 'utf8')).toBe('content-from-A')
      expect(readFileSync(join(chatsDir, chatB, 'from-b.txt'), 'utf8')).toBe('content-from-B')
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('nested withWorkspaceScope swaps scope correctly', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-nested-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope, writeFileContent, readWorkspaceFile, getWorkspaceTree } = await import('./workspace.js')

      const outer = 'outer-chat'
      const inner = 'inner-chat'

      await withWorkspaceScope(outer, async () => {
        await ensureWorkspaceRoot()
        await writeFileContent('outer.txt', 'outer-data')
        await withWorkspaceScope(inner, async () => {
          await ensureWorkspaceRoot()
          await writeFileContent('inner.txt', 'inner-data')
          // Inside inner scope, outer file is not visible.
          const innerTree = await getWorkspaceTree()
          const innerNames = innerTree.children.map((c) => c.name).sort()
          expect(innerNames).toContain('inner.txt')
          expect(innerNames).not.toContain('outer.txt')
        })
        // Back in outer scope, inner file is not visible, outer still is.
        const outerTree = await getWorkspaceTree()
        const outerNames = outerTree.children.map((c) => c.name).sort()
        expect(outerNames).toContain('outer.txt')
        expect(outerNames).not.toContain('inner.txt')
        const outerContent = await readWorkspaceFile('outer.txt')
        expect(outerContent.text).toBe('outer-data')
      })

      // Both scope roots must exist on disk.
      const chatsDir = join(baseRoot, 'chats')
      expect(readdirSync(chatsDir).sort()).toEqual([inner, outer].sort())
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('massively parallel scopes do not race on directory creation', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-many-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope, writeFileContent } = await import('./workspace.js')

      const N = 12
      const ids = Array.from({ length: N }, (_, i) => `mass-chat-${i}`)

      await Promise.all(ids.map((id, i) =>
        withWorkspaceScope(id, async () => {
          await ensureWorkspaceRoot()
          await writeFileContent('payload.txt', `payload-for-${i}`)
        })
      ))

      // Every scope root must exist with its own payload.
      const chatsDir = join(baseRoot, 'chats')
      for (let i = 0; i < N; i += 1) {
        const id = ids[i]
        const scopeRoot = join(chatsDir, id)
        expect(existsSync(scopeRoot)).toBe(true)
        expect(readFileSync(join(scopeRoot, 'payload.txt'), 'utf8')).toBe(`payload-for-${i}`)
      }
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('parallel scopes can each create their own subdirectory tree without leaking', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-tree-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope, createFolder, writeFileContent, getWorkspaceTree } = await import('./workspace.js')

      const idA = 'tree-chat-a'
      const idB = 'tree-chat-b'

      await Promise.all([
        withWorkspaceScope(idA, async () => {
          await ensureWorkspaceRoot()
          await createFolder('', 'a-project')
          await writeFileContent('a-project/main.js', 'console.log(1)')
        }),
        withWorkspaceScope(idB, async () => {
          await ensureWorkspaceRoot()
          await createFolder('', 'b-project')
          await writeFileContent('b-project/main.js', 'console.log(2)')
        }),
      ])

      await withWorkspaceScope(idA, async () => {
        const tree = await getWorkspaceTree()
        const folderNames = tree.children.map((c) => c.name).sort()
        expect(folderNames).toContain('a-project')
        expect(folderNames).not.toContain('b-project')
      })
      await withWorkspaceScope(idB, async () => {
        const tree = await getWorkspaceTree()
        const folderNames = tree.children.map((c) => c.name).sort()
        expect(folderNames).toContain('b-project')
        expect(folderNames).not.toContain('a-project')
      })
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })
})
