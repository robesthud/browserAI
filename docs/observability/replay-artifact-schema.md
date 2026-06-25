# Replay Artifact Schema — Approach 6

Status: **canonical, `browserai.replay.v1`**

A replay artifact is a JSON file at `${DATA_DIR}/replays/${runId}.json` that
bundles everything needed to reproduce the run's reasoning and verify its
finalization.

## Top-level shape

```json
{
  "schema": "browserai.replay.v1",
  "runId": "run-1781953437806-458f606e",
  "capturedAt": "2026-06-20T11:03:57.806Z",
  "provider": { "id": "https://api.example", "model": "gpt-x" },
  "input": {
    "lastUserAsk": "fix bug",
    "historySize": 3,
    "chatId": "c-42",
    "taskType": "dev_task"
  },
  "run": {
    "schema": "browserai.run_log.v1",
    "startedAt": "...",
    "finishedAt": "...",
    "durationMs": 1234,
    "summary": { "filesRead": 1, "filesChanged": 2, "commandsRun": 3, "testsRun": 1, "testsPassed": 1, "errors": 0, "toolCalls": 7 }
  },
  "history": [ { "tool": "file", "family": "file", "action": "write", "path": "a.js", "ok": true, "evidenceTags": ["change"], "verificationKind": null, "at": 1234567 } ],
  "historySummary": {
    "total": 8, "okCount": 7, "failCount": 1,
    "filesRead": 1, "filesChanged": 2, "commandsRun": 1,
    "testsRun": 2, "testsPassed": 1,
    "healthChecks": 1, "logsChecks": 0, "deploys": 1, "commits": 0
  },
  "finalStatus": {
    "reason": "final",
    "taskCompleted": true,
    "verified": true,
    "localTests": { "requested": false, "attempted": false, "passed": false },
    "deploy": { "requested": false, "done": false, "verified": false },
    "blockers": [],
    "evidenceSummary": { ... }
  },
  "sseTrace": [
    { "event": "stream_protocol", "at": 1234567, "payload": { "version": 1 } },
    { "event": "tool_start", "at": 1234570, "payload": { "step": 1, "name": "file" } },
    { "event": "done", "at": 1234600, "payload": { "reason": "final" } }
  ],
  "sseSummary": {
    "totalEvents": 12,
    "countsByEvent": { "stream_protocol": 1, "tool_start": 3, "tool_result": 3, "done": 1 },
    "firstEventAt": 1234567,
    "lastEventAt": 1234600,
    "doneReason": "final",
    "lastError": null,
    "streamCut": false
  },
  "meta": {}
}
```

## History entry shape

Each entry in `history[]` carries normalized semantic fields (from
`agentRuntimeSemantics.runtimeSemantics`), so consumers can reason about
files / tests / deploys without re-parsing tool names:

- `tool` — original raw tool name
- `family` — semantic family (`file`, `shell`, `verify`, `git`, `docker`, `ops`, `web`, `browser`)
- `action` — semantic action (`read`, `write`, `edit`, `commit`, ...)
- `path` — file path if applicable
- `command` — shell command if applicable
- `args` — args digest (truncated to 240 chars)
- `ok` — boolean
- `outcome` — short outcome string from `summarizeToolOutcome`
- `evidenceTags` — semantic tags (`inspect`, `read`, `change`, `verify`, `local_test`, `commit`, `push`, `deploy`, `health`, `logs`)
- `isCommit`, `isLocalTest`, `isVerify`, `isDeploy`, `isHealthCheck`, `isLogsCheck`, `isInspect` — boolean flags
- `verificationKind` — `code`, `task`, `npm_test`, `run_tests`, `test_command`, `verify_command`, or null

## SSE summary

`sseSummary` collapses the raw `sseTrace` into counters and the key
single-event fields downstream needs:

- `totalEvents` — total number of SSE events emitted
- `countsByEvent` — histogram `{event-name → count}`
- `firstEventAt` / `lastEventAt` — wall-clock ms of first / last event
- `doneReason` — termination reason from the `done` event
- `lastError` — error message from the last `error` event before `done`
- `streamCut` — `true` if the stream started but never emitted a `done` event

`streamCut` is the core signal for the `streamCutRate` KPI.

Tests: `server/replayArtifact.test.js` (12 tests) + `server/observabilityIntegration.test.js` (6 tests).
