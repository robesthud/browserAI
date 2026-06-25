# BrowserAI Approach 2 progress — 2026-06-20

## Goal
Drive BrowserAI toward a single universal automated runtime across different tool paths and different AI models.

## Canonical commits in this approach so far
- `3eae446` — `refactor(agent): centralize runtime history semantics`
- `e01a641` — `refactor(agent): normalize runtime evidence entries`
- `6d60fd5` — `refactor(provider): centralize stored and managed provider resolution`
- `84dc00f` — `refactor(agent): centralize runtime call semantics`
- `c41b6f1` — `refactor(runtime): sanitize errors and centralize tool result semantics`
- `53d66cc` — `feat(jobs): expose authenticated background job routes`
- `bf0dc06` — `feat(operator): add provider parity smoke suite`
- `f14965a` — `docs(roadmap): record provider parity smoke progress`
- `e590fe8` — `feat(operator): add provider parity scenario matrix`
- `1098b61` — `docs(auth): document jobs route policy`
- `f2a5877` — `feat(jobs): expose authenticated background job routes`

## What is now unified
### 1) Runtime history semantics
- `server/agentRuntimeSemantics.js`
- unified interpretation for:
  - file/read/write/edit/search
  - verify/code/task/npm_test
  - local-test detection
  - deploy / health / logs obligations
  - post-edit verification expectations

### 2) Runtime evidence semantics
- recent tool history entries now move toward normalized semantic/evidence objects
- runtime evidence reporting consumes semantic information instead of more fragile raw-name logic

### 3) Provider resolution semantics
- `server/providerResolution.js`
- same stored/managed provider resolution now serves:
  - `/api/chat`
  - `/api/agent/chat`
  - settings validation
  - background agent jobs

### 4) Runtime call semantics
- `server/runtimeCallSemantics.js`
- centralized handling for:
  - read-back after file edits
  - pre-deploy verification gating
  - tool narration

### 5) Runtime tool-result semantics
- `server/runtimeToolResultSemantics.js`
- centralized handling for:
  - semantic tool success vs raw transport success
  - unified tool outcome summaries

### 6) Runtime error sanitization discipline
- `server/errorSanitizer.js`
- route errors, provider errors and logger meta now follow a centralized sanitization path
- Gemini debug URL logging no longer emits raw API keys

### 7) Background job runtime parity
- `/api/jobs/*` is now mounted and authenticated
- background job API now exists for the UI surfaces already calling it
- user-scoped access checks added for reading/cancelling/retrying jobs
- returned job input is sanitized so inline provider secrets are not exposed back to clients
- background agent entrypoint is now part of the same runtime unification effort instead of a half-detached surface

### 8) Provider parity smoke surface
- owner-only provider parity smoke suite added
- `server/providerParitySmoke.js`
- operator route can now list parity targets and run a multi-provider smoke pass
- reusable SSE capture helper extracted for these runs

### 9) Scenario-based provider parity matrix
- added canonical smoke scenarios in `server/providerParityScenarios.js`
- operator route can now list scenarios and run a scenario matrix
- supported matrix scenarios currently include:
  - `chat_ok`
  - `agent_file_write`
  - `agent_local_test`
- this is the first concrete bridge from structural unification into cross-provider regression behavior

## Test growth
Added / strengthened:
- `server/agentRuntimeSemantics.test.js`
- `server/providerResolution.test.js`
- `server/runtimeCallSemantics.test.js`
- `server/runtimeToolResultSemantics.test.js`
- `server/providerParitySmoke.test.js`
- `server/providerParityScenarios.test.js`
- `server/routes/jobs.test.js`
- `server/errorSanitizer.test.js`

Current result:
- `npm test` → 27 passed
- `runAgentSelfTest(...)` → `ok=true`
- `npm run build` → OK

## Current effect on platform quality
This does not magically make BrowserAI a 9/10 system yet, but it meaningfully reduces:
- tool-path drift
- provider-path drift
- duplicated agent runtime logic
- secret leakage risk through debug/error surfaces

And it improves:
- universality
- automation reliability
- evidence-driven behavior
- future refactorability of Agent Mode

## Remaining work inside Approach 2
- push more `agentLoop` decisions onto normalized semantic entries
- expand multi-provider e2e parity checks
- move more recovery/diagnostic logic onto normalized runtime layers
- build a broader regression matrix across providers and task classes
