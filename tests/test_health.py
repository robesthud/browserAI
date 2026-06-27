"""Step 10.3/10.5 — health endpoints."""


def test_shallow_health_ok(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    data = r.json()
    # The UI keys off data.ok to decide online/offline — must stay truthy.
    assert data["ok"] is True
    assert data["engine"] == "openhands"


def test_deep_health_shape(client):
    r = client.get("/api/health/deep")
    # OpenHands is unreachable in tests, so we expect 503 + degraded, but the
    # structured payload and individual checks must still be present.
    assert r.status_code in (200, 503)
    data = r.json()
    assert "checks" in data and isinstance(data["checks"], list)
    names = {c["name"] for c in data["checks"]}
    assert {"database", "openhands", "llm_key", "disk"} <= names
    db_check = next(c for c in data["checks"] if c["name"] == "database")
    assert db_check["ok"] is True  # temp sqlite is always reachable


def test_agent_health(client):
    r = client.get("/api/agent/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_trace_id_header_present(client):
    # Step 10.6 — every response should carry a correlation id.
    r = client.get("/api/health")
    assert r.headers.get("X-Trace-Id")
