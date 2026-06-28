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

## Current State on Prod (reference)
- Health: OK (~5ms)
- AUTH_SECRET: present
- SQLite journal: WAL (already)
- OpenHands WS: not exposed in OpenAPI (will use REST + fallback)

## Next Immediate Steps
1. Phase 1.3 — agent memory/context prefix for reused conversations
2. Phase 1.4 — frontend streaming UX buffer via `requestAnimationFrame`
3. Phase 2 — event/workspace reliability

## Current Status (after Phase 1.2 perfecting pass)
- Fast sidebar load (<1s expected)
- No more N+1 event fetches on app start
- Messages loaded only when user opens/selects a chat
- UI active chat is repaired if cached activeId no longer exists on server
- Server-side SSRF/path/AUTH/WAL foundation complete for Phase 1.1
