import asyncio

from core import memory_kb as mem
from core.database import get_conn


def _drop_memory_tables():
    conn = get_conn()
    try:
        for table in [
            "semantic_memory_fts",
            "kb_chunks",
            "kb_documents",
            "project_memory",
            "semantic_memory",
            "user_facts",
        ]:
            try:
                conn.execute(f"DROP TABLE IF EXISTS {table}")
            except Exception:
                pass
        conn.commit()
    finally:
        conn.close()
    mem._schema_ready = False


def test_memory_schema_init_creates_all_tables():
    _drop_memory_tables()
    mem.init_memory_schema(force=True)
    conn = get_conn()
    try:
        names = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','virtual')").fetchall()}
    finally:
        conn.close()
    assert {"user_facts", "semantic_memory", "project_memory", "kb_documents", "kb_chunks"} <= names


def test_memory_and_kb_work_on_fresh_schema():
    _drop_memory_tables()
    fact = mem.upsert_fact("u-schema", "name", "Ivan")
    assert fact["key"] == "name"
    assert mem.list_facts("u-schema")[0]["value"] == "Ivan"

    pm = mem.upsert_project_memory("u-schema", "chat-1", "repo", "browserai")
    assert pm["key"] == "repo"
    assert mem.list_project_memory("u-schema", "chat-1")[0]["value"] == "browserai"

    doc = mem.kb_add("u-schema", "Doc", "alpha beta\n\ngamma delta", "unit")
    assert doc["chunks"] == 2
    hits = mem.kb_search("u-schema", "alpha", limit=5)
    assert hits and hits[0]["title"] == "Doc"
    assert mem.kb_delete("u-schema", doc["id"]) is True


def test_memory_async_wrappers():
    _drop_memory_tables()

    async def run():
        await mem.aupsert_fact("u-async", "pref", "dark")
        assert (await mem.alist_facts("u-async"))[0]["value"] == "dark"
        await mem.aupsert_project_memory("u-async", "chat", "stack", "py")
        assert (await mem.alist_project_memory("u-async", "chat"))[0]["key"] == "stack"
        doc = await mem.akb_add("u-async", "Async Doc", "token one", "unit")
        assert (await mem.akb_search("u-async", "token", 5))[0]["doc_id"] == doc["id"]
        assert await mem.akb_delete("u-async", doc["id"])

    asyncio.run(run())
