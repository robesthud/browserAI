# BrowserAI Ops Gateway

Ops Gateway is the server-side service-connector layer used by Agent Mode to work with external systems without exposing secrets to the model.

## Agent tools

The agent sees only these generic tools:

- `ops_list_services` — list configured services and allowed actions.
- `ops_run_action` — run a safe action, or a dangerous action after confirmation.

Secrets are stored on the server as environment variables or files. Tool results must not include tokens — all ops output (command stdout/stderr, GitHub file contents, deploy logs) and audit-log error fields are passed through `redactSecrets()`, which strips known env-var values plus token-shaped patterns (GitHub PATs, Bearer tokens, JWTs, private keys, session cookies) before reaching the agent/LLM or the audit log.

## Built-in services

### `browserai`

Actions:

| Action | Safe | Purpose |
|---|---:|---|
| `health` | yes | Check BrowserAI and Gemini proxy health |
| `docker_ps` | yes | Show `docker compose ps` |
| `docker_logs` | yes | Show logs for a compose service, params: `{service, tail}` |
| `git_status` | yes | Show current commit and dirty files in `/opt/browserai` |
| `deploy` | no | Reset to `origin/main`, rebuild, restart, health-check |
| `deploy_safe` | no | Deploy with **automatic rollback**: records current commit, pull+build+up+health-check; if health fails, resets to the previous commit, rebuilds and re-checks |
| `repair_deploy` | no | Deploy plus diagnostics: pre-status, build/up, health, browserai logs, gemini logs, summary exit codes |
| `restart` | no | Restart BrowserAI container |
| `gemini_restart` | no | Restart `gemini-web-proxy.service` |

Dangerous actions return `requiresConfirmation` unless called with `confirm:true`. The agent should use `ask_user` before running them.

### `github`

Actions:

| Action | Safe | Purpose |
|---|---:|---|
| `repo_status` | yes | Repository metadata |
| `actions_runs` | yes | Recent GitHub Actions runs |
| `workflow_logs` | yes | Download logs for a run id |
| `get_file` | yes | Read repo file |
| `put_file` | no | Create/update repo file |
| `rerun_workflow` | no | Rerun a workflow |

Required env:

```env
GITHUB_TOKEN=github_pat_...
GITHUB_REPO=robesthud/browserAI
```

### `telegram`

Action:

- `notify_admin` — send text to `TG_ADMIN_CHAT_ID`.

Required env:

```env
TG_USER_BOT_TOKEN=...
TG_ADMIN_CHAT_ID=...
```

## Dynamic REST connectors

Additional REST services can be added without code via:

```text
/data/ops/services.json
```

Example:

```json
{
  "services": [
    {
      "id": "notion",
      "label": "Notion",
      "type": "rest",
      "baseUrl": "https://api.notion.com/v1",
      "auth": { "type": "bearer", "env": "NOTION_TOKEN" },
      "headers": { "Notion-Version": "2022-06-28" },
      "actions": {
        "search": { "safe": true, "method": "POST", "path": "/search" }
      }
    }
  ]
}
```

Supported auth types:

- `bearer`: `Authorization: Bearer <env>`
- `header`: custom header name/value from env
- `basic`: username/password envs

## Typical repair loop

When user asks “deploy/fix deploy/check logs”:

1. `ops_list_services`
2. `ops_run_action browserai.git_status`
3. `ops_run_action browserai.health`
4. `ops_run_action browserai.docker_logs`
5. If deploy requested, `ask_user` for confirmation.
6. `ops_run_action browserai.repair_deploy {confirm:true}`
7. Analyze summary/logs.
8. If code changes are needed, use workspace/git tools, then repeat deploy after confirmation.

## Admin dashboard

A visual `/admin/ops` dashboard is available (auth required). It shows
service/gateway/sandbox status, lists every service action (safe actions are
neutral, dangerous ones are marked ⚠), recent jobs, and an output pane.
Dangerous actions trigger a confirmation dialog and are only sent with
`confirm:true` after the operator agrees.

## What is still missing

- Persistent audit log UI for ops actions.
- Rich “repair loop” orchestration UI with progress steps.
- Native MCP server support.
- More prebuilt connectors: Cloudflare, Railway, Vercel, Notion, Slack/Discord, databases.
- Fine-grained per-user permissions for dangerous ops actions.
