"""Step 10.4 — OpenAPI schema is generated and lists our API routes."""


def test_openapi_json_served(client):
    r = client.get("/openapi.json")
    assert r.status_code == 200
    spec = r.json()
    assert spec.get("openapi", "").startswith("3.")
    paths = spec.get("paths", {})
    # A representative sample of real (non-stub) endpoints must be documented.
    for p in ("/api/health", "/api/health/deep", "/api/agent/recipes",
              "/api/agent/control-plane", "/api/memory/facts"):
        assert p in paths, f"{p} missing from OpenAPI spec"


def test_docs_ui_served(client):
    r = client.get("/docs")
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
