# BrowserAI Agent Mode

Provider-agnostic LLM agent that can read/write workspace files, search
the web, and run sandboxed shell commands. Drop-in replacement for the
plain `/api/chat` endpoint when the user toggles **🤖 Агент** in the
Sidebar.

## High-level architecture

```
                    USER
                     │
                     ▼
            Composer / useChats
                     │  sendAgentMessage(text)
                     ▼
              streamAgent()           ──── src/lib/agentStream.js
                     │ fetch('/api/agent/chat', body: {provider, history})
                     ▼
       POST /api/agent/chat           ──── server/index.js
       ├── managed-deepseek inject
       └── runAgent()                 ──── server/agentLoop.js
                     │
                     ▼
              ┌──────┴──────┐
              │             │
        callLLM()      invokeTool()
        llmClient.js    agentTools.js
              │             │
       ┌──────┴──┐     ┌────┴──────────────┐
       │         │     │      │      │      │
   DeepSeek  OpenAI   FS    Web   Bash   ...
   (POW)    /chat/    workspace   sandbox
            completions          (docker exec
                                   agent-sandbox)
```

## Files

| File | What it does |
|---|---|
| `server/agentTools.js` | Tool registry — declarative metadata + async handlers |
| `server/agentSandbox.js` | `runSandboxCommand()` via `docker exec agent-sandbox` |
| `server/agentLoop.js` | Multi-step LLM ↔ tool loop, SSE event emitter |
| `server/llmClient.js` | `callLLM()` — picks DeepSeek-managed or OpenAI-compatible transport |
| `server/index.js` | `POST /api/agent/chat` + `GET /api/agent/health` |
| `src/lib/agentStream.js` | Client-side SSE parser, emits named events to a callback |
| `src/components/AgentToolBlock.jsx` | Inline collapsible tool-call card |
| `src/components/MessageList.jsx` | Renders thoughts + toolCalls interleaved by step |

## Tools

| Tool | Handler (server) | Purpose |
|---|---|---|
| `list_files`   | `workspace.getWorkspaceTree` | Drill into a folder, list entries |
| `read_file`    | `workspace.readWorkspaceFile` | Get text content, capped to 20 KB |
| `write_file`   | `workspace.createFile` / `writeFileContent` | Create or overwrite, auto-creates parent dirs |
| `edit_file`    | `workspace.readWorkspaceFile` + `writeFileContent` | Surgical replace with unique-substring check |
| `delete_file`  | `workspace.deleteItem` | Recursive delete |
| `search_files` | `workspace.searchWorkspaceContent` | grep-style search across workspace |
| `web_search`   | `web.searchWeb` | DuckDuckGo, up to 10 results |
| `web_fetch`    | `web.fetchWebPage` | Fetch + HTML strip, 12 KB cap |
| `download_url` | `workspace.uploadFromUrl` | Download public files/archives into Workspace; GitHub blob/repo URLs supported |
| `git_status`  | `git status` in sandbox | Branch + dirty state for a workspace repo |
| `git_diff`    | `git diff` in sandbox | Review changes before patch/commit |
| `git_commit`  | `git add` + `git commit` | Commit reviewed workspace changes |
| `git_clone`   | `git clone --depth` | Clone public repos when git history is needed |
| `git_pull`    | `git pull --ff-only` | Update an existing workspace repo |
| `bash`         | `runSandboxCommand` | Shell in agent-sandbox container, 30 s default timeout |

Every handler returns `{ok: boolean, result?: any, error?: string}`.
The loop serialises the result into a tagged `[tool_result …]` block
(text mode) or a proper `role:'tool'` message (native mode), then
gives it back to the LLM as the next observation.

## Provider transports

**DeepSeek managed** (`chat.deepseek.com/api/v0`)
- Uses `handleDeepSeekWebChat` so we reuse the POW + cookies + new
  minified-stream (`{p,o,v}`) parser the rest of the chat path uses.
- Tools are passed as JSON-in-text envelopes (no native function-calling
  on the chat web endpoint).
- `apiKey` is auto-injected from `deepseekTokenRefresher` when the
  client sends `apiKey: '__managed__'` (or omits it).

**OpenAI-compatible** (everyone else)
- Plain `POST /chat/completions` with `tools[]` + `tool_choice: 'auto'`
  if the host is in `supportsNativeTools()` whitelist (OpenAI, BigModel,
  Groq, Mistral, Together, OpenRouter, Gemini OpenAI proxy, DeepSeek
  Platform API).
- Other hosts get the same JSON-in-text envelope as DeepSeek managed.

## SSE event grammar

`POST /api/agent/chat` returns `Content-Type: text/event-stream`.
Each event has a `name` and a JSON `data` payload:

| Event | Payload | When |
|---|---|---|
| `thinking`    | `{step}` | About to call the LLM for step N |
| `thought`     | `{step, text}` | The LLM wrote prose text before/around its JSON envelope; surface it to the user |
| `tool_start`  | `{step, name, args}` | Server invoked a tool |
| `tool_result` | `{step, name, ok, result?, error?}` | Tool finished, result going back to the LLM |
| `assistant`   | `{text}` | Final answer (no more tool calls) |
| `done`        | `{steps, reason}` | Loop ended. `reason` ∈ `final` `max-steps` `deadline` `llm-error` `crash` `no-provider` |
| `error`       | `{message}` | Non-fatal error, will be followed by `done` |

Limits: `maxSteps = 15`, total deadline `5 min`. Override via
`runAgent({maxSteps})`.

## Sandbox

Defined in `docker-compose.yml` as the `agent-sandbox` service:

```yaml
agent-sandbox:
  image: alpine:3.20
  restart: unless-stopped
  command: sh -c "apk add --no-cache nodejs npm git curl ... && tail -f /dev/null"
  user: "0:0"      # bootstraps as root for apk add, exec uses uid 1000
  read_only: false
  tmpfs:
    - /tmp:size=64m
    - /home/agent:size=64m,uid=1000,gid=1000
  working_dir: /workspace
  volumes:
    - ${WORKSPACE_DIR:-./workspace}:/workspace
  mem_limit: 256m
  cpus: 0.5
  pids_limit: 128
```

`browserai` container mounts `/var/run/docker.sock` and has `docker-cli`
in its alpine image (added to `Dockerfile`), which is how
`runSandboxCommand` reaches the sandbox via plain `docker exec --user
1000:1000 -w /workspace agent-sandbox sh -c <cmd>`.

The API and sandbox must point at the same mounted workspace. Docker sets
`WORKSPACE_ROOT=/workspace`; without it the API may default to
`/data/workspace` while `bash` writes to `/workspace`, making downloaded
files invisible in the UI.

Output is capped at **8 KB stdout + 4 KB stderr** per command; everything
above gets the marker `... [truncated, N more bytes]`.

## Client UI hooks

- **`Topbar`** mobile-only `MobileHeaderModelPicker` so model switching
  is one tap away during agent runs.
- **`AgentToolBlock`** mimics Arena: `[>_] used Bash · echo "…" · ✓ · 527ms · ▾`.
  Mobile-tuned 12 px text, padding 2.5/1.5.
- **`MessageList`** interleaves `thoughts[]` and `toolCalls[]` by step
  so the user sees the model's plan before each action.
- **Persistence**: `lib/storage.js` `trimChatsForStorage()` clips
  `read_file/bash/web_fetch` payloads to 4 KB before writing to
  localStorage so a 20-step agent run doesn't blow the quota.

## Adding a new tool

1. In `server/agentTools.js`:
   ```js
   my_tool: {
     description: 'Human-readable description shown to the LLM',
     params: {
       arg1: { type: 'string', required: true, description: '…' },
     },
     handler: async ({ arg1 }) => {
       try { return ok(await doThing(arg1)) }
       catch (e) { return err(e.message) }
     },
   }
   ```
2. (Optional) In `src/components/AgentToolBlock.jsx` add an entry to
   `VERBS` for a nicer summary, and a custom branch in `formatResult()`
   if the result has a non-trivial shape.
3. Both `renderToolsForPrompt()` and `buildNativeToolsSpec()` pick the
   tool up automatically.

That's it — no other registrations.

## Operational notes

- `GET /api/agent/health` returns
  `{deepseekManaged: bool, sandbox: 'ok'|'unreachable: …'}` so an admin
  can verify the agent stack without sending a chat.
- The sandbox container takes ~30 s to install its tools on first boot
  (`apk add`). After that restarts are instant.
- Browser exits during an agent run abort the connection; the loop
  detects `res.on('close')` and stops issuing further tool calls.
