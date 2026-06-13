import { describe, expect, it } from 'vitest'
import { withWorkspaceScope, writeFileContent, readWorkspaceFile, deleteWorkspaceScope } from '../server/workspace.js'
import { scanSecrets } from '../server/secretScan.js'
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from '../server/workspaceSnapshots.js'

describe('secret scan and workspace snapshots', () => {
  it('detects high-risk secrets in workspace files', async () => {
    const chatId = `secret-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const res = await withWorkspaceScope(chatId, async () => {
        await writeFileContent('leak.txt', 'token=ghp_123456789012345678901234567890123456')
        return scanSecrets({ root: '' })
      })
      expect(res.high).toBeGreaterThan(0)
      expect(res.ok).toBe(false)
    } finally {
      await deleteWorkspaceScope(chatId).catch(() => {})
    }
  })

  it('creates and restores rollback snapshots', async () => {
    const chatId = `snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      await withWorkspaceScope(chatId, async () => {
        await writeFileContent('note.txt', 'before')
        const snap = await createWorkspaceSnapshot({ label: 'test' })
        await writeFileContent('note.txt', 'after')
        await restoreWorkspaceSnapshot({ id: snap.id })
        const file = await readWorkspaceFile('note.txt')
        expect(file.text).toBe('before')
      })
    } finally {
      await deleteWorkspaceScope(chatId).catch(() => {})
    }
  })
})
