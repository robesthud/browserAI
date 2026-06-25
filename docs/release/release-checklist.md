# Release Checklist — Approach 7

**Every** push to `origin/main` that touches `server/` or `docker-compose.yml` is a release candidate.
Run through this checklist **before** the push. Auto-checked items live in
`GET /api/operator/release-safety`.

## Pre-push (developer)

- [ ] `node --check server/agentLoop.js` and other modified server files
- [ ] `npm test` — all 250+ tests green
- [ ] `npm run build` — vite build OK
- [ ] `runAgentSelfTest()` — `ok=true, 5/5 checks`
- [ ] New behavior covered by a regression test
- [ ] If you touched a tool: covered by an integration test (mock provider
      or `regressionSuite`)
- [ ] If you added a migration or schema change: documented in
      `docs/observability/` and updated the relevant operator endpoint
- [ ] If you touched secrets/auth: re-read `route_policy_inventory.md` and
      `docs/release/backup-policy.md`

## Pre-deploy (auto)

`GET /api/operator/release-safety` must report:

- [ ] `summary.ready === true`
- [ ] `summary.worstSeverity` not `critical` or `error`
- [ ] `checks.disk.ok === true`
- [ ] `checks.secrets.ok === true`
- [ ] `checks.dataDir.ok === true`
- [ ] `checks.gitClean.ok === true` (warning is OK if you have intentional
      local changes)
- [ ] `checks.appHealthy.ok === true`

`scripts/pre-deploy-smoke.sh` must exit 0 (non-blocking warning OK if no
providers configured locally).

## Deploy (CI / `deploy.sh`)

- [ ] `git push origin main` triggers `.github/workflows/deploy-timeweb.yml`
- [ ] `bash deploy.sh` on Timeweb:
  - [ ] pulls latest commit
  - [ ] resets to `origin/main`
  - [ ] prunes cache if disk > 80%
  - [ ] runs `docker compose build browserai`
  - [ ] recreates `browserai` and `agent-sandbox` containers
  - [ ] waits up to 40 retries for `/api/health`
  - [ ] logs `=== Deploy completed ===`

## Post-deploy verification (operator)

- [ ] `curl https://<domain>/api/health` → 200 + `{"ok":true,...}`
- [ ] `curl https://<domain>/api/agent/health` → 200 + DeepSeek managed OK
- [ ] Owner login → `/api/operator/release-safety` shows `ready=true`
- [ ] Owner login → `/api/operator/kpis?limit=10` shows recent run totals
- [ ] Send 1 trivial agent message and verify it completes (`done` event
      with `finalStatus.taskCompleted=true`)
- [ ] Check `/data/runs/` for new run log + `/data/replays/` for replay

## Rollback triggers (auto)

Initiate rollback **immediately** if any of:

- `/api/health` returns non-200 for 2+ minutes after deploy
- `runAgentSelfTest()` returns `ok=false`
- A new run produces `reason: 'crash'` with stack trace pointing to the new
  code
- Disk usage jumps > 5% within 5 minutes of deploy
- A regression test in `tests/regressionSuite.test.js` fails on the live
  smoke matrix

→ See `docs/release/rollback-checklist.md`.
