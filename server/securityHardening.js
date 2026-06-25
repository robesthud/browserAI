/**
 * securityHardening.js
 *
 * Approach 1 — Security + Access Baseline. Defense-in-depth helpers that
 * close gaps the route policy inventory didn't cover:
 *
 *   - rate limit on /api/auth/login (anti brute-force)
 *   - rate limit on /api/agent/chat (anti agent-spam)
 *   - login rate limit per IP + per email (account-targeted attacks)
 *
 * Uses the express-rate-limit package which is already in dependencies
 * but wasn't wired into index.js before this audit.
 *
 * Rate limits are intentionally GENEROUS for normal users — these
 * are anti-abuse only, not anti-productivity.
 */

import rateLimit from 'express-rate-limit'

const ONE_MINUTE = 60 * 1000

// Login: 5 attempts per IP per minute, 10 per email per 5 minutes.
export const loginIpLimiter = rateLimit({
  windowMs: ONE_MINUTE,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many login attempts; slow down.' },
  // Use req.ip only — Express resolves this from trusted proxy hops.
  // Do NOT fall back to x-forwarded-for (client-spoofable), making rate-limit bypass trivial.
  keyGenerator: (req) => `login-ip:${req.ip || 'unknown'}`,
})

// Agent chat: 30 requests per IP per minute (anti-spam, not anti-productivity).
export const agentChatLimiter = rateLimit({
  windowMs: ONE_MINUTE,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many agent requests; slow down.' },
  keyGenerator: (req) => `chat-ip:${req.ip || 'unknown'}`,
})

// Validate endpoint: 10 per IP per minute (deepseek session probe guard).
export const validateLimiter = rateLimit({
  windowMs: ONE_MINUTE,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many validate calls; slow down.' },
  keyGenerator: (req) => `validate-ip:${req.ip || 'unknown'}`,
})

export default { loginIpLimiter, agentChatLimiter, validateLimiter }
