import asyncio
import base64

from core import admin_data, web_image


def test_gateway_status_uses_async_wrappers(monkeypatch):
    calls = []

    async def fake_ping():
        calls.append("ping")

    def fake_disk(path="/"):
        calls.append(f"disk:{path}")
        return 42.0

    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(admin_data, "_sqlite_ping", fake_ping)
    monkeypatch.setattr(admin_data, "_disk_free_gb", fake_disk)
    monkeypatch.setattr(admin_data._httpx if hasattr(admin_data, "_httpx") else __import__("httpx"), "AsyncClient", FakeClient)

    async def run():
        data = await admin_data.gateway_status("http://openhands")
        assert data["overall"] == "up"
        assert calls == ["ping", "disk:/"]

    asyncio.run(run())


def test_save_generated_image_helper(tmp_path):
    target = tmp_path / "nested" / "generated.png"
    web_image._save_generated_image(str(target), base64.b64decode(base64.b64encode(b"png-bytes")))
    assert target.read_bytes() == b"png-bytes"
