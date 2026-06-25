# BrowserAI route policy inventory

Date: 2026-06-20
Purpose: canonical access-policy map for the active HTTP surface.

## Policy levels
- `public` — available without session
- `auth` — any authenticated user
- `owner` — owner-only / administrative surface
- `internal` — not exposed as public route, runtime-only concern

## Mounted route groups
- `/api/auth/*` → mixed public/auth depending on endpoint
- `/api/workspace/*` → `auth`
- `/api/agent/*` → mostly `auth`, except `/api/agent/health` = `public`
- `/api/jobs/*` → `auth`
- `/api/operator/*` → `owner`
- `/api/*` (agent proxy mount) → `auth` for `/api/chat`
- `/api/*` (settings/cloud mount) → mixed `auth` and `owner`
- `/api/health` → `public`


## Updates after Approach 6 + 7 (2026-06-20)

### Approach 6 — Observability endpoints (owner-only)
- `GET /api/operator/kpis?limit=N` → `browserai.kpis.v1`
- `GET /api/operator/runs?limit=N` → `browserai.run_index.v1`
- `GET /api/operator/runs/:runId` → full `browserai.run_log.v1`
- `GET /api/operator/replays?limit=N` → `browserai.replay_index.v1`
- `GET /api/operator/replays/:runId` → full `browserai.replay.v1`
- `GET /api/operator/provider-support` → `browserai.provider_support.v1`
- `GET /api/operator/release-safety` → `browserai.release_safety_dashboard.v1`
- `POST /api/operator/agent-self-test` → runs `runAgentSelfTest()` on demand

### Approach 7 — Stream resilience endpoints (auth)
- `GET /api/runs/:chatId` → `browserai.chat_runs.v1`
- `GET /api/runs/:chatId/last` → `browserai.chat_last_run.v1`
- `POST /api/runs/:chatId/resume` → `browserai.chat_resume.v1` (returns summary + replay artifact)
- `POST /api/runs/:chatId/reset` → clears active run guard for the chat (auth)


## Detailed inventory

### Public
- `GET /api/health`
- `GET /api/agent/health`
- `GET /api/auth/me` (returns `{ user: null }` when logged out)
- `POST /api/auth/login`
- `POST /api/auth/logout`
- Any future auth bootstrap/reset endpoints must be reviewed individually

### Authenticated user
- `GET /api/cloud`
- `PUT /api/cloud`
- `GET /api/cost/today`
- `GET /api/workspace/metadata`
- `GET /api/workspace/tree`
- `GET /api/workspace/file`
- `GET /api/workspace/download`
- `POST /api/workspace/chat/init`
- `DELETE /api/workspace/chat`
- `POST/PUT/DELETE /api/workspace/*` file mutation endpoints
- `POST /api/agent/chat`
- `POST /api/chat`
- `GET /api/agent/tasks`
- `GET /api/agent/tasks/latest`
- `POST /api/agent/runs/:chatId/reset`
- `GET /api/agent/questions`
- `POST /api/agent/answer`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/agent`
- `POST /api/jobs/tool`
- `POST /api/jobs/:id/cancel`
- `POST /api/jobs/:id/retry`

### Owner-only / administrative
- `GET /api/settings`
- `GET /api/keys`
- `POST /api/keys`
- `POST /api/keys/:id/activate`
- `DELETE /api/keys/:id`
- `PUT /api/params`
- `POST /api/validate`
- `GET /api/operator/incidents`
- `GET /api/operator/incidents/:id`
- `POST /api/operator/incidents/:id/resolve`
- `GET /api/operator/missions`
- `GET /api/operator/missions/:id`
- `GET /api/operator/deploy-sessions`
- `GET /api/operator/projects`
- `GET /api/operator/runbooks`

## Notes / current limitations
1. `/api/settings` still returns live provider keys to the owner UI because the current frontend architecture keeps active provider credentials client-side for validation and chat proxy requests.
2. Long-term target: migrate toward safer owner-scoped secret handling where routine UI reads use masked DTOs and explicit secret reveal/update flows.
3. If BrowserAI evolves toward real multi-user collaborative mode, the `auth` vs `owner` split for workspace/agent may need per-user resource ownership enforcement, not only session presence.
