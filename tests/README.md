# BrowserAI tests (Step 10.3)

Fast, hermetic unit/route tests. They use an isolated temp SQLite DB and never
contact OpenHands or prod data.

## Run

```bash
pip install pytest 'httpx<0.28'
cd /opt/browserai
python3 -m pytest -q
```

| File | Covers |
|---|---|
| `test_health.py` | `/api/health`, `/api/health/deep` (10.5), `X-Trace-Id` header (10.6) |
| `test_agent_state.py` | Step 6 schema CRUD + recipes/workflows/control-plane/answer endpoints |
| `test_openapi.py` | OpenAPI schema + `/docs` served (10.4) |
| `test_memory.py` | heuristic fact extractor (Step 7) |

## Integration (opt-in)

`tests/integration/` is ignored by default (`pytest.ini`). Run against a live
OpenHands:

```bash
OPENHANDS_AGENT_SERVER=http://127.0.0.1:18000 \
    python3 -m pytest tests/integration -q -o addopts=''
```
