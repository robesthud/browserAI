# BrowserAI Approach 1 progress — 2026-06-19

## Goal
Advance Approach 1 (Security + Access Baseline) while preserving the autonomous minimal UI and fixing mobile chat UX regressions.

## Deployed commits
- `1f54d15` — `fix(auth): protect sensitive project routes`
- `c8dfe46` — `fix(ui): stabilize mobile chat scrolling and actions`
- `9018237` — `fix(auth): centralize route policy and owner guards`
- `9191dbb` — `fix(ui): prioritize native mobile touch scrolling`
- `3fb2790` — `fix(secrets): stop exposing stored provider keys to the client`
- `3fb63ce` — `fix(ui): reduce aggressive mobile viewport locking`
- `1394fb1` — `fix(ui): keep native mobile touch scroll responsive`

## What was improved in this batch
### Security / route policy
- added centralized authz helpers:
  - `server/authz.js`
- introduced shared policy primitives:
  - `requireAuth`
  - `requireRole(...)`
  - `requireOwner`
  - `requireAdmin`
- switched routes away from ad-hoc inline auth checks toward shared middleware
- owner-only policy now applied to sensitive global surfaces:
  - settings / keys / params / validate
  - operator routes
- kept authenticated access for:
  - workspace routes
  - agent execution routes
  - `/api/chat`
- kept public health route:
  - `GET /api/agent/health`

### Policy inventory
- created canonical route policy map:
  - `route_policy_inventory.md`

### Tests
- extended `server/routes/authz.test.js`
- verified:
  - unauthenticated sensitive routes return `401`
  - owner-only routes reject non-owner with `403`
  - workspace stays authenticated-only
  - agent health stays public
  - settings responses no longer expose live stored provider secrets

### Minimalist mobile UI hygiene
- removed nested chat scroll container conflict
- made `MessageList` the canonical mobile scroll root
- improved reliability of jump-to-latest behavior
- improved message copy behavior, including user messages
- preserved minimal autonomous UI philosophy
- after live feedback, disabled message-card swipe interception on coarse/mobile devices so native vertical touch scrolling wins
- explicitly set mobile scroll containers to `touch-action: pan-y`
- disabled edge-swipe navigation listeners on coarse/mobile devices so they no longer compete with native vertical touch scroll
- reduced aggressive mobile viewport locking/fixed-position behavior to prefer reliable touch input over brittle layout hacks

## Verification
### Local
- `npm test` → passed
- `runAgentSelfTest(...)` → `ok=true`
- `npm run build` → OK

### Production
Unauthenticated:
- `/api/settings` → `401`
- `/api/operator/projects` → `401`
- `/api/workspace/metadata` → `401`
- `/api/chat` → `401`
- `/api/agent/health` → `200`

Authenticated owner:
- `/api/settings` → `200`
- `/api/operator/projects` → `200`
- `/api/workspace/metadata` → `200`
- authenticated `/api/agent/chat` smoke run succeeded
- authenticated `/api/chat` succeeded using `keyId + useStoredSecret` without sending the real provider key from the client
- settings payload now returns masked/safe key DTO instead of full stored secrets

## Alignment after deploy
- GitHub `main` = `1394fb1`
- Timeweb `/opt/browserai` = `1394fb1`
- local canonical repo `/home/user/browserai_fresh` = `1394fb1`

## Remaining Approach 1 work
- audit logs/errors/stack traces for secret leakage
- long-term stricter reveal/rotate secret flow
