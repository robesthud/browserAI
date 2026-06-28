# BrowserAI Current State Audit
**Date:** 2026-06-28  
**Branch:** feat/true-hybrid-merge  
**Plan Version:** Hybrid v1.0

## Inventory Summary

### API Surface
- **UI calls to /api**: 69 unique endpoints
- **Real server endpoints**: 107 (from FastAPI routes)
- **Gap (stubs / unimplemented)**: ~38 endpoints (many return `{ok: true, stub: true}` or are partial)

### Key Endpoints Found (sample)
**High priority (used by UI):**
- `/api/agent/chat` (main streaming)
- `/api/cloud`
- `/api/chats/{chat_id}`
- `/api/workspace/*` (tree, file, upload, download)
- `/api/auth/*`
- `/api/keys`
- `/api/health`, `/api/health/deep`
- `/api/memory/*`
- `/api/operator/*`, `/api/jobs`, `/api/incidents` (many stubs)

### Architectural Debt Indicators
- `core/server.py`: **3244 lines** (monolith)
- `core/isolation.py`: **163 lines** (still active)
- `chat_conversations` table: exists in schema
- `docker.sock` mounted in `browserai` service (docker-compose.yml)
- No WAL in SQLite
- No `AUTH_SECRET` startup validation
- Heavy polling at 0.6s

### Current Strengths
- Mature auth + vault
- Good event translation (`_translate_event`)
- Working SSE client in UI
- OpenHands integration is functional

### Baseline Metrics (to be captured on prod)
- Health: `curl -w "%{time_total}\n" http://localhost:8080/api/health`
- Chat list load time
- First token latency (warm conversation)

## Next Steps (from Hybrid Plan)
1. Phase 0 complete (this document + branch)
2. Phase 1.1: WAL + AUTH_SECRET + safe_abs + shared client
3. Phase 1.2: Fast chat loading endpoints

**Status:** Phase 0 — IN PROGRESS
