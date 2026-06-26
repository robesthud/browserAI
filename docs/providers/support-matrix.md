# Provider Support Matrix — Approach 7

Status: **canonical, served by `GET /api/operator/provider-support`**

Every provider the agent runtime can talk to is in this matrix, with a
**tier**, a **tested-at date**, and a list of **known limitations**.

## Tiers

| Tier | Meaning | UI badge | Pre-deploy |
|---|---|---|---|
| `certified` | Production-tested, regressions in CI | None | Smoke suite must pass |
| `experimental` | Smoke-tested but may have rough edges | Yellow "Experimental" badge | Smoke suite must pass |
| `legacy` | Historically supported, being phased out | Yellow "Legacy" badge | Smoke suite must pass |
| `unsupported` | Not in matrix — best-effort | Red "Unsupported" badge | **No** smoke expectation |

## Current matrix

| ID | Tier | Base URL pattern | Tested | Known limitations |
|---|---|---|---|---|
| `managed_deepseek` | certified | `chat.deepseek.com/api/v0` | 2026-06-20 | No native tools; non-standard SSE |
| `gemini_official` | certified | `generativelanguage.googleapis.com` | 2026-06-20 | Free-tier quota may saturate |
| `anthropic_official` | experimental | `api.anthropic.com` | 2026-06-20 | Not all models support tools |
| `openai_compat` | experimental | `\/(v1\|api\/v1)\/?$` | 2026-06-20 | Catch-all; capabilities vary per upstream |

## Adding a new provider

1. Add an entry to `PROVIDER_SUPPORT_MATRIX` in `server/providerSupport.js`.
2. Start at tier `experimental` — never auto-bump to `certified`.
3. Add a smoke scenario in `server/providerParityScenarios.js`.
4. Run the scenario in CI; collect a sample `runId` and update
   `sampleRunId`.
5. After 2 weeks of clean smoke runs and zero `false_finalization` /
   `provider_failure_rate` regressions in `/api/operator/kpis`, owner may
   bump to `certified`.

## Removing a provider

When a provider goes EOL or is no longer safe:

1. Bump tier to `legacy` first (keeps the matrix entry for backwards
   compat).
2. After 30 days, remove from matrix entirely.
3. Unknown providers fall through to `unsupported` automatically — no
   breakage.

## Distinction from regression matrix

Two related but different concepts exist:

- **`server/providerSupport.js`** (this file) — the user-facing support
  matrix. Each entry corresponds to a **provider the user can configure
  and persist**. Tier reflects production-readiness.

- **`server/regressionProviderMatrix.js`** — the testing-time provider
  matrix. Each entry corresponds to a **provider scenario the regression
  suite can exercise**, including mock providers, zhipu_official, and
  groq_official which are NOT user-configurable production providers.

The regression matrix may list providers not in the support matrix
because we test against them even though we don't expose them as
production presets. The support matrix is the source of truth for UI
badges and routing decisions.

## Lookup precedence

`lookupProviderSupport(provider)` matches in this order:

1. **By id** (e.g. `{ id: 'managed_deepseek' }`)
2. **By baseUrl pattern** — iterated top-to-bottom of the matrix
3. **Fallback to `unsupported`** for anything not matched

This means a more specific entry **must** come before the catch-all
`openai_compat` in the matrix, or it will be swallowed by the broad
`/v1$/` regex.

## UI integration

- `AgentSettingsSection.jsx`: shows the tier badge next to each saved
  provider.
- `providerWarning(provider)` returns the warning text+severity for
  non-certified tiers; the UI should surface this when the user picks an
  experimental or unsupported provider.
- `GET /api/operator/provider-support` is the canonical dashboard for
  owner users; it returns the full matrix.
