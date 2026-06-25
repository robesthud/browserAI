# Approach 1 — Security + Access Baseline — Audit Report

Date: 2026-06-20
Auditor: deep audit pass
Scope: server-side access control, secret handling, auth depth, defense-in-depth

## Summary

| Area | Before audit | After audit | Status |
|---|---|---|---|
| Route policy inventory | ✓ documented | ✓ verified | closed |
| Settings DTO safety | ✓ masked | ✓ verified | closed |
| Secret redaction in errors | ✓ partial | ✓ verified | closed |
| Brute-force protection on `/login` | ❌ **none** | ✓ 5/IP/min | **FIXED** |
| Agent spam protection on `/chat` | ❌ **none** | ✓ 30/IP/min | **FIXED** |
| Probe storm protection on `/validate` | ❌ **none** | ✓ 10/IP/min | **FIXED** |
| `express-rate-limit` package wired | ❌ **installed but unused** | ✓ wired to 3 endpoints | **FIXED** |
| Password hashing | ✓ scrypt | ✓ verified | closed |
| Session tokens | ✓ random + sha256 + HttpOnly cookie | ✓ verified | closed |
| SQL injection | ✓ parameterized everywhere | ✓ verified | closed |
| SSRF | ✓ `isBlockedHost` checks | ✓ verified | closed |
| File path traversal | ✓ `safePath` checks | ✓ verified | closed |
| Helmet security headers | ⚠ hsts/csp/coop disabled | ⚠ documented | open (intentional for legacy plugin) |
| CSRF protection | ⚠ relies on SameSite=Lax | ⚠ documented | open |

## Findings & fixes

### 🔴 F1 — Login brute-force protection missing (CRITICAL)

**Before:** `/api/auth/login` accepted unlimited login attempts. An attacker
could brute-force passwords at line speed.

**Fix:** Wired `loginIpLimiter` (5 attempts per IP per minute) into
`POST /api/auth/login`.

```js
// server/routes/auth.js
router.post('/login', loginIpLimiter, (req, res) => { ... })
```

### 🔴 F2 — Agent chat spam protection missing (CRITICAL)

**Before:** `/api/agent/chat` and `/api/chat` accepted unlimited requests.
An attacker (or runaway script) could exhaust LLM quota.

**Fix:** Wired `agentChatLimiter` (30 requests per IP per minute).

### 🟡 F3 — Validate probe storm (MEDIUM)

**Before:** `/api/validate` accepts unlimited calls. Each call hits the
upstream provider to check key validity. An attacker could burn quota.

**Fix:** Wired `validateLimiter` (10/IP/min).

### 🟢 F4 — Helmet settings (LOW)

`helmet({ hsts: false, crossOriginOpenerPolicy: false, contentSecurityPolicy: false })`
is intentional — these headers conflict with the `@vitejs/plugin-legacy`
target `Android >= 7, Chrome >= 61`. This is documented inline.

### 🟢 F5 — CSRF protection (LOW)

BrowserAI relies on:
1. `SameSite=Lax` cookies (set on session creation).
2. CORS with `origin: true` (only same-origin in production via APP_URL).

This blocks most CSRF vectors. CSRF tokens would be belt-and-suspenders
but not currently implemented. For 9.0/10 target this is acceptable.

## Verification

`server/securityHardening.test.js` (10 tests) verifies:
- All 3 limiters are middleware functions with correct signature
- All 3 limiters allow first call through
- Source-level integration: each limiter is mounted on its target route
- `/api/health` is NOT rate-limited

Tests: 316 → 326 (10 new). All green.
