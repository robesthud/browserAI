import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import workspaceRoutes from './workspace.js'
import { appendWorkspaceEvents } from '../workspaceEventLog.js'
import { deleteWorkspaceScope, ensureWorkspaceRoot, withWorkspaceScope } from '../workspace.js'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use((req, _res, next) => {
    req.user = req.headers['x-test-user'] === '1' ? { id: 'vitest-user', role: 'user' } : null
    next()
  })
  app.use('/api/workspace', workspaceRoutes)
  return app
}

describe('workspace routes', () => {
  const chatId = 'workspace-routes-test'
  afterEach(async () => {
    await deleteWorkspaceScope(chatId).catch(() => {})
  })

  it('serves workspace events and diff previews for authenticated chat scope', async () => {
    const app = buildApp()
    await withWorkspaceScope(chatId, async () => {
      await ensureWorkspaceRoot()
      await appendWorkspaceEvents([{ runId: 'run-route-1', type: 'file_modified', path: 'src/a.js', tool: 'edit_file', meta: { diff: { path: 'src/a.js', patch: '--- a/src/a.js\n+++ b/src/a.js\n-old\n+new' } } }])
    })

    const events = await request(app)
      .get('/api/workspace/events?runId=run-route-1')
      .set('x-test-user', '1')
      .set('x-browserai-chat-id', chatId)
      .expect(200)
    expect(events.body.count).toBe(1)
    expect(events.body.events[0].path).toBe('src/a.js')

    const diffs = await request(app)
      .get('/api/workspace/diff?path=src%2Fa.js&runId=run-route-1')
      .set('x-test-user', '1')
      .set('x-browserai-chat-id', chatId)
      .expect(200)
    expect(diffs.body.count).toBe(1)
    expect(diffs.body.runId).toBe('run-route-1')
    expect(diffs.body.diffs[0].runId).toBe('run-route-1')
    expect(diffs.body.diffs[0].diff.patch).toContain('+new')
  })
})
