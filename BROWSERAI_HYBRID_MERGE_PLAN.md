# BrowserAI + OpenHands — Hybrid True Merge Plan

**Version:** 2026-06-28 (Hybrid v1.0)  
**Status:** Phase 0–1.2 completed/perfected; Phase 1.3 next
**Goal:** One cohesive product. BrowserAI = best-in-class shell. OpenHands = reliable agent engine. Zero dual sources of truth.

---

## 1. Executive Summary & Core Principles

**Vision**  
BrowserAI becomes the **complete user-facing product**. OpenHands remains an untouched high-quality agent runtime. We stop being a "proxy layer" and become a true integrated system.

**Guiding Principles**
1. **OpenHands is the canonical source of truth** for conversations, events, and agent execution.
2. **BrowserAI owns the entire user experience**: auth, vault, settings, memory/KB, workspace UI, billing, operator tools.
3. **One workspace volume** — no file copying.
4. **Minimal bridge** — only the thinnest possible translation layer.
5. **Zero architectural debt** — remove `isolation.py`, `docker.sock` exposure, dual chat lists, polling where possible.
6. **Incremental & safe** — every phase must be deployable and reversible.

**Key Success Metrics (Definition of Done)**
- `GET /api/cloud` makes ≤ 2 requests to OpenHands (currently N+1)
- Zero `{ok: true, stub: true}` responses
- `core/isolation.py` deleted + no `docker.sock` mounted for browserai
- `server.py` split into ≥ 8 focused modules (each ≤ 500 lines)
- New chat opens in < 3s (warm), first token < 1s (warm conversation)
- All agent events flow via WebSocket (or reliable improved polling)
- Workspace updates without race conditions
- `pytest -q` green + coverage ≥ 60%
- Full agent run + checkpoint restore works end-to-end

---

## 2. Current State Diagnosis (Synthesized from both plans + codebase)

### Major Problems (Ranked by Pain)

| # | Problem | Root Cause | Impact | Source |
|---|---------|------------|--------|--------|
| 1 | Dual source of truth for chats | `chat_conversations` mapping + localStorage + OH conversations | Chats "resurrect", 404s, slow loads | Both plans |
| 2 | Heavy polling (0.6s) | `_stream_chat` + `BROWSERAI_EVENT_POLL_INTERVAL` | High latency, load on OH | Both |
| 3 | Workspace race conditions | Direct FS + Docker runtime on same volume | File corruption, stale UI | New plan |
| 4 | Docker API hacks | `core/isolation.py` + `docker.sock` mount | 30s remounts, instability | New plan |
| 5 | ~13+ stub endpoints | Incomplete API contract | Broken UI features (operator, push, webhooks, policy) | New |
| 6 | Amnesia in long conversations | Only last message sent to agent | Poor agent memory | Old |
| 7 | Fat `server.py` (3244 LOC) | Everything in one file | Hard to test, maintain | New |
| 8 | No WAL in SQLite | Default journal mode | Lock contention under load | Old |
| 9 | Security gaps | Missing AUTH_SECRET validation, SSRF, path traversal | Production risk | Old + New |
| 10 | Cold starts + no progress UX | No visibility into runtime boot | Bad user experience | Old |

**What is already excellent (do not touch unless necessary):**
- `core/auth.py`, `core/vault.py`, `core/providers.py`
- `_translate_event()`, `_split_think()`, `_chunk_text()`
- `agentStream.js` (SSE client)
- Docker Compose structure (two services)
- Existing GitHub Actions + backup scripts

---

## 3. Target Architecture (Final State)

```
┌─────────────────────────────────────────────────────────────┐
│                    BrowserAI (User-Facing Product)          │
│  React + Vite + Tailwind                                    │
│  - Auth / Vault / Settings                                  │
│  - Memory KB + RAG                                          │
│  - Operator / Billing / Admin                               │
│  - Workspace UI (FileTree, Editor, Diff, Upload)            │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP + SSE (single origin)
┌──────────────────────────────▼──────────────────────────────┐
│  core/server.py (Thin Gateway + Business Logic)             │
│                                                             │
│  Own Layers (never delegate):                               │
│  • Auth, Sessions, Vault                                    │
│  • Providers / Keys / Validation                            │
│  • Memory KB + Facts                                        │
│  • Workspace FS operations                                  │
│  • Operator, Billing, Webhooks (real implementations)       │
│                                                             │
│  Thin OH Bridge (only):                                     │
│  • create_conversation()                                    │
│  • send_message()                                           │
│  • events (WebSocket → SSE)                                 │
│  • list / delete conversations                              │
└──────────────────────────────┬──────────────────────────────┘
                               │ WebSocket + REST
┌──────────────────────────────▼──────────────────────────────┐
│  OpenHands Agent Server (ghcr.io/all-hands-ai/openhands:main)│
│  - CodeActAgent (untouched)                                 │
│  - LiteLLM routing                                          │
│  - Docker runtime sandboxes                                 │
└─────────────────────────────────────────────────────────────┘

Shared Volume: /workspace/chats/<chatId>  (both sides)
```

**Bridge rules:**
- Only `core/bridge/` (new) will talk to OpenHands.
- No direct OH logic leaks into business routes.
- All conversation state lives in OpenHands.

---

## 4. Phased Roadmap (6–7 weeks)

### Phase 0: Preparation (1–2 days) — **Start Immediately**

**Goal:** Inventory + safe branch + validation baseline

- [x] Create feature branch: `feat/true-hybrid-merge`
- [x] Run inventory scripts:
  ```bash
  grep -roh "'/api[^']*'" ui/src --include="*.jsx" --include="*.js" | sort -u > /tmp/ui_calls.txt
  grep -oP "(?<=@app\.(get|post|put|patch|delete)\([\"'])/api[^\"']*" core/server.py | sort -u > /tmp/server_real.txt
  ```
- [x] Document current SSE contract in `docs/sse-contract.md`
- [x] Verify OpenHands WebSocket availability on prod:
  ```bash
  curl -s http://localhost:18000/openapi.json | python3 -c "import sys,json; d=json.load(sys.stdin); print([k for k in d.get('paths',{}) if 'ws' in k.lower()])"
  ```
- [x] Baseline metrics:
  - `curl -w "%{time_total}\n" -o /dev/null http://localhost:8080/api/health`
  - Measure chat list load time from UI
  - `docker stats` during agent run
- [x] Add `AUTH_SECRET` validation + WAL to prod `.env` (if missing)
- [x] Create rollback plan document

**Deliverable:** `docs/current-state-audit.md` + feature branch

---

### Phase 1: Foundation & Quick Stabilization (3–5 days)

**Goal:** Eliminate the most painful immediate issues. Make the system reliable.

#### 1.1 Critical Fixes (Day 1)
- [x] **SQLite WAL** (`core/database.py`)
- [x] **AUTH_SECRET startup validation** (`core/server.py`)
- [x] **Improved `_safe_abs`** (symlink + strict parent check)
- [x] **SSRF protection** (`_assert_url_safe`)
- [x] **Shared httpx client** with proper pool limits

#### 1.2 Fast Chat Loading (Day 2–3)
- [x] New endpoint: `GET /api/chats/list` (meta only)
- [x] New endpoint: `GET /api/chats/{chat_id}/messages` (lazy)
- [x] Refactor `useChats.js`:
  - `chatList` = only metadata
  - `messages[chatId]` loaded on demand
  - Keep localStorage only as display cache
- [x] Update `Sidebar` and `MessageList` to use new endpoints

#### 1.3 Agent Memory Fix (Day 3–4)
- [ ] In `_stream_chat`: load last 15–20 events when reusing conversation
- [ ] Build `context_prefix` with previous turns (Role: content)

#### 1.4 Streaming UX (Day 4–5)
- [ ] `deltaBuffer + requestAnimationFrame` in `agentStream.js`
- [ ] Proper `flushDelta` + optimistic message state

**Validation:**
- Chat list loads < 800ms
- First token appears < 1.2s (warm)
- No more "resurrected" chats

---

### Phase 2: Event Streaming & Workspace Reliability (4–6 days)

**Goal:** Kill polling where possible. Make workspace trustworthy.

#### 2.1 WebSocket Bridge (Primary Path)
- [ ] Create `core/bridge/ws_client.py`
- [ ] Implement `_stream_chat_ws()` with fallback to polling
- [ ] Add per-chat lock (`asyncio.Lock`) to prevent concurrent streams
- [ ] Translate OH WebSocket events → BrowserAI SSE (reuse `_translate_event`)

#### 2.2 Workspace Synchronization
- [ ] Add `useWorkspace.js` with smart polling (only during streaming)
- [ ] Debounce tree refresh (1000ms)
- [ ] On `tool_result` for `write_file` / `bash` → trigger refresh
- [ ] Add file revision token to reduce unnecessary full trees

#### 2.3 Remove / Deprecate Isolation Hack (Gradual)
- [ ] Add feature flag: `BROWSERAI_USE_ISOLATION=1`
- [ ] Refactor `isolation.py` to use OpenHands `config.toml` per conversation (preferred)
- [ ] Start removing direct `docker` calls from browserai container

**Validation:**
- Events arrive with < 150ms latency
- No more workspace races during long agent runs
- Can disable isolation for new chats

---

### Phase 3: Fill the Stubs — Real Features (7–10 days)

**Goal:** Make every UI panel actually work.

Prioritized order:

1. **Policy & Approval** (`/api/agent/policy`, `/api/approval/*`)
2. **Operator missions & incidents** (`/api/operator/*`)
3. **Push / Cloud sync improvements**
4. **Webhooks** (GitHub, custom)
5. **Cron jobs & scheduled tasks**
6. **Checkpoint create/restore** (full support)
7. **Admin diagnostics & deep health**

For each:
- Implement real logic (or thin wrapper + storage in SQLite)
- Add corresponding UI components (most already exist)
- Write minimal tests

**Validation:** Zero stub responses in production.

---

### Phase 4: Architecture Cleanup & Modularity (5–7 days)

**Goal:** Make the codebase maintainable.

- [ ] Split `core/server.py` into modules:
  ```
  core/
    routes/
      auth.py
      chat.py
      workspace.py
      cloud.py
      operator.py
      admin.py
    bridge/
      openhands.py
      ws_client.py
      events.py
    services/
      memory.py
      vault.py
      providers.py
  ```
- [ ] Move streaming logic to `core/stream/`
- [ ] Extract conversation mapping helpers
- [ ] Use FastAPI routers (`app.include_router`)
- [ ] Reduce `server.py` to < 800 lines (orchestration only)

**Validation:** Each module has its own tests. `pytest -q` still green.

---

### Phase 5: Security, Hardening & Production Polish (4–5 days)

- [ ] Remove `/var/run/docker.sock` mount from `browserai` service
- [ ] Add rate limiting (`slowapi` or custom)
- [ ] Full path traversal + symlink hardening
- [ ] Add Caddy (or nginx) for HTTPS (self-signed or Let's Encrypt)
- [ ] Non-root user in Dockerfile
- [ ] Structured logging + trace correlation improvements
- [ ] Cold start progress indicator (`AgentColdStart.jsx`)
- [ ] Add `/api/metrics` (basic Prometheus-style)

---

### Phase 6: UI Performance & Experience (3–4 days)

- [ ] Virtualized `MessageList` (`react-window` or `IntersectionObserver`)
- [ ] Optimistic updates + better loading states
- [ ] SSE auto-reconnect with exponential backoff
- [ ] Debounced workspace tree
- [ ] Chat rename inline + better title generation
- [ ] Keyboard shortcuts audit

---

### Phase 7: Testing, Observability & Release (ongoing + final 5 days)

- [ ] Contract tests for SSE events
- [ ] Integration test: full agent run
- [ ] Load test (locust or k6) on key endpoints
- [ ] Add structured logs + `/api/health/deep`
- [ ] Playwright E2E for critical flows
- [ ] Feature flags for risky changes
- [ ] Cut release `v1.0.0`

---

## 5. Quick Wins (Can ship today / tomorrow)

These give maximum value with minimal risk:

1. **SQLite WAL + busy_timeout** (5 min)
2. **AUTH_SECRET validation** (5 min)
3. **`/api/chats/list` + `/api/chats/{id}/messages`** (2–3 hours)
4. **Remove duplicate status polling inside `_stream_chat`**
5. **Context prefix for reused conversations** (agent memory)
6. **deltaBuffer + rAF streaming** in frontend
7. **Debounce workspace tree refresh**
8. **Remove `docker.sock` from browserai service** (security win)
9. **Add `GET /api/debug/client-error`** (real implementation)

---

## 6. Critical Path & Parallelization

**Must be sequential:**
Phase 0 → Phase 1 (foundation) → Phase 2 (streaming + workspace)

**Can run in parallel:**
- Phase 3 (stubs) — after Phase 1
- Phase 4 (modularity) — after Phase 1
- Phase 5 (security) — after Phase 1
- Phase 6 (UI perf) — after Phase 1
- Tests — every phase

**Suggested weekly split (team of 1–2):**
- Week 1: Phase 0 + Phase 1
- Week 2: Phase 2
- Week 3: Phase 3 (high priority stubs)
- Week 4: Phase 4 + Phase 5
- Week 5: Phase 6 + remaining stubs
- Week 6: Phase 7 + release

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|----------|
| WebSocket API in OpenHands unstable | Medium | High | Strong polling fallback + feature flag |
| Removing isolation breaks existing chats | Medium | High | Gradual rollout + per-chat flag + 30-day migration window |
| Big refactor introduces bugs | High | Medium | Small PRs, feature branch, heavy testing on dev |
| Performance regression during transition | Medium | Medium | Continuous benchmarking + rollback plan |
| Docker volume permissions after changes | Low | Medium | Document volume ownership + test in CI |

**Rollback strategy:**
- Keep `main` stable
- Tag releases before every major phase
- Use env flags for new behavior
- One-command rollback: `git reset --hard TAG && docker compose up -d --build`

---

## 8. Additional Improvements (Added in this Hybrid Plan)

1. **Observability Layer**
   - Structured JSON logs with `trace_id`
   - `/api/metrics` endpoint (requests, latency, token usage)
   - Integration with existing `obslog.py`

2. **Feature Flags System**
   - `core/feature_flags.py`
   - Flags: `USE_WS_STREAMING`, `USE_NEW_ISOLATION`, `ENABLE_CHECKPOINTS`, etc.

3. **Gradual Isolation Removal**
   - New per-conversation config via OpenHands `config.toml`
   - Old isolation kept behind flag for 2–3 weeks

4. **Better Title Generation**
   - Use first user message + LLM summarization for chat titles

5. **Checkpoint UI**
   - Visual timeline of checkpoints
   - One-click restore

6. **Performance Budgets**
   - Document SLIs in `docs/slis.md`
   - Add simple latency assertions in tests

7. **Documentation**
   - `docs/architecture.md`
   - `docs/deployment.md`
   - `docs/sse-contract.md` (mandatory)

8. **CI Improvements**
   - Add `pytest --cov`
   - Add Playwright in GitHub Actions
   - Pre-deploy health + smoke tests

---

## 9. Success Criteria — Final Checklist

- [ ] All Definition of Done items from section 1
- [ ] Zero dual chat sources
- [ ] WebSocket (or reliable streaming) in production
- [ ] `isolation.py` removed or fully deprecated
- [ ] `docker.sock` not mounted for browserai
- [ ] All major UI features work (no stubs)
- [ ] `server.py` modularized
- [ ] Load test passes (50 concurrent agents)
- [ ] E2E critical path green
- [ ] Documentation updated
- [ ] Team can explain the architecture in < 5 minutes

---

## 10. How to Execute This Plan

1. **Today**: Start Phase 0. Create branch and run inventory.
2. **This week**: Complete Phase 1.
3. **Track progress** in this file (update checkboxes).
4. **Review every Friday**: Adjust scope based on learnings.
5. **Deploy to Timeweb only after green smoke tests**.

**Recommended first commit message after Phase 0:**
```
feat: hybrid merge foundation - WAL, AUTH_SECRET, safe_abs, shared client
```

---

**End of Plan**

This is the single source of truth for the merge effort. It combines the **actionable code** from the tactical plan with the **deep architectural clarity** from the strategic plan, plus additional improvements for production readiness.

Next action: **Start Phase 0**.

---

*Generated with deep analysis of both source plans + live codebase inspection (server.py: 3244 LOC, isolation.py active, docker.sock mounted, chat_conversations mapping in use).*
