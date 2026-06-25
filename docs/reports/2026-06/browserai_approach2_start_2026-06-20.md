# BrowserAI Approach 2 start — 2026-06-20

## Goal
Start Runtime Unification so BrowserAI behaves more like one universal automated development runtime across tool paths and providers.

## Local commits prepared
- `5e35671` — `refactor(agent): centralize runtime history semantics`
- `39283ff` — `refactor(agent): normalize runtime evidence entries`
- `b4adfa6` — `refactor(provider): centralize stored and managed provider resolution`
- `23ca644` — `refactor(agent): centralize runtime call semantics`

## What changed
- extracted a dedicated runtime semantics module:
  - `server/agentRuntimeSemantics.js`
- moved common tool-history interpretation into one place:
  - file/read/write semantics
  - verify semantics
  - local-test detection
  - explicit local-test detection
  - health/log/deploy obligation semantics
  - verification-after-edit semantics
- `server/agentLoop.js` now imports these semantics instead of carrying a growing set of duplicated ad-hoc helpers
- runtime history entries are now normalized into a more explicit semantic/evidence shape before being reused by gates and runtime evidence reporting
- provider resolution was centralized in:
  - `server/providerResolution.js`
- the same provider-resolution logic now serves:
  - `/api/chat`
  - `/api/agent/chat`
  - settings validation
  - background agent job provider reconstruction
- runtime call semantics were extracted to:
  - `server/runtimeCallSemantics.js`
- the same call semantics now drive:
  - tool narration
  - edit read-back generation
  - pre-deploy verification gate
- added tests:
  - `server/agentRuntimeSemantics.test.js`
  - `server/providerResolution.test.js`
  - `server/runtimeCallSemantics.test.js`

## Why this matters
This is the first structural step toward:
- unified behavior for legacy and consolidated tools
- less provider-path drift
- evidence/finalization logic that depends on normalized semantics instead of raw tool names

## Verification
- `npm test` → passed
- `runAgentSelfTest(...)` → `ok=true`
- `npm run build` → OK

## Next step
Deploy `5e35671`, then continue converting more runtime gates from raw history checks toward normalized semantic entries.
