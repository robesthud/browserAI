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
import time
from typing import Callable, Dict, List, Optional, Sequence, Tuple

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
    "chat_conversations": {
        "chat_id": "chat_id TEXT",
        "conversation_id": "conversation_id TEXT",
        "user_id": "user_id TEXT",
        "last_event_id": "last_event_id INTEGER NOT NULL DEFAULT -1",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
    },
    "keys": {
        "id": "id TEXT",
        "name": "name TEXT NOT NULL DEFAULT ''",
        "base_url": "base_url TEXT NOT NULL DEFAULT ''",
        "api_key": "api_key TEXT NOT NULL DEFAULT ''",
        "model": "model TEXT NOT NULL DEFAULT ''",
        "available_models": "available_models TEXT NOT NULL DEFAULT '[]'",
        "is_active": "is_active INTEGER NOT NULL DEFAULT 0",
        "enc": "enc INTEGER NOT NULL DEFAULT 0",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
        "auth_type": "auth_type TEXT NOT NULL DEFAULT 'bearer'",
        "auth_header": "auth_header TEXT NOT NULL DEFAULT ''",
        "response_path": "response_path TEXT NOT NULL DEFAULT ''",
        "extra_headers": "extra_headers TEXT NOT NULL DEFAULT '{}'",
        "only_free": "only_free INTEGER NOT NULL DEFAULT 0",
    },
    "app_kv": {
        "key": "key TEXT",
        "value_json": "value_json TEXT NOT NULL DEFAULT '{}'",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
    },
    "push_subscriptions": {
        "endpoint": "endpoint TEXT",
        "user_id": "user_id TEXT",
        "data_json": "data_json TEXT NOT NULL DEFAULT '{}'",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
        "updated_at": "updated_at INTEGER NOT NULL DEFAULT 0",
    },
    "checkpoints": {
        "id": "id TEXT",
        "chat_id": "chat_id TEXT NOT NULL DEFAULT ''",
        "step": "step INTEGER NOT NULL DEFAULT 0",
        "label": "label TEXT NOT NULL DEFAULT ''",
        "files_json": "files_json TEXT NOT NULL DEFAULT '[]'",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
    },
    "agent_tool_ledger": {
        "id": "id TEXT",
        "chat_id": "chat_id TEXT",
        "conversation_id": "conversation_id TEXT",
        "user_id": "user_id TEXT",
        "event": "event TEXT NOT NULL DEFAULT ''",
        "tool_name": "tool_name TEXT",
        "step": "step INTEGER",
        "data_json": "data_json TEXT NOT NULL DEFAULT '{}'",
        "created_at": "created_at INTEGER NOT NULL DEFAULT 0",
    },
}

def register_table(table: str, columns: Dict[str, str]) -> None:
    """Register/extend expected columns for a table (idempotent)."""
    EXPECTED.setdefault(table, {}).update(columns)


# Monotonic migration ledger. These are deliberately small, additive and
# idempotent: every step may be run against an already-upgraded DB without
# changing data. The ledger gives production a durable record of *which* schema
# steps have completed, instead of relying only on scattered CREATE IF NOT EXISTS
# calls and PRAGMA drift checks.
Migration = Tuple[int, str, Callable[[object], None]]


def _create_schema_migrations(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id         INTEGER PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            applied_at INTEGER NOT NULL
        )
        """
    )


def _migration_core_columns(conn) -> None:
    ensure_columns(conn)


def _migration_operational_indexes(conn) -> None:
    # These operational tables historically lived in core/server.py and were
    # created lazily by endpoint helpers. Create their minimal current shape
    # here before adding indexes so startup migrations work on fresh DBs too.
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS app_kv (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          user_id TEXT,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          step INTEGER NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          files_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS agent_tool_ledger (
          id TEXT PRIMARY KEY,
          chat_id TEXT,
          conversation_id TEXT,
          user_id TEXT,
          event TEXT NOT NULL DEFAULT '',
          tool_name TEXT,
          step INTEGER,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    # Existing deployments may already have these lazily-created tables with an
    # older shape. CREATE TABLE IF NOT EXISTS will not add columns, so heal them
    # before creating indexes that reference created_at/updated_at.
    for table in ("keys", "app_kv", "push_subscriptions", "checkpoints", "agent_tool_ledger"):
        ensure_columns(conn, table)
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS keys_active_idx ON keys(is_active, updated_at DESC);
        CREATE INDEX IF NOT EXISTS checkpoints_chat_step_idx ON checkpoints(chat_id, step DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS agent_tool_ledger_chat_idx ON agent_tool_ledger(chat_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS agent_tool_ledger_conversation_idx ON agent_tool_ledger(conversation_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id, updated_at DESC);
        """
    )


MIGRATIONS: Sequence[Migration] = (
    (1, "core_expected_columns", _migration_core_columns),
    (2, "operational_indexes", _migration_operational_indexes),
)


def applied_migrations(conn) -> List[Dict[str, object]]:
    """Return applied migration records ordered by id."""
    _create_schema_migrations(conn)
    rows = conn.execute(
        "SELECT id, name, applied_at FROM schema_migrations ORDER BY id"
    ).fetchall()
    return [{"id": int(r[0]), "name": str(r[1]), "applied_at": int(r[2])} for r in rows]


def migration_status(conn) -> Dict[str, object]:
    """Compact status for health checks / diagnostics."""
    rows = applied_migrations(conn)
    latest = rows[-1] if rows else None
    expected_ids = [mid for mid, _name, _fn in MIGRATIONS]
    applied_ids = {int(r["id"]) for r in rows}
    pending = [mid for mid in expected_ids if mid not in applied_ids]
    return {
        "applied": len(rows),
        "latest": latest,
        "pending": pending,
        "expected": len(MIGRATIONS),
    }


def run_startup_migrations(conn) -> List[int]:
    """Apply pending startup migrations and record them in schema_migrations.

    Only successful migrations are inserted into the ledger. A failed migration
    is logged and re-raised so startup/deep-health can surface it instead of
    pretending the schema is current.
    """
    _create_schema_migrations(conn)
    applied_ids = {
        int(r[0]) for r in conn.execute("SELECT id FROM schema_migrations").fetchall()
    }
    newly_applied: List[int] = []
    for mid, name, fn in MIGRATIONS:
        if mid in applied_ids:
            continue
        try:
            fn(conn)
            conn.execute(
                "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
                (mid, name, int(time.time() * 1000)),
            )
            newly_applied.append(mid)
            log.info("schema migration applied: %s %s", mid, name)
        except Exception:
            log.exception("schema migration failed: %s %s", mid, name)
            raise
    return newly_applied

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
