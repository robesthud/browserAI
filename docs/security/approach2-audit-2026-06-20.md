# Approach 2 — Runtime Unification — Audit Report

Date: 2026-06-20
Auditor: deep audit pass
Scope: runtime semantics dispatch, consolidated↔legacy parity, provider resolution, workspace scope, regression coverage

## Summary

| Area | Before audit | After audit | Status |
|---|---|---|---|
| Semantic dispatch layer | ✓ widely used (8 files) | ✓ verified | closed |
| Semantic parity tests | ✓ 17 tests | ✓ verified | closed |
| `expandConsolidatedCall` coverage | ❌ **no dedicated test file** | ✓ 36 tests added | **FIXED** |
| `isConsolidatedTool` returns true for STANDALONE | ❌ **broken — returned false** | ✓ fixed | **FIXED** |
| `expandConsolidatedCall(null args)` | ❌ **crashed with TypeError** | ✓ defensive | **FIXED** |
| Registry consistency check | ❌ no automated test | ✓ added | **FIXED** |
| Workspace scope under background jobs | ✓ `runAgent` wraps | ✓ verified | closed |
| Provider resolution centralization | ✓ all paths use it | ✓ verified | closed |
| Final status reason in replay artifact | ✓ passed explicitly | ✓ verified | closed |

## Findings & fixes

### 🔴 F1 — `expandConsolidatedCall` had no dedicated test file

**Before:** `server/toolConsolidation.js` (389 lines, the heart of Approach 2)
had no dedicated test file. The semanticParity test verified the OUTPUT
of `runtimeSemantics()` but never tested the actual `expandConsolidatedCall`
transformation that turns `file(action:"write")` into `write_file`.

If a typo or missing action existed in the consolidation matrix, the
semantic test wouldn't catch it because semantic still works on legacy
names.

**Fix:** Added `server/toolConsolidation.test.js` with 36 tests:
- 19 tests for `expandConsolidatedCall` (every group + common actions)
- 7 tests for graceful error handling (missing/empty/unknown action,
  null/undefined args, legacy pass-through)
- 5 tests for registry consistency (isConsolidatedTool, CONSOLIDATED_TOOL_NAMES)
- 5 tests for `buildConsolidatedNativeSpec` (OpenAI schema validity)

### 🔴 F2 — `isConsolidatedTool` returned false for STANDALONE tools

**Before:**
```js
export function isConsolidatedTool(name) {
  return Boolean(GROUPS[name])   // ← only checks GROUPS, not STANDALONE_TOOLS
}
```

So `isConsolidatedTool('ask_user')` returned `false`, even though
`ask_user` is in `STANDALONE_TOOLS` and `CONSOLIDATED_TOOL_NAMES`.

This caused inconsistency: the allowlist would treat `ask_user` as a
legacy tool that needed explicit permission, while `CONSOLIDATED_TOOL_NAMES`
claimed it was consolidated. Real production bug.

**Fix:**
```js
export function isConsolidatedTool(name) {
  if (Boolean(GROUPS[name])) return true
  if (STANDALONE_TOOLS.includes(name)) return true
  return false
}
```

### 🔴 F3 — `expandConsolidatedCall` crashed with null args

**Before:**
```js
export function expandConsolidatedCall(name, args = {}) {
  const action = String(args.action || '').trim()  // ← TypeError if args is null
```

**Fix:** Defensive `safeArgs` normalization:
```js
export function expandConsolidatedCall(name, args) {
  const safeArgs = (args && typeof args === 'object') ? args : {}
  ...
}
```

## Verification

- 36 new tests in `server/toolConsolidation.test.js` — all green
- All 19 actions across 14 groups tested end-to-end
- All 7 STANDALONE tools verified as consolidated
- All underlying names in GROUPS verified to exist in TOOLS

Tests: 326 → 362 (36 new). All green.

## What stays the same

- **Workspace scope invariants:** `runAgent(opts)` wraps in
  `withWorkspaceScope(workspaceScope, ...)`. Background jobs in
  `jobs.js` pass `workspaceScope: job.chatId` to runAgent. Workflows,
  checkpoints, and recovery actions all use scope correctly.
- **Provider resolution:** All entry points (routes/agent.js,
  routes/settings.js, jobs.js, providerParitySmoke.js) use
  `resolveProviderFromInput`. No inline provider construction.
- **Final status reason:** All 7 termination paths in agentLoop.js
  build `finalStatus` and pass `reason` separately to `buildReplayArtifact`
  so the replay artifact has both `finalStatus.reason` and the full
  blocker list.
