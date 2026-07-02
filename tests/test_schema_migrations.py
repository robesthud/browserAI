import sqlite3

from core.migrations import applied_migrations, migration_status, run_startup_migrations


def _minimal_existing_db():
    c = sqlite3.connect(":memory:")
    c.executescript(
        """
        -- Deliberately legacy/minimal shapes: migration 2 must add the
        -- columns referenced by its indexes before creating those indexes.
        CREATE TABLE keys (
            id TEXT PRIMARY KEY,
            is_active INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE checkpoints (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            step INTEGER NOT NULL
        );
        CREATE TABLE agent_tool_ledger (
            id TEXT PRIMARY KEY,
            chat_id TEXT,
            conversation_id TEXT
        );
        CREATE TABLE push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            user_id TEXT
        );
        """
    )
    return c


def test_startup_migrations_create_ledger_and_are_idempotent():
    c = _minimal_existing_db()
    first = run_startup_migrations(c)
    c.commit()
    assert first == [1, 2]
    rows = applied_migrations(c)
    assert [r["name"] for r in rows] == ["core_expected_columns", "operational_indexes"]

    second = run_startup_migrations(c)
    c.commit()
    assert second == []
    assert applied_migrations(c) == rows


def test_migration_status_reports_pending_before_run():
    c = sqlite3.connect(":memory:")
    status = migration_status(c)
    assert status["applied"] == 0
    assert status["expected"] >= 2
    assert status["pending"]


def test_operational_indexes_exist_after_migration():
    c = _minimal_existing_db()
    run_startup_migrations(c)
    indexes = {r[1] for r in c.execute("PRAGMA index_list(agent_tool_ledger)").fetchall()}
    assert "agent_tool_ledger_chat_idx" in indexes
    assert "agent_tool_ledger_conversation_idx" in indexes
    ledger_cols = {r[1] for r in c.execute("PRAGMA table_info(agent_tool_ledger)").fetchall()}
    assert {"created_at", "event", "data_json"} <= ledger_cols
    push_cols = {r[1] for r in c.execute("PRAGMA table_info(push_subscriptions)").fetchall()}
    assert {"created_at", "updated_at", "data_json"} <= push_cols
