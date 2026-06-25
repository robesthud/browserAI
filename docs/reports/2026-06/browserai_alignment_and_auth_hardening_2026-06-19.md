# BrowserAI alignment and auth hardening — 2026-06-19

## Goal
Continue universal project-level hardening, verify GitHub/Timeweb actuality, and align the active repos/runtime.

## Final canonical state
### GitHub
- `origin/main` = `1f54d15`
- commit: `fix(auth): protect sensitive project routes`

### Timeweb server
- `/opt/browserai` HEAD = `1f54d15`
- branch status: aligned with `origin/main`
- health:
  - `{"deepseekManaged":true,"sandbox":"ok","browser":{"ok":true,"sessions":0}}`
- containers healthy/running:
  - `browserai`
  - `agent-sandbox`
  - `browserai-db`
  - `browserai-ollama`
  - `computer-sandbox`

### Local verified repo
- `/home/user/browserai_fresh`
- hard-aligned to `origin/main @ 1f54d15`
- clean working tree

## Universal fixes delivered in this pass
### 1) Auth hardening for sensitive platform routes
Protected project-level routes with server-side auth instead of relying only on the frontend AuthGate.

Routes now require auth:
- `server/routes/settings.js`
- `server/routes/workspace.js`
- `server/routes/operator.js`
- `server/routes/agent.js`

Exception intentionally kept public:
- `GET /api/agent/health`

Effects:
- unauthenticated users can no longer read live provider keys from `/api/settings`
- unauthenticated users can no longer access workspace contents
- unauthenticated users can no longer invoke operator endpoints
- unauthenticated users can no longer use `/api/chat` or `/api/agent/chat`

### 2) Alignment verification
Confirmed the following are aligned on the same deployed commit:
- GitHub main
- Timeweb `/opt/browserai`
- local canonical repo `/home/user/browserai_fresh`

## Verification performed
### Local tests
- `npm test` → passed
- route auth tests added and passed
- `runAgentSelfTest(...)` → `ok=true`
- `npm run build` → OK

### Route-level security checks on production
Unauthenticated:
- `GET /api/settings` → `401`
- `GET /api/workspace/metadata` → `401`
- `GET /api/operator/projects` → `401`
- `POST /api/agent/chat` → `401`
- `GET /api/agent/health` → `200`

Authenticated:
- login via real account credentials succeeded
- `GET /api/settings` → `200`
- `GET /api/workspace/metadata` → `200`
- `GET /api/operator/projects` → `200`

### Authenticated live Agent Mode check after hardening
Ran authenticated Agent Mode task through `/api/agent/chat` after the security change.
Task:
- create `auth-check.txt` with `AUTH_OK`
- no deploy

Result:
- request succeeded with auth cookie
- file was created
- stream completed with `done: final`
- final answer included runtime evidence

## Notes on non-canonical older repo
- `/home/user/browserai` is an older scratch repo and is not the canonical verified deployment source.
- It has no configured `origin` remote in its current state, so it was left untouched to avoid destructive cleanup.
- Canonical aligned source remains `/home/user/browserai_fresh`.
