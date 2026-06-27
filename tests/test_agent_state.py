"""Step 6 / 10.3 — agent_state schema + interactive-flow endpoints."""
import uuid

from core.agent_state import (
    upsert_run, set_run_status, list_runs, get_run,
    create_question, get_question, list_questions, answer_question,
)


def test_run_lifecycle():
    chat = f"chat-{uuid.uuid4().hex[:6]}"
    upsert_run(chat, "conv-1", "user-1", "running", last_prompt="hi", last_event_id=3)
    run = get_run(chat)
    assert run and run["status"] == "running" and run["conversation_id"] == "conv-1"
    set_run_status(chat, "done")
    assert get_run(chat)["status"] == "done"
    assert any(r["chat_id"] == chat for r in list_runs("user-1"))


def test_question_lifecycle():
    chat = f"chat-{uuid.uuid4().hex[:6]}"
    qid = f"q-{uuid.uuid4().hex[:6]}"
    create_question(qid, chat, "conv-2", "user-1", "Какой цвет?",
                    [{"id": "a", "label": "красный"}])
    q = get_question(qid)
    assert q and q["question"] == "Какой цвет?"
    assert qid in {x["id"] for x in list_questions(chat_id=chat)}
    saved = answer_question(qid, {"answer": "красный", "answeredBy": "user-1"})
    assert saved is not None


def test_recipes_endpoint(client):
    r = client.get("/api/agent/recipes")
    assert r.status_code == 200
    items = r.json()["items"]
    assert any(i["id"] == "repo_audit" for i in items)


def test_workflows_endpoint(client):
    r = client.get("/api/agent/workflows")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_control_plane_get(client):
    r = client.get("/api/agent/control-plane")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and "runs" in body


def test_answer_requires_question_id(client):
    r = client.post("/api/agent/answer", json={})
    assert r.status_code == 400
