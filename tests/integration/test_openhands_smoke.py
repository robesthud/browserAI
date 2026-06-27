"""Step 10.3 — opt-in smoke test against a LIVE OpenHands backend.

Skipped by default (pytest.ini ignores tests/integration). Run explicitly with
a reachable OpenHands, e.g. on the server:

    OPENHANDS_AGENT_SERVER=http://127.0.0.1:18000 \
        python3 -m pytest tests/integration -q -o addopts=''
"""
import os

import httpx
import pytest

OH = os.environ.get("OPENHANDS_AGENT_SERVER", "http://127.0.0.1:18000")


def _reachable(url: str) -> bool:
    try:
        httpx.get(f"{url}/api/options/models", timeout=3.0)
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _reachable(OH), reason="OpenHands not reachable")
def test_openhands_options_models():
    r = httpx.get(f"{OH}/api/options/models", timeout=10.0)
    assert r.status_code < 500
