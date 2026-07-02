# Sonnet 5 review — verified against real code (2026-07-02)

I checked every claim against the actual tree (HEAD `6b397b7`). Verdict:
**the review is unusually accurate** — line numbers correct, logic correctly
understood, no fabricated APIs. Below: what's confirmed, severity, and my
recommended action order.

## Confirmed findings

| # | Sonnet claim | Verified? | Notes |
|---|--------------|:---------:|-------|
| 1 | Cursor double-writer: `conversations.py:224` writes `last_event_id` unconditionally on every reused turn, partially reopening Bug 2.2 | ✅ TRUE | Also a 3rd writer at `server.py:993` (import path). `conversations.py:224` bumps cursor to OH's latest event regardless of whether the client saw the tail. **Highest severity.** |
| 2 | `agent_answer` posts to OH `/message` with no per-chat lock | ✅ TRUE | `server.py:~2389` bare `httpx.AsyncClient()`, no `_stream_lock_for`. Can interleave with a concurrent turn. |
| 3 | ask_user → status `done` → Stop is a no-op on resumed turn; frontend never re-opens stream | ✅ TRUE | `server.py:1896-97` sets done on ask_user; `2163` persists "done"; my own 4.2 guard (`2293`) then treats resumed work as `already_finished`. Frontend `useChats.js:1281` only flips `answered:true`. **This interacts badly with my 3.3/4.2 fixes — deepest issue.** |
| 4 | Per-chat isolation is a prompt string, not an OS boundary; shared `/workspace` mount | ✅ TRUE | `isolation.py:desired_sandbox_volumes` mounts one root; only `_chat_workspace_instruction` scopes it. Single-tenant lowers impact but browser-tool + prompt-injection is a real cross-chat vector. |
| 5 | `init_*_schema()` runs on every hot-path call (open conn + PRAGMA + commit) | ✅ TRUE | Every function in agent_state/conversations calls it. Real overhead under SSE polling. |
| 6 | `upsert_run` read-then-write across implicit txns, no `BEGIN IMMEDIATE` | ✅ TRUE | `agent_state.py:58-78`. Concurrent upserts can clobber with stale derived values. |
| 7 | model-list merge "can only grow, never shrink" | ✅ TRUE (worse) | `database.py:236-257` — both branches of the `if len<...` assign `merged`; **dead branch**, always merges. Intentional prune silently reappears. |
| 8 | `conversation_alive` drops mapping on transient 5xx/exception | ✅ TRUE | `conversations.py:125-145` returns False on `>=500` AND any exception → caller `drop_mapping` + new conversation. OH restart = lost history. |
| 9 | `_locked_stream_chat` 0.25s acquire timeout surfaces as "busy" before idempotency check | ✅ TRUE | `server.py:~2138`. Duplicate submit of same turn_id should be no-op success, not busy error. |
| 10 | `ensure_columns` swallows ALTER failures silently (`except: pass`, no log) | ✅ TRUE | `migrations.py:~133`. A genuinely failed migration is invisible — reproduces the original outage's root cause. |

## Severity ranking (my call, for single-tenant "just works" goal)

**Tier 1 — correctness / data-loss, fix now (low risk, no schema change):**
- **#1** cursor double-writer (2-line delete) — reopens Bug 2.2.
- **#3** ask_user → done → Stop no-op + no resume — interacts with my 4.2 fix.
- **#10** silent migration failure (add logging + health flag) — cheap, prevents future blind outage.
- **#7** model-list never shrinks (fix dead branch) — clear data bug.

**Tier 2 — correctness under concurrency (needs care/tests):**
- **#2** answer bypasses lock, **#6** upsert_run race, **#8** transient-error mapping drop, **#9** busy-vs-idempotency.

**Tier 3 — perf / hardening:**
- **#5** schema-init hot path (move to startup), **#4** workspace isolation (document or per-chat mount).

## Action order (all reversible, deployable one-at-a-time, no migration window)
1. #1 delete the peek-and-write in `conversations.py:224` (read-only there).
2. #10 log ALTER failures + assert `EXPECTED` columns post-migrate.
3. #7 trust caller's model list unless empty.
4. #3 introduce `awaiting_input` run status distinct from `done`; wire Stop/resume.
5. #8 distinguish confirmed-gone (404/DELETED) from transport error (5xx/exc).
6. #2 route answer relay through `_stream_lock_for(chat_id)`.
7. #6 `BEGIN IMMEDIATE` (or SQL COALESCE) in `upsert_run`.
8. #5 schema init once at startup; drop from hot path.
9. #9 on lock timeout, treat matching turn_id as no-op success.
10. #4 per-chat sandbox mount OR drop the "isolation" naming.

Each step: fix → Mock-OH regression test → deploy → self-test → push.
