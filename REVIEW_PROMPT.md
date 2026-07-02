# Prompt for external model review (Sonnet 5 / GLM)

> Copy everything below the line into the model, attached to `browserAI.zip`.
> Ask each model the same thing; we compare answers and take the best ideas.

---

You are a senior staff engineer doing an architecture + code review of a
self-hosted AI agent product called **BrowserAI**. The full source is attached
as `browserAI.zip`. Read it before answering. Be concrete and cite real files,
functions, and line ranges — do not invent APIs or files.

## What BrowserAI is
A single-tenant, self-hosted "agent workbench": a web UI where a user chats with
an AI agent that can run tools (bash, file ops, browser) in a sandbox. It is
deployed as a **Docker Compose monolith**:
- `browserai` — FastAPI backend (Python, ~7,250 LOC across `core/`, 128 routes)
  + a Vite/React 19 SPA (~18,300 LOC, 58 components in `ui/src`). Served by one
  container behind nginx. Binds `127.0.0.1:8080`.
- `openhands` — vendored OpenHands agent server (`ghcr.io/all-hands-ai/openhands`),
  which the backend talks to over REST/WebSocket. Binds `127.0.0.1:18000`.
- ephemeral `openhands-runtime-*` containers — one per conversation, spawned by
  OpenHands via the mounted `/var/run/docker.sock`, where tools actually execute.

Key backend modules (`core/`): `server.py` (routes + agent stream loop),
`conversations.py` (chat↔OpenHands conversation mapping), `agent_state.py`
(runs/questions in SQLite), `auth.py`, `vault.py` (encrypted API keys),
`providers.py` (multi-LLM), `memory_kb.py`, `isolation.py` (per-chat workspace),
`migrations.py` (self-healing schema), `database.py`. State is SQLite (~55 tables).

## The core tension we want your judgment on
The system is a **three-layer hybrid**: BrowserAI keeps its OWN persistence and
orchestration (`agent_runs`, `chat_conversations`, questions, memory) *on top of*
OpenHands, which ALSO persists conversations/events and owns the runtime + real
isolation. A prior reviewer called this "the worst of both worlds": BrowserAI
duplicates state OpenHands already holds, and the seams between the layers are
where bugs live. We recently fixed 7 such seam bugs (event-cursor loss on broken
streams, a stream-lock TOCTOU, ask_user mid-stream races, an answer-relay format
mismatch, per-chat streaming state, stop-after-finish) — all now covered by a
stdlib "Mock OpenHands" integration harness (`tests/mock_openhands.py`).

## Our goal
Make BrowserAI **work correctly and predictably as a single monolith** — no
"dancing with a tambourine" (fragile manual fixes, layer desyncs, race conditions).
We are **single-tenant** (one owner/small team, not multi-user SaaS). We do NOT
want to rewrite from scratch; OpenHands gives us browser tooling, MCP, file
history, and error-recovery for free.

## What we need from you (be specific and prioritized)
1. **Architecture verdict.** Given single-tenant goals, is the three-layer hybrid
   worth keeping, or should we collapse layers? If collapse: exactly which
   BrowserAI-owned state/tables should become derived-from-OpenHands (or dropped),
   which must stay (auth, vault, billing, providers), and a safe migration order
   that never breaks a running prod. If keep: how to make the seams robust.
2. **Top 10 concrete risks** you find in the actual code (file:function:line),
   ranked by severity, each with a minimal fix. Prioritize correctness/races/
   data-loss over style.
3. **The monolith question.** Should `openhands` + runtime stay as separate
   containers, or is there a cleaner single-process/single-image design that keeps
   the OpenHands capabilities but removes a coordination layer? Trade-offs.
4. **Test strategy.** We have unit tests + a Mock-OpenHands integration harness.
   What are the highest-value tests still missing to prevent seam regressions?
5. **One "if I owned this" recommendation.** The single change you'd make first.

## Constraints / ground rules
- Cite real code. If you're unsure something exists, say so — don't fabricate.
- Prefer reversible, incremental steps deployable to a live single-tenant prod.
- Assume Docker Compose deploy, nginx in front (currently HTTP; HTTPS pending),
  fail2ban on, secrets in a root-only `.env`.
- Output format: (A) one-paragraph verdict, (B) the ranked risk table,
  (C) the layer-collapse plan OR seam-hardening plan, (D) missing tests,
  (E) the single first change. Keep it skimmable.

## Context you can trust (already verified on the running server)
- Backend/agent core is healthy; a `/api/agent/self-test` streams an LLM "pong"
  end-to-end through OpenHands + a runtime container.
- `agent_runs` had a missing-column outage previously; fixed via a self-healing
  migration module (`core/migrations.py`) now wired into agent_state/auth/
  conversations. Consider whether that pattern should cover all ~55 tables.
- The 7 fixed seam bugs each have a regression test; see
  `tests/integration/test_mock_openhands.py` and `test_ask_user_helpers.py`.

Give us your honest, senior-level take. We will run this same prompt against
multiple models and merge the best recommendations.
