import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import jobsRoutes from './jobs.js'
import { createJob } from '../jobs.js'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use((req, _res, next) => {
    if (req.headers['x-test-user'] === '1') {
      req.user = {
        id: String(req.headers['x-test-user-id'] || 'vitest-user'),
        role: String(req.headers['x-test-role'] || 'user'),
      }
    } else {
      req.user = null
    }
    next()
  })
  app.use('/api/jobs', jobsRoutes)
  return app
}

describe('jobs routes', () => {
  it('requires auth for listing jobs', async () => {
    const app = buildApp()
    await request(app).get('/api/jobs').expect(401)
  })

  it('creates background agent jobs without persisting inline provider secrets in returned payload', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/jobs/agent')
      .set('x-test-user', '1')
      .send({
        chatId: 'vitest-chat',
        history: [{ role: 'user', content: 'test' }],
        title: 'Agent job',
        keyId: 'stored-key',
        useStoredSecret: true,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'super-secret-key',
        model: 'example-model',
      })
      .expect(200)

    expect(res.body.job.type).toBe('agent_run')
    expect(res.body.job.input.provider.apiKey).toBeUndefined()
    expect(res.body.job.input.provider.keyId).toBe('stored-key')
    expect(res.body.job.input.provider.useStoredSecret).toBe(true)
  })

  it('filters job access by user unless requester is owner', async () => {
    const app = buildApp()
    const foreign = createJob({ userId: 'other-user', chatId: 'x', type: 'tool_secret_scan', title: 'foreign', input: { tool: 'secret_scan', args: {} } })

    await request(app)
      .get(`/api/jobs/${foreign.id}`)
      .set('x-test-user', '1')
      .set('x-test-user-id', 'my-user')
      .set('x-test-role', 'user')
      .expect(404)

    await request(app)
      .get(`/api/jobs/${foreign.id}`)
      .set('x-test-user', '1')
      .set('x-test-user-id', 'owner-user')
      .set('x-test-role', 'owner')
      .expect(200)
  })
})
