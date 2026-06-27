"""Step 10.8 — key rotation endpoint."""

from core.database import get_active_key
from core import server


async def _ok_validate(provider):
    return {"ok": True, "latencyMs": 1, "model": provider.get("model")}


async def _bad_validate(provider):
    return {"ok": False, "status": 401, "error": "bad key"}


def test_rotate_requires_new_secret(client):
    r = client.post("/api/keys/rotate", json={})
    assert r.status_code == 400


def test_rotate_replaces_secret_after_successful_validation(client, monkeypatch):
    before = get_active_key(include_secret=True)
    assert before and before["id"]
    monkeypatch.setattr(server.provs, "validate_key", _ok_validate)

    r = client.post("/api/keys/rotate", json={"apiKey": "new-test-secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["activeKeyId"] == before["id"]

    after = get_active_key(include_secret=True)
    assert after["id"] == before["id"]
    assert after["apiKey"] == "new-test-secret"


def test_rotate_does_not_replace_secret_if_validation_fails(client, monkeypatch):
    monkeypatch.setattr(server.provs, "validate_key", _ok_validate)
    client.post("/api/keys/rotate", json={"apiKey": "known-good-secret"})
    monkeypatch.setattr(server.provs, "validate_key", _bad_validate)

    r = client.post("/api/keys/rotate", json={"apiKey": "bad-secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["stage"] == "validate"

    after = get_active_key(include_secret=True)
    assert after["apiKey"] == "known-good-secret"
