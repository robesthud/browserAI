import { afterEach, describe, expect, it } from 'vitest'
import { deleteWorkspaceScope, readWorkspaceFile, withWorkspaceScope } from './workspace.js'
import { appendWorkspaceEvents, buildToolWorkspaceEvents, readWorkspaceDiffs, readWorkspaceEvents } from './workspaceEventLog.js'

describe('workspaceEventLog', () => {
  const chatId = 'workspace-event-log-test'
  afterEach(async () => {
    await deleteWorkspaceScope(chatId).catch(() => {})
  })

  it('builds events from bash changedFiles and appends JSONL log', async () => {
    await withWorkspaceScope(chatId, async () => {
      const events = buildToolWorkspaceEvents({
        tool: 'bash',
        ok: true,
        result: { changedFiles: { created: ['a.js'], modified: ['b.css'], deleted: ['old.html'], diffs: [{ path: 'a.js', patch: '--- /dev/null\n+++ b/a.js\n+1' }] } },
        step: 2,
        sub: 0,
        runId: 'run-test-1',
      })
      expect(events.map((e) => e.type)).toEqual(['file_created', 'file_modified', 'file_deleted'])
      expect(events[0].meta.diff.patch).toContain('+++ b/a.js')

      const written = await appendWorkspaceEvents(events)
      expect(written).toHaveLength(3)
      const listed = await readWorkspaceEvents({ runId: 'run-test-1' })
      expect(listed.map((e) => e.path)).toEqual(['a.js', 'b.css', 'old.html'])
      expect(listed[0].runId).toBe('run-test-1')
      const diffs = await readWorkspaceDiffs({ runId: 'run-test-1' })
      expect(diffs).toHaveLength(1)
      expect(diffs[0].runId).toBe('run-test-1')
      const raw = await readWorkspaceFile('.browserai/events.jsonl')
      expect(raw.text).toContain('browserai.workspace_event.v1')
    })
  })
})
