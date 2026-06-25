# Quality KPI Dashboard — Approach 6

Status: **canonical, served by `GET /api/operator/kpis`**

A compact dashboard for owner users that surfaces the quality of the agent
runtime over the last N runs. All fractions are floats in `[0, 1]`.

## KPI definitions

| KPI | Formula | Meaning |
|---|---|---|
| `successRate` | runs where `taskCompleted=true` AND `verified=true` AND `blockers=[]` AND `deploy.done+verified` (if requested) | The fraction of runs that genuinely completed without any obligation gap. |
| `falseFinalRate` | runs where `taskCompleted=true` BUT `(blockers ≠ [])` OR any blocker of type `fabrication` / `missing_verification` / `verification_missing` | The fraction of runs that CLAIMED success while having evidence problems. |
| `maxStepsRate` | runs whose termination `reason` is `max-steps` or `deadline` | Fraction that ran out of steps — should trend toward 0 as scope detection improves. |
| `streamCutRate` | replays whose `sseSummary.streamCut === true` | Fraction whose SSE stream never emitted a `done` event. |
| `verificationMissingRate` | runs whose finalStatus has a blocker of type `missing_verification` or `verification_missing` | Fraction where code changed but no verification ran after the last edit. |
| `providerFailureRate` | runs whose termination `reason` is `no-provider` or `llm-error`, OR whose blockers include `provider` / `auth` category | Fraction that hit a provider-side failure. |

## Endpoint

```
GET /api/operator/kpis?limit=100     # owner-only
```

Response shape (`browserai.kpis.v1`):

```json
{
  "schema": "browserai.kpis.v1",
  "requested": { "limit": 100 },
  "total": 100,
  "successRate": 0.62,
  "falseFinalRate": 0.04,
  "maxStepsRate": 0.07,
  "streamCutRate": 0.02,
  "verificationMissingRate": 0.03,
  "providerFailureRate": 0.05,
  "byProvider": {
    "mock": { "total": 50, "successRate": 1.0, "falseFinalRate": 0, "maxStepsRate": 0, "streamCutRate": 0, "verificationMissingRate": 0, "providerFailureRate": 0 },
    "managed_deepseek": { "total": 30, "successRate": 0.7, "providerFailureRate": 0.13, ... }
  },
  "byTaskType": {
    "dev_task": { "total": 60, "successRate": 0.7 },
    "research": { "total": 25, "successRate": 0.5 }
  },
  "windowStart": "2026-06-19T11:03:57.000Z",
  "windowEnd": "2026-06-20T11:03:57.000Z"
}
```

## Companion endpoints

```
GET /api/operator/runs?limit=50        # browserai.run_index.v1 — recent run summaries
GET /api/operator/runs/:runId          # full run log JSON (browserai.run_log.v1)
GET /api/operator/replays?limit=50     # browserai.replay_index.v1 — recent replay ids
GET /api/operator/replays/:runId       # full replay artifact JSON (browserai.replay.v1)
```

All endpoints are owner-only via `requireOwner` middleware.

## KPI sanity bounds

- A run can be in multiple rate denominators (e.g. `maxStepsRate` and
  `verificationMissingRate` are independent — a single run can be counted in
  both).
- `successRate + falseFinalRate ≤ 1` always holds (a run cannot be both).
- KPIs on empty `total=0` return `null` for all rates (caller must check).

## When to alert

A simple operator rule of thumb (not enforced, just a guideline):
- `falseFinalRate > 0.10` → investigate fabrication gates.
- `maxStepsRate > 0.20` → investigate scope detection / obligations.
- `streamCutRate > 0.05` → investigate client disconnects / proxy timeouts.
- `providerFailureRate > 0.15` → check provider health + keys.
- `verificationMissingRate > 0.10` → check post-edit verification gates.

Tests: `server/qualityKpis.test.js` (6 tests).
