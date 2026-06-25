# Error Taxonomy — Approach 6

Status: **canonical, used across `agentLoop`, `agentSelfTest`, `runLogs`, `replayArtifact`, `qualityKpis`**

A single classification for every error the agent runtime can produce. Every
`runLog` event of type `error` and every persisted replay artifact carries a
`{category, severity, fingerprint, reason, tool, exitReason, route}` block that
goes through this classifier.

## Categories

| Category | Trigger patterns | Severity | Example |
|---|---|---|---|
| `auth` | `401\|403\|unauthorized\|invalid[_ ]?token\|api[_ ]?key\|expired[_ ]?credential\|permission[_ ]?denied` | `error` | `401 Unauthorized: invalid api key` |
| `provider` | `5\d\d\|provider[_ ]?error\|rate[_ ]?limit\|429\|timeout\|connect[_ ]?econnrefused\|eai_again\|fetch[_ ]?failed\|open[_ ]?ai\|anthropic\|gemini\|deepseek\|openrouter` | `error` | `429 Too Many Requests` |
| `route` | `\b404\b\|\b405\b\|\b400\b\|invalid[_ ]?request[_ ]?body\|missing[_ ]?field\|malformed` | `warn` | `400 Bad Request: missing field` |
| `workspace_scope` | `workspace[_ ]?scope\|chats?[_ ]?dir\|cross[_ ]?scope\|out[_ ]?of[_ ]?scope\|invalid[_ ]?scope` | `error` | `workspace_scope: invalid scope` |
| `tool_schema` | `unknown[_ ]?action\|invalid[_ ]?args?\|missing[_ ]?required\|tool[_ ]?requires\|unknown[_ ]?tool` | `warn` | `unknown action "z" for tool "file"` |
| `tool_execution` | (reserved for explicit tool runtime errors) | `warn` | (none yet) |
| `loop_stuck` | `max[_ ]?steps\|step[_ ]?limit\|stuck\|oscillat\|repeated[_ ]?same[_ ]?tool\|too[_ ]?many[_ ]?retries`; exitReason `max-steps` / `deadline` | `warn` | `max_steps` blocker |
| `llm_runtime` | `json[_ ]?parse\|tool[_ ]?call[_ ]?parse\|no[_ ]?tool[_ ]?call\|empty[_ ]?reply\|blank[_ ]?reply\|llm[_ ]?error`; exitReason `crash` / `llm-error` | `error` | `LLM failed: 500` |
| `verification_missing` | `missing[_ ]?verif\|no[_ ]?verif[_ ]?after[_ ]?edit\|verify[_ ]?missing` | `warn` | `missing_verification` blocker |
| `false_finalization` | `fabrication\|fabricat\|false[_ ]?final\|ungrounded[_ ]?claim` | `error` | `fabrication: cited imaginary/path.js` |
| `deploy_runtime` | `deploy[_ ]?sh\|docker[_ ]?compose[_ ]?up\|systemctl\|restart[_ ]?failed\|health[_ ]?check[_ ]?fail\|deploy[_ ]?error` | `error` | `deploy.sh failed: docker compose up returned 1` |
| `aborted` | exitReason `cap-reached` | `info` | (cancelled by user) |
| `unknown` | (fallback) | `warn` | anything not matching above |

## Severity

- `info` — informational (e.g. user-aborted)
- `warn` — recoverable, no immediate action needed
- `error` — failure, requires attention
- `critical` — reserved for use by incident router (not auto-set by classifier)

## Fingerprint

`sha256(category | normalized-reason | tool-or-empty)` truncated to 16 hex chars.
Stable across calls, so identical errors collapse in incident dashboards.

## Sanitization

The classifier additionally scrubs URL-embedded secrets and common API key
patterns from `reason` before returning:
- `?key=...`, `?token=...`, `?apikey=...`, `?api_key=...`, `?access_token=...`, `?sid=...`, `?signature=...`
- `Bearer <long>` → `Bearer <redacted>`
- `sk-<long>` → `sk-<redacted>`
- `ghp_<long>` → `ghp_<redacted>`

Tests: `server/errorTaxonomy.test.js` (16 tests).
