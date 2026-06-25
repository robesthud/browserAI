# BrowserAI universal platform changes — 2026-06-19

## Goal
Make Agent Mode and workspace behavior universal at the project/platform level:
- no Telegram-specific assumptions
- no task-specific self-report shortcuts
- works for any supported model and any project type

## Local repo used
- `/home/user/browserai_fresh`

## Changes prepared

### 1) `server/agentLoop.js`
Restored the full valid file and strengthened universal runtime gates:
- force a real local test run when the user explicitly requested local testing and no test run exists in tool history
- block false claims like `all tests passed` / `все тесты пройдены` unless successful local test evidence exists
- block `environment/sandbox cannot verify` claims unless there is direct tool evidence from a real attempted command
- store **semantic** tool success in `recentToolHistory` instead of raw transport success, so failed test commands are not counted as successful verification

New helpers added:
- `hasLocalTestAttempt()`
- `hasStrongLocalTestSuccessClaim()`

New pushback flags added:
- `explicitLocalTestPushback`
- `localTestSuccessClaimPushback`
- `unsupportedEnvClaimPushback`

### 2) `server/agentPrompt.js`
Strengthened universal coding/testability rules:
- code must be import-safe by default
- top-level modules should avoid runtime side effects
- secret checks / network boot / service startup / bot polling must be deferred into explicit entrypoints or main functions
- tests should not require production secrets unless the user explicitly requested integration testing

This generalizes the weather-bot failure into a platform rule for all generated projects.

### 3) `server/routes/workspace.js`
Kept the universal chat-scoped workspace routing fix in the fresh repo:
- request scope from `x-browserai-chat-id`, query, or body
- wrap all workspace routes with scoped execution
- ensure workspace root per scope
- support scoped chat init/delete

## Why this is universal
These changes do not reference Telegram, weather bots, or any specific stack.
They enforce platform-wide behavior for:
- truthful final reports
- evidence-backed verification claims
- safe/testable code structure
- correct per-chat workspace isolation

## Next operational step
Run validation in the real BrowserAI runtime/container, then commit/push/redeploy if the result is clean.
