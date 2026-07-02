import asyncio

from core import agent_state as st
from core import conversations as conv
from core import database as db


def test_database_async_wrappers_match_sync_api():
    async def run():
        key = {
            "id": "async-wrapper-key",
            "name": "Async Wrapper",
            "baseUrl": "https://example.com/v1",
            "apiKey": "secret-value",
            "model": "test-model",
            "availableModels": ["test-model"],
        }
        keys = await db.aupsert_key(key)
        assert any(k["id"] == key["id"] for k in keys)

        stored = await db.aget_key(key["id"], include_secret=True)
        assert stored and stored["apiKey"] == "secret-value"

        params = await db.aset_params({"temperature": 0.2, "maxSteps": 7})
        assert params["temperature"] == 0.2
        assert (await db.aget_params())["maxSteps"] == 7

        listed = await db.alist_keys()
        assert any(k["id"] == key["id"] for k in listed)

    asyncio.run(run())


def test_agent_state_async_wrappers_match_sync_api():
    async def run():
        st.init_agent_state_schema(force=True)
        await st.aupsert_run("async-chat", "cid-1", "user-1", "running", last_prompt="hi", last_event_id=3, last_turn_id="turn-1")
        run_row = await st.aget_run("async-chat")
        assert run_row and run_row["status"] == "running" and run_row["last_event_id"] == 3

        await st.aset_run_status("async-chat", "done")
        runs = await st.alist_runs("user-1")
        assert runs and runs[0]["status"] == "done"

        q = await st.acreate_question("async-q", "async-chat", "cid-1", "user-1", "Pick?", [{"id": "a", "label": "A"}])
        assert q["status"] == "pending"
        answered = await st.aanswer_question("async-q", {"selected": ["a"]})
        assert answered and answered["status"] == "answered"
        questions = await st.alist_questions(chat_id="async-chat")
        assert any(item["id"] == "async-q" for item in questions)

    asyncio.run(run())


def test_conversation_async_wrappers_match_sync_api():
    async def run():
        conv.init_conversations_schema(force=True)
        await conv.aupsert_mapping("async-chat-map", "cid-map", "user-1")
        mapping = await conv.aget_mapping("async-chat-map")
        assert mapping and mapping["conversation_id"] == "cid-map"

        await conv.aupdate_last_event("async-chat-map", 42)
        mapping = await conv.aget_mapping("async-chat-map")
        assert mapping and mapping["last_event_id"] == 42

        await conv.adrop_mapping("async-chat-map")
        assert await conv.aget_mapping("async-chat-map") is None

    asyncio.run(run())
