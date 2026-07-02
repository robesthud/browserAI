"""Self-healing schema migrations for BrowserAI.

The historical pattern across the codebase is `CREATE TABLE IF NOT EXISTS`.
That is great for fresh databases but does NOTHING when a table already exists
with an older shape — which is exactly how the `agent_runs.last_turn_id` outage
happened: the column was added to the code, but live databases never got it.

This module centralises the fix. Each subsystem declares the columns it expects
for its tables; on startup we compare against the live schema (PRAGMA
table_info) and `ALTER TABLE ADD COLUMN` anything missing. It is:

  * idempotent     — running it repeatedly is a no-op once the schema matches;
  * non-destructive — only ADDs columns, never drops or rewrites;
  * crash-safe      — a failed migration is swallowed, never blocks startup.

Constraints (SQLite ALTER TABLE ADD COLUMN limitations):
  * column DEFAULT must be a constant (or omitted);
  * cannot add PRIMARY KEY / UNIQUE columns this way — those must be in the
    original CREATE TABLE.

Usage:
    from core.migrations import ensure_columns, EXPECTED

    # after your CREATE TABLE IF NOT EXISTS statements, on the same connection:
    ensure_columns(conn, "agent_runs")          # one table
    ensure_columns(conn)                          # every registered table
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

log = logging.getLogger("browserai.migrations")


# Registry: table -> {column_name: full SQL column definition}.
# Subsystems extend this via register_table() or by editing here.
EXPECTED: Dict[str, Dict[str, str]] = {
    "agent_runs": {
        "chat_id": "chat_id TEXT",
        "conversation_id": "conversation_id TEXT",
        "user_id": "user_id TEXT",
        "status": "status TEXT NOT NULL DEFAULT 'idle'",
        "last_prompt": "last_prompt TEXT NOT NULL DEFAULT ''",
        "last_error": "last_error TEXT NOT NULL DEFAULT ''",
        "last_event_id": "last_event_id INTEGER NOT NULL DEFAULT -1",
        "last_turn_id": "last_turn_id TEXT NOT NULL DEFAULT ''",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
    },
    "agent_questions": {
        "id": "id TEXT",
        "chat_id": "chat_id TEXT",
        "conversation_id": "conversation_id TEXT",
        "user_id": "user_id TEXT",
        "question": "question TEXT",
        "options_json": "options_json TEXT NOT NULL DEFAULT '[]'",
        "status": "status TEXT NOT NULL DEFAULT 'pending'",
        "answer_json": "answer_json TEXT",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
        "answered_at": "answered_at INTEGER",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
    },
    # ── auth subsystem (core/auth.py) ────────────────────────────────────────
    # PRIMARY KEY / UNIQUE / FOREIGN KEY columns are intentionally listed
    # WITHOUT those constraints: ALTER TABLE ADD COLUMN cannot add them, and we
    # only ever ADD a missing column here. Such constraints live in CREATE TABLE.
    "users": {
        "id": "id TEXT",
        "email": "email TEXT",
        "password_hash": "password_hash TEXT NOT NULL DEFAULT ''",
        "role": "role TEXT NOT NULL DEFAULT 'user'",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
    },
    "sessions": {
        "id": "id TEXT",
        "user_id": "user_id TEXT",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
        "last_seen_at": "last_seen_at INTEGER NOT NULL DEFAULT 0",
        "expires_at": "expires_at INTEGER NOT NULL DEFAULT 0",
        "ip": "ip TEXT",
        "user_agent": "user_agent TEXT",
    },
    "cloud_state": {
        "user_id": "user_id TEXT",
        "settings": "settings TEXT NOT NULL DEFAULT '{}'",
        "chats": "chats TEXT NOT NULL DEFAULT '[]'",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
    },
    # ── conversations subsystem (core/conversations.py) ──────────────────────
    "chat_conversations": {
        "chat_id": "chat_id TEXT",
        "conversation_id": "conversation_id TEXT",
        "user_id": "user_id TEXT",
        "last_event_id": "last_event_id INTEGER NOT NULL DEFAULT -1",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
    },
}


def register_table(table: str, columns: Dict[str, str]) -> None:
    """Register/extend expected columns for a table (idempotent)."""
    EXPECTED.setdefault(table, {}).update(columns)


def ensure_columns(conn, table: Optional[str] = None) -> int:
    """Add any expected columns missing from the live DB.

    If `table` is given, migrate just that table; otherwise migrate every
    registered table. Returns the number of columns added (useful for logging).
    Safe to call on any connection that has the relevant tables.
    """
    targets = [table] if table else list(EXPECTED.keys())
    added = 0
    for tbl in targets:
        columns = EXPECTED.get(tbl)
        if not columns:
            continue
        try:
            existing = {
                row[1] for row in conn.execute(f"PRAGMA table_info({tbl})").fetchall()
            }
        except Exception:
            # Table not present yet — its CREATE TABLE will build the full shape.
            continue
        if not existing:
            continue
        for name, ddl in columns.items():
            if name not in existing:
                try:
                    conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {ddl}")
                    added += 1
                    log.info("migration: added column %s.%s", tbl, name)
                except Exception as e:
                    # Best-effort: never crash startup over a migration — but a
                    # silently-swallowed failure is exactly how the original
                    # agent_runs outage stayed invisible (Sonnet review #10).
                    # Log loudly so a real failure (disk full, perms, bad DDL)
                    # is discoverable instead of surfacing later as a 500.
                    log.error("migration FAILED for %s.%s (%s): %s", tbl, name, ddl, e)
    return added


def missing_columns(conn) -> List[str]:
    """Return "table.column" for every EXPECTED column absent from the live DB.

    Used as a post-migration health assertion: after ensure_columns() runs, this
    should be empty. A non-empty result means a migration failed (see #10) and
    routes touching those columns will 500 — surface it via /api/health.
    """
    gaps: List[str] = []
    for tbl, columns in EXPECTED.items():
        try:
            existing = {
                row[1] for row in conn.execute(f"PRAGMA table_info({tbl})").fetchall()
            }
        except Exception:
            continue
        if not existing:
            continue  # table not created yet; not a drift
        for name in columns:
            if name not in existing:
                gaps.append(f"{tbl}.{name}")
    return gaps
