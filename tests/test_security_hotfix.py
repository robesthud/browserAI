"""Regression tests for the P0 security hotfix.

Anonymous users may only reach explicitly-public endpoints. Sensitive routes
must reject before doing any state mutation, LLM spend, workspace write, SSRF
or operator action.
"""
import hashlib
import hmac
import json


def test_sensitive_routes_require_auth(client):
    cases = [
        ("GET", "/api/settings", None),
        ("GET", "/api/keys", None),
        ("POST", "/api/keys/rotate", {}),
        ("GET", "/api/models", None),
        ("POST", "/api/validate", {}),
        ("POST", "/api/agent/chat", {"prompt": "hi"}),
        ("POST", "/api/workspace/file", {"path": "x.txt", "content": "x"}),
        ("POST", "/api/workspace/upload-url", {"url": "https://github.com/robesthud/browserai"}),
        ("POST", "/api/checkpoints", {"chatId": "c"}),
        ("POST", "/api/mcp/restart", {}),
        ("POST", "/api/approval/policy", {"policy": {"bash": "auto"}}),
        ("GET", "/api/agent/control-plane", None),
    ]
    for method, path, body in cases:
        r = client.request(method, path, json=body) if body is not None else client.request(method, path)
        assert r.status_code == 401, f"{method} {path} returned {r.status_code}: {r.text}"
        assert r.json()["detail"] == "auth_required"


def test_public_health_stays_public(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_provider_ssrf_helpers_block_private_urls():
    from core.providers import _is_private_base_url

    blocked = [
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://10.0.0.1",
        "http://172.16.0.1",
        "http://192.168.1.1",
        "http://169.254.169.254/latest/meta-data",
        "http://metadata.google.internal/computeMetadata/v1",
        "file:///etc/passwd",
        "not-a-url",
    ]
    for url in blocked:
        assert _is_private_base_url(url) is True


def test_server_url_and_github_host_guards():
    from core.server import _is_private_url, _is_github_host

    assert _is_private_url("127.0.0.1") is True
    assert _is_private_url("localhost") is True
    assert _is_private_url("169.254.169.254") is True
    assert _is_private_url("") is True

    assert _is_github_host("github.com") is True
    assert _is_github_host("github.com:443") is True
    assert _is_github_host("api.github.com") is True
    assert _is_github_host("evil-github.com") is False
    assert _is_github_host("github.com.evil.com") is False


def test_github_webhook_requires_secret_or_signature(client, monkeypatch):
    import core.server as server

    monkeypatch.setenv("BROWSERAI_REQUIRE_GITHUB_WEBHOOK_SECRET", "1")
    monkeypatch.delenv("GITHUB_WEBHOOK_SECRET", raising=False)
    # Ensure no DB-stored secret from other tests affects this case.
    server._kv_set("github_webhook", {})
    r = client.post("/api/webhooks/github", json={"repository": {"full_name": "r/p"}})
    assert r.status_code == 401
    assert r.json()["detail"] == "webhook_secret_required"


def test_github_webhook_hmac(client, monkeypatch):
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "topsecret")
    payload = {"repository": {"full_name": "robesthud/browserai"}}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    bad = client.post(
        "/api/webhooks/github",
        content=raw,
        headers={"X-Hub-Signature-256": "sha256=bad", "X-GitHub-Event": "push"},
    )
    assert bad.status_code == 401

    sig = "sha256=" + hmac.new(b"topsecret", raw, hashlib.sha256).hexdigest()
    ok = client.post(
        "/api/webhooks/github",
        content=raw,
        headers={"X-Hub-Signature-256": sig, "X-GitHub-Event": "push"},
    )
    assert ok.status_code == 200
    assert ok.json()["ok"] is True
