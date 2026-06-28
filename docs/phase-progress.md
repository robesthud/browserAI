# Hybrid Merge — Execution Progress

**Branch:** feat/true-hybrid-merge  
**Started:** 2026-06-28

## Phase 0 — Preparation ✅

- [x] Feature branch created
- [x] Full API inventory (69 UI calls / 107 server endpoints)
- [x] docs/current-state-audit.md
- [x] docs/sse-contract.md
- [x] BROWSERAI_HYBRID_MERGE_PLAN.md added to repo
- [x] OpenHands WebSocket availability checked: not exposed in OpenAPI; Phase 2 will keep REST/polling fallback
- [x] Rollback plan documented in `docs/rollback-plan.md`
- [x] Python bytecode removed from Git and ignored

## Phase 1.1 — Critical Foundation ✅ (2026-06-28)

- [x] SQLite WAL + busy_timeout + cache (core/database.py)
- [x] AUTH_SECRET startup validation + length check
- [x] Hardened `_safe_abs` (symlink + relative_to protection)
- [x] SSRF protection (`_assert_url_safe` + blocked hosts)
- [x] Shared httpx client (`_oh_client`) with startup/shutdown lifecycle
- [x] OpenHands calls in `core/server.py` routed through `_oh_session()` pooled client; only external downloads use a separate client
- [x] SSRF hardening expanded to DNS resolution, URL credentials, internal ports, `.local`/`.internal`

**Commit:** `b8aff74`

## Phase 1.2 — Fast Chat Loading ✅ (2026-06-28)

- [x] `GET /api/chats/list` — fast metadata only
- [x] `GET /api/chats/{chat_id}/messages` — lazy load
- [x] `backend.chatsList()` + `backend.chatMessages()`
- [x] `useChats.js` refactored:
  * Starts empty (no localStorage as source)
  * Loads only metadata from server on mount
  * Lazy-loads messages on `selectChat`
  * Keeps localStorage only as display cache
- [x] Server remains source of truth (OpenHands)


## Phase 1.3 — Agent Memory Fix ✅ (2026-06-28)

- [x] `_stream_chat` fetches recent OpenHands events for mapped/reused chats before sending the next message
- [x] Builds compact `context_prefix` from the last BrowserAI user/assistant turns
- [x] Prepends context to the current user request without re-rendering old events in the UI
- [x] Strips BrowserAI runtime workspace suffixes and previous context wrappers to avoid recursive prompt growth
- [x] Tunable via `BROWSERAI_CONTEXT_PREFIX_MESSAGES` and `BROWSERAI_CONTEXT_PREFIX_MAX_CHARS`


## Phase 1.4 — Streaming UX ✅ (2026-06-28)

- [x] Added `requestAnimationFrame` delta coalescing in `ui/src/lib/agentStream.js`
- [x] Buffered `assistant_delta`, `thinking_delta`, and chunked `tool_progress` events per paint
- [x] Non-delta/control events call `flushDelta()` first to preserve stream ordering
- [x] Abort/stop path flushes pending deltas before cancelling the request
- [x] Existing optimistic assistant state in `useChats.js` remains intact and receives smoother batched events


## Phase 2 — Event Streaming & Workspace Reliability 🚧 (started 2026-06-28)

### Phase 2.1 — Event streaming / WebSocket bridge ✅
- [x] Verified prod OpenHands realtime endpoint: Socket.IO at `/socket.io/` with `oh_event` events for `conversation_id`
- [x] Added `core/bridge/ws_client.py` Socket.IO/WebSocket client with Engine.IO heartbeat handling
- [x] Added `_stream_chat_ws()` and automatic transport selection via `BROWSERAI_OPENHANDS_STREAM_TRANSPORT=auto|ws|poll`
- [x] Added WS → BrowserAI SSE translation through the same `_translate_event` contract
- [x] Added REST polling fallback if WS connect/handshake/idle fails
- [x] Added per-chat in-process `asyncio.Lock` wrapper for `/api/agent/chat` streams
- [x] Concurrent sends to the same chat now return SSE `done: {reason: "busy"}` instead of mixing OpenHands events

### Phase 2.2 — Workspace synchronization ✅
- [x] Added workspace tree `revision` token on server (`count:size:newest_mtime`)
- [x] Added per-file `fileRevisions` tokens (`path -> size:mtime_ns`) for file-level invalidation
- [x] Added `ifRevision` support: unchanged workspaces return `{unchanged:true}` without full tree payload
- [x] Added `ui/src/lib/useWorkspace.js` for smart polling / debounced refresh
- [x] Workspace UI debounces refreshes around agent tool/file events
- [x] On `tool_result` for write/bash-like tools, UI sends structured workspaceRevision and refreshes with `ifRevision`
- [x] Workspace UI smart-polls during streaming with revision validation

### Phase 2.3 — Isolation removal 🚧
- [ ] `core/isolation.py` still active
- [ ] `/var/run/docker.sock` still mounted for `browserai`; removal deferred until OpenHands config-based runtime mounting is verified

## Current State on Prod (reference)
- Health: OK (~5ms)
- AUTH_SECRET: present
- SQLite journal: WAL (already)
- OpenHands WS: Socket.IO `/socket.io/` verified; BrowserAI uses WS with REST polling fallback

## Next Immediate Steps
1. Phase 2.3 — start isolation deprecation behind `BROWSERAI_USE_ISOLATION`
2. Phase 2.3 — feature-flag isolation and plan docker.sock removal
3. Phase 3 — start replacing remaining stub endpoints

## Current Status (after Phase 2 partial)
- Fast sidebar load (<1s expected)
- No more N+1 event fetches on app start
- Messages loaded only when user opens/selects a chat
- UI active chat is repaired if cached activeId no longer exists on server
- Server-side SSRF/path/AUTH/WAL foundation complete for Phase 1.1
- Reused conversations now receive compact previous-turn context before the new request
- Streaming deltas are coalesced per animation frame for smoother UI and fewer React updates
- Per-chat stream lock prevents concurrent agent runs from mixing events
- Workspace tree refresh is debounced and revision-aware during streaming
