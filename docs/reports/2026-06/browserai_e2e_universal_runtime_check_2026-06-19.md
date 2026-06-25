# BrowserAI E2E universal runtime check — 2026-06-19

## Scope
Live post-deploy validation of universal Agent Mode behavior at project level:
- scoped workspace initialization
- evidence-backed local testing
- consolidated tool compatibility
- cross-provider Agent Mode behavior

## Server state after final deploy
- server repo: `/opt/browserai`
- current HEAD: `ce7f455` — `fix(agent): initialize scoped runs before consolidated checks`
- health: `{"deepseekManaged":true,"sandbox":"ok","browser":{"ok":true,"sessions":0}}`

## Live E2E checks performed

### 1) Managed DeepSeek generic coding task
Task type:
- create `universal-math-check`
- create `package.json`, `sum.js`, `test-sum.js`
- explicitly run local tests
- no deploy

Result:
- SSE stream completed with `done`
- files were created in scoped workspace
- local command `cd universal-math-check && node test-sum.js` passed
- final answer included runtime evidence

Observed issue during first run:
- initial scoped workspace root did not yet exist for new chat scope
- this caused early `list_files` / shell path errors before recovery

### 2) Cross-provider generic import-safe task on Zhipu AI
Task type:
- create `env-gated-runner`
- ensure import-safe module structure
- require env var only on direct run
- test import without secret
- explicitly run local tests
- no deploy

First result before follow-up fixes:
- reproduced a universal bug
- provider used consolidated tools (`file`, `shell`, `verify`, `plan`)
- final-answer gates did not fully recognize consolidated history as evidence
- run ended with `max-steps`

Root causes found:
1. `runAgent()` did not ensure scoped workspace root before the loop started.
2. verification / obligation / explicit-local-test gates recognized legacy tool names better than consolidated tool names.
3. consolidated `shell` / `verify` histories were undercounted in runtime evidence and success gates.

## Follow-up universal fixes applied
### Commit chain deployed
- `d8c6a6b` — `fix(agent): support consolidated-tool verification gates`
- `ce7f455` — `fix(agent): initialize scoped runs before consolidated checks`

### What changed
- `runAgent()` now calls `ensureWorkspaceRoot()` inside the scoped run before starting the agent loop.
- runtime digest now keeps `action` for consolidated tools.
- verification/local-test/obligation helpers now understand consolidated tools:
  - `file`
  - `shell`
  - `verify`
  - `plan`
  - `git`
  - `docker`
  - `ops`
- semantic tool success now handles consolidated `shell` and `verify` correctly.
- runtime evidence now reports consolidated file/shell/verify activity correctly.
- added `server/agentLoop.test.js` coverage for:
  - consolidated shell local-test detection
  - consolidated file→verify enforcement
  - consolidated obligation completion
  - scoped workspace initialization before loop start

## Final live re-check after redeploy
Repeated the same Zhipu import-safe task after deploy.

Result:
- HTTP 200 SSE stream
- no initial scoped-workspace ENOENT
- task completed with `done`
- step count: 23
- local test evidence recognized
- final answer contained:
  - created files
  - successful `node test-import.js`
  - expected failure of direct `node main.js` without `APP_TOKEN`
  - runtime evidence block

Conclusion:
- consolidated-tool compatibility issue is fixed
- scoped workspace initialization issue is fixed
- universal local-test gating now works across at least:
  - managed DeepSeek path
  - Zhipu / OpenAI-compatible consolidated-tool path

## Additional critical finding (NOT fixed in this pass)
A separate security issue was discovered during testing:
- public `GET /api/settings` currently exposes provider configurations including live API keys without authentication.

This is unrelated to the Agent Mode runtime fix set, but it is a severe project-level security issue and should be fixed urgently in a separate change.
