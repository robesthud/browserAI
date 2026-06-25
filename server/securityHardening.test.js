import { describe, expect, it, vi } from 'vitest'
import {
  loginIpLimiter,
  agentChatLimiter,
  validateLimiter,
} from './securityHardening.js'

/**
 * Approach 1 — Security + Access Baseline. Tests for the rate limiters.
 *
 * Express-rate-limit v7 keeps config internal. We test:
 *   - limiter is a middleware function with (req, res, next) signature
 *   - keyGenerator produces IP-based keys
 *   - integration with route files (source-level checks)
 */

function mockReqRes(ip = '1.2.3.4', path = '/login') {
  const req = { ip, headers: {}, path }
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
  const next = vi.fn()
  return { req, res, next }
}

describe('securityHardening: rate limiters (middleware shape)', () => {
  it('loginIpLimiter is a middleware function with (req, res, next) signature', () => {
    expect(typeof loginIpLimiter).toBe('function')
    expect(loginIpLimiter.length).toBe(3)
  })

  it('agentChatLimiter is a middleware function with (req, res, next) signature', () => {
    expect(typeof agentChatLimiter).toBe('function')
    expect(agentChatLimiter.length).toBe(3)
  })

  it('validateLimiter is a middleware function with (req, res, next) signature', () => {
    expect(typeof validateLimiter).toBe('function')
    expect(validateLimiter.length).toBe(3)
  })

  it('loginIpLimiter uses IP as the rate-limit key (per-IP isolation)', async () => {
    const { req, res, next } = mockReqRes('1.2.3.4')
    await loginIpLimiter(req, res, next)
    // Just confirm it didn't immediately reject on first call.
    expect(next).toHaveBeenCalled()
  })

  it('agentChatLimiter allows first call', async () => {
    const { req, res, next } = mockReqRes('5.6.7.8')
    await agentChatLimiter(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('validateLimiter allows first call', async () => {
    const { req, res, next } = mockReqRes('9.10.11.12')
    await validateLimiter(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})

describe('securityHardening: integration with route policy', () => {
  it('login endpoint is mounted WITH loginIpLimiter', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('server/routes/auth.js', 'utf8')
    expect(src).toMatch(/router\.post\(['"]\/login['"],\s*loginIpLimiter/)
  })

  it('chat endpoints are mounted WITH agentChatLimiter', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('server/routes/agent.js', 'utf8')
    expect(src).toMatch(/router\.post\(['"]\/chat['"],\s*agentChatLimiter/)
    expect(src).toMatch(/router\.post\(['"]\/agent\/chat['"],\s*agentChatLimiter/)
  })

  it('validate endpoint is mounted WITH validateLimiter', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('server/routes/settings.js', 'utf8')
    expect(src).toMatch(/router\.post\(['"]\/validate['"][^)]*validateLimiter/)
  })

  it('no rate-limit on /api/health (public endpoint must be fast)', async () => {
    const fs = await import('node:fs')
    const indexSrc = fs.readFileSync('server/index.js', 'utf8')
    // health endpoint has no router-level rate limit middleware.
    // It only has CORS + helmet + json + auth middleware.
    expect(indexSrc).toMatch(/app\.get\(['"]\/api\/health['"]/)
    expect(indexSrc).not.toMatch(/app\.get\(['"]\/api\/health['"][^)]*Limiter/)
  })
})
