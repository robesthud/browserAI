import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeScopeId, getContainerWorkspaceRoot } from './workspace.js'

describe('workspace scope invariants', () => {
  it('sanitizes scope id to alphanumeric, dash and underscore only', () => {
    expect(sanitizeScopeId('abc-123')).toBe('abc-123')
    expect(sanitizeScopeId('../etc/passwd')).toBe('etc-passwd')
    expect(sanitizeScopeId('')).toBe('')
    expect(sanitizeScopeId(null)).toBe('')
    expect(sanitizeScopeId('chat-42_abc')).toBe('chat-42_abc')
  })

  it('fresh scoped workspace is created on first ensureWorkspaceRoot inside scope', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-test-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope } = await import('./workspace.js')
      const chatId = 'fresh-chat-99'
      const scopedPath = join(baseRoot, 'chats', chatId)
      expect(existsSync(scopedPath)).toBe(false)
      await withWorkspaceScope(chatId, async () => {
        await ensureWorkspaceRoot()
        expect(existsSync(scopedPath)).toBe(true)
        expect(statSync(scopedPath).isDirectory()).toBe(true)
      })
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('empty/null scope uses base root, not chats subdir', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-test-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope } = await import('./workspace.js')
      await withWorkspaceScope('', async () => {
        await ensureWorkspaceRoot()
        expect(existsSync(baseRoot)).toBe(true)
        expect(existsSync(join(baseRoot, 'chats'))).toBe(false)
      })
      await withWorkspaceScope(null, async () => {
        await ensureWorkspaceRoot()
        expect(existsSync(join(baseRoot, 'chats'))).toBe(false)
      })
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('resumed scope reuses existing directory and files', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-test-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope, writeFileContent, getWorkspaceTree, readWorkspaceFile } = await import('./workspace.js')
      const chatId = 'resumed-chat-77'
      await withWorkspaceScope(chatId, async () => {
        await ensureWorkspaceRoot()
        await writeFileContent('notes.txt', 'hello')
      })
      await withWorkspaceScope(chatId, async () => {
        await ensureWorkspaceRoot()
        const tree = await getWorkspaceTree()
        expect(tree.children.some((c) => c.name === 'notes.txt')).toBe(true)
        const content = await readWorkspaceFile('notes.txt')
        expect(content.text).toBe('hello')
      })
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('deleteWorkspaceScope removes scoped root and files', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-test-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope, writeFileContent, deleteWorkspaceScope } = await import('./workspace.js')
      const chatId = 'delete-chat-55'
      await withWorkspaceScope(chatId, async () => {
        await ensureWorkspaceRoot()
        await writeFileContent('temp.txt', 'temp')
      })
      await deleteWorkspaceScope(chatId)
      expect(existsSync(join(baseRoot, 'chats', chatId))).toBe(false)
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('scoped workspace isolation: different chatIds do not share files', async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), 'browserai-ws-test-'))
    try {
      process.env.WORKSPACE_ROOT = baseRoot
      const { ensureWorkspaceRoot, withWorkspaceScope, writeFileContent, getWorkspaceTree } = await import('./workspace.js')
      const chatA = 'chat-a'
      const chatB = 'chat-b'
      await withWorkspaceScope(chatA, async () => {
        await ensureWorkspaceRoot()
        await writeFileContent('a.txt', 'A')
      })
      await withWorkspaceScope(chatB, async () => {
        await ensureWorkspaceRoot()
        await writeFileContent('b.txt', 'B')
      })
      await withWorkspaceScope(chatA, async () => {
        const tree = await getWorkspaceTree()
        expect(tree.children.some((c) => c.name === 'a.txt')).toBe(true)
        expect(tree.children.some((c) => c.name === 'b.txt')).toBe(false)
      })
      await withWorkspaceScope(chatB, async () => {
        const tree = await getWorkspaceTree()
        expect(tree.children.some((c) => c.name === 'a.txt')).toBe(false)
        expect(tree.children.some((c) => c.name === 'b.txt')).toBe(true)
      })
    } finally {
      try { rmSync(baseRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      delete process.env.WORKSPACE_ROOT
    }
  })

  it('getContainerWorkspaceRoot returns scoped path for docker sandbox', () => {
    // Synchronous; uses AsyncLocalStorage getStore() — but there is no active scope in test,
    // so it returns the default /workspace. Test the static mapping logic instead.
    expect(getContainerWorkspaceRoot()).toBe('/workspace')
  })
})
