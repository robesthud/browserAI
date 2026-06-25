import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import settingsRoutes from './settings.js'
import workspaceRoutes from './workspace.js'
import agentRoutes from './agent.js'
import jobsRoutes from './jobs.js'
import operatorRoutes from './operator.js'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use((req, _res, next) => {
    if (req.headers['x-test-user'] === '1') {
      req.user = {
        id: 'vitest-user',
        role: String(req.headers['x-test-role'] || 'owner'),
      }
    } else {
      req.user = null
    }
    next()
  })
  app.use('/api/workspace', workspaceRoutes)
  app.use('/api/agent', agentRoutes)
  app.use('/api/jobs', jobsRoutes)
  app.use('/api/operator', operatorRoutes)
  app.use('/api', agentRoutes)
  app.use('/api', settingsRoutes)
  return app
}

describe('route auth hardening', () => {
  it('keeps settings owner-only while allowing per-user cloud and cost routes', async () => {
    const app = buildApp()

    await request(app)
      .get('/api/settings')
      .expect(401)

    await request(app)
      .get('/api/settings')
      .set('x-test-user', '1')
      .set('x-test-role', 'user')
      .expect(403)

    const ownerRes = await request(app)
      .get('/api/settings')
      .set('x-test-user', '1')
      .set('x-test-role', 'owner')
      .expect(200)

    expect(ownerRes.body).toHaveProperty('keys')
    expect(ownerRes.body).toHaveProperty('params')
    expect(Array.isArray(ownerRes.body.keys)).toBe(true)
    for (const key of ownerRes.body.keys) {
      expect(key.apiKey).toBe('')
      if (key.hasSecret) expect(typeof key.maskedApiKey).toBe('string')
    }

    await request(app)
      .get('/api/cost/today')
      .set('x-test-user', '1')
      .set('x-test-role', 'user')
      .expect(200)

    await request(app)
      .get('/api/agent/questions')
      .set('x-test-user', '1')
      .set('x-test-role', 'user')
      .expect(200)
  })

  it('protects workspace/jobs for authenticated users and operator routes for owners only', async () => {
    const app = buildApp()

    await request(app)
      .get('/api/workspace/metadata')
      .expect(401)

    await request(app)
      .get('/api/workspace/metadata')
      .set('x-test-user', '1')
      .set('x-test-role', 'user')
      .expect(200)

    await request(app)
      .get('/api/jobs')
      .expect(401)

    await request(app)
      .get('/api/jobs')
      .set('x-test-user', '1')
      .set('x-test-role', 'user')
      .expect(200)

    await request(app)
      .get('/api/operator/projects')
      .expect(401)

    await request(app)
      .get('/api/operator/projects')
      .set('x-test-user', '1')
      .set('x-test-role', 'user')
      .expect(403)

    await request(app)
      .get('/api/operator/projects')
      .set('x-test-user', '1')
      .set('x-test-role', 'owner')
      .expect(200)

    await request(app)
      .get('/api/operator/provider-smoke/scenarios')
      .set('x-test-user', '1')
      .set('x-test-role', 'owner')
      .expect(200)
  })

  it('keeps public health open but protects agent execution routes', async () => {
    const app = buildApp()

    await request(app)
      .get('/api/agent/health')
      .expect(200)

    await request(app)
      .post('/api/agent/chat')
      .send({ history: [], model: 'x', baseUrl: 'mock', apiKey: 'x' })
      .expect(401)

    await request(app)
      .post('/api/chat')
      .send({ messages: [], model: 'x', baseUrl: 'mock', apiKey: 'x' })
      .expect(401)

    await request(app)
      .post('/api/chat')
      .set('x-test-user', '1')
      .set('x-test-role', 'user')
      .send({ messages: [], model: 'x', baseUrl: 'mock', apiKey: 'x' })
      .expect((res) => {
        expect([400, 500, 502]).toContain(res.statusCode)
      })
  })
})
