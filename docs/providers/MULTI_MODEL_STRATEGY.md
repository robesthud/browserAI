# Multi-Model Strategy — GLM core + Ollama & DeepSeek as specialists

> Status: **PLAN / strategy only** (not yet implemented). Captured 2026-06-26.
> Goal: with **GLM-4.5-flash** as the primary model, give Ollama and DeepSeek
> roles where they are genuinely useful, instead of competing on the same task.

## TL;DR role split

| Model | Strength | Weakness | Assigned role |
|---|---|---|---|
| **GLM-4.5-flash** (z.ai, native pi-ai) | Reliable native tool-calling, fast, free tier | needs API key + balance for paid GLMs | **Primary AGENT** — files, code, tools, games |
| **DeepSeek-web** (chat.deepseek.com) | Strong free chat & reasoning | tool-calling unstable (unofficial reverse API, throttling) | **CHAT / reasoning** — talk, explain, write; NO tools |
| **Ollama** `qwen2.5-coder:1.5b` | Local, free, private, always-on | too small for agentic tool-calling | **Micro-tasks & offline fallback** — intent routing, chat titles, last-resort |

Key principle: never give a model a task class it is bad at. Then weaknesses
(Ollama can't do agent loops; DeepSeek is flaky at tools) never surface.

## Routing flow (builds on existing server/smartRouter.js)

```
User message
   │
   ├─ classify intent (cheap: Ollama local) → CHAT / WEB / AGENT
   │
   ├─ AGENT (create file, code, game, ops) → GLM-4.5-flash  (native tool-calling) ★
   ├─ CHAT  (conversation, explain, write) → DeepSeek-web    (free, no tools needed)
   ├─ WEB   (news, weather, prices)        → GLM or DeepSeek + web_search tool
   └─ FALLBACK (everything failed)         → Ollama local (private, always available)
```

## Concrete roles

### GLM-4.5-flash — primary agent (the workhorse)
- All tool-calling work: write_file, edit_file, bash, git, workspace, games.
- Engine: `pi-ai-native` (already wired in agentEngine.js / piNativeEngine.js).
- baseUrl `https://api.z.ai/api/coding/paas/v4`, key in `.env` `ZAI_API_KEY`.
- Paid GLMs (glm-4.7, glm-4.5-air) unlock when z.ai balance is topped up.

### Ollama (qwen2.5-coder:1.5b) — cheap local helper
Good for tiny, frequent, non-agentic tasks that would waste GLM quota:
1. **Intent classifier** for the router (CHAT/WEB/AGENT) — one-word output, 1.5B is fine.
2. **Chat auto-titles** — summarize first message into a short title.
3. **Offline / quota fallback** — if GLM is down or rate-limited, answer locally.
4. **Privacy lane** — keep sensitive prompts on-box (never leaves the server).
5. (Optional, future) **Embeddings / local search** if an embedding model is pulled.
- Already kept warm: `OLLAMA_KEEP_ALIVE=-1`, bound to 127.0.0.1 (closed to internet).

### DeepSeek-web — free conversational model (no tools)
DeepSeek is unstable for tool-calling (unofficial web transport, throttling →
occasional empty responses), but excellent and free for plain chat:
1. **CHAT mode** — conversation, explanations, writing articles/text.
2. **Reasoning** (`deepseek-reasoner`) — deep analysis without files.
3. **Chat backup for GLM** — if GLM hits its limit, DeepSeek handles conversation.
- Hardening already done: fresh session per call, loop-guard, empty-response
  retry, code-fence stripping, correct text→tools ordering.

## Why this is good for the project
- 💰 Cost: routing + titles run on free local Ollama, saving GLM quota.
- ⚡ Speed: GLM isn't invoked for trivial chit-chat.
- 🛡️ Resilience: 3-tier fallback (GLM → DeepSeek → Ollama) keeps the app up.
- 🔒 Privacy: sensitive prompts can stay on local Ollama.

## Implementation hooks (when ready)
- `server/smartRouter.js` — already classifies CHAT/WEB/AGENT and has a provider
  fallback chain; extend it to pick the model per intent.
- `server/agentEngine.js` — engine selection already hybrid (native vs legacy);
  add per-intent provider override.
- Suggested provider profiles (store in DB/settings):
  - `agent`  → zai / glm-4.5-flash
  - `chat`   → deepseek-web / deepseek-chat
  - `router` → ollama / qwen2.5-coder:1.5b
  - `fallback` order: zai → deepseek → ollama

## Notes / caveats
- DeepSeek-web can never be 100% reliable (unofficial reverse API). Keep it off
  the critical tool-calling path.
- Ollama 1.5B is NOT suitable for agent tasks — use only for micro-tasks/fallback.
- For heavier agent work, top up z.ai balance to use glm-4.7 / glm-4.5-air.
