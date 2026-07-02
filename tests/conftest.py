"""Shared pytest fixtures for BrowserAI.

We point the DB at a temp file BEFORE importing the app so every test runs
against an isolated SQLite database and never touches prod data. OpenHands is
never contacted by these tests — the cases here exercise the parts of the
monolith that don't require a live agent backend (health, schema/CRUD, memory,
static routing, OpenAPI). Integration tests against a real OH live under
tests/integration/ and are opt-in.
"""
import os
import tempfile

import pytest

# Isolate the DB before core.* imports read DB_PATH at module load.
_TMP_DB = os.path.join(tempfile.gettempdir(), "browserai_test.db")
os.environ["BROWSERAI_DB"] = _TMP_DB
os.environ["BROWSERAI_DATA_DIR"] = tempfile.gettempdir()
os.environ.setdefault("OPENHANDS_AGENT_SERVER", "http://127.0.0.1:9")  # unreachable on purpose
os.environ.setdefault("APP_URL", "http://localhost")


@pytest.fixture(scope="session", autouse=True)
def _fresh_db():
    # Start each session from a clean DB file.
    if os.path.exists(_TMP_DB):
        os.remove(_TMP_DB)
    from core.database import init_db
    from core.auth import init_auth_schema
    from core.conversations import init_conversations_schema
    from core.agent_state import init_agent_state_schema
    init_db()
    init_auth_schema()
    init_conversations_schema(force=True)
    init_agent_state_schema(force=True)
    # memory_kb relies on legacy tables that exist in prod but aren't created
    # by an init fn; create the minimal one the memory test needs.
    from core.database import get_conn
    conn = get_conn()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS user_facts (
              user_id    TEXT NOT NULL,
              key        TEXT NOT NULL,
              value      TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (user_id, key)
        )"""
    )
    conn.commit()
    conn.close()
    yield
    if os.path.exists(_TMP_DB):
        os.remove(_TMP_DB)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from core import server
    return TestClient(server.app)
