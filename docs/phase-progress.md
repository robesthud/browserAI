# Hybrid Merge — Execution Progress

**Branch:** feat/true-hybrid-merge  
**Started:** 2026-06-28

## Phase 0 — Preparation ✅

- [x] Feature branch created
- [x] Full API inventory (69 UI calls / 107 server endpoints)
- [x] docs/current-state-audit.md
- [x] docs/sse-contract.md
- [x] BROWSERAI_HYBRID_MERGE_PLAN.md added to repo

## Phase 1.1 — Critical Foundation ✅ (2026-06-28)

- [x] SQLite WAL + busy_timeout + cache (core/database.py)
- [x] AUTH_SECRET startup validation + length check
- [x] Hardened `_safe_abs` (symlink + relative_to protection)
- [x] SSRF protection (`_assert_url_safe` + blocked hosts)
- [x] Shared httpx client (`_oh_client`) with startup/shutdown lifecycle

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

Next targets:
- `GET /api/chats/list` (meta only, fast)
- `GET /api/chats/{chat_id}/messages` (lazy load)
- Update `useChats.js` + backend.js

## Current State on Prod (reference)
- Health: OK (~5ms)
- AUTH_SECRET: present
- SQLite journal: WAL (already)
- OpenHands WS: not exposed in OpenAPI (will use REST + fallback)

## Next Immediate Steps
1. Implement `/api/chats/list`
2. Implement lazy messages endpoint
3. Minimal UI changes for useChats
4. Test on Timeweb

## Current Status (after Phase 1.2)
- Fast sidebar load (<1s expected)
- No more N+1 event fetches on app start
- Messages loaded only when user opens a chat
