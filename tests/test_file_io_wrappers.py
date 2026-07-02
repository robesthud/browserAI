import asyncio
import json
import zipfile
from pathlib import Path

from core import server


def test_workspace_download_payload_file_and_zip(tmp_path):
    file_path = tmp_path / "hello.txt"
    file_path.write_text("hello", encoding="utf-8")
    content, media, filename = server._workspace_download_payload(file_path)
    assert content == b"hello"
    assert media.startswith("text/")
    assert filename == "hello.txt"

    folder = tmp_path / "folder"
    folder.mkdir()
    (folder / "a.txt").write_text("alpha", encoding="utf-8")
    (folder / "nested").mkdir()
    (folder / "nested" / "b.txt").write_text("beta", encoding="utf-8")
    content, media, filename = server._workspace_download_payload(folder)
    assert media == "application/zip"
    assert filename == "folder.zip"
    zpath = tmp_path / "out.zip"
    zpath.write_bytes(content)
    with zipfile.ZipFile(zpath) as z:
        assert sorted(z.namelist()) == ["a.txt", "nested/b.txt"]


def test_workspace_download_payload_async_wrapper(tmp_path):
    folder = tmp_path / "async-folder"
    folder.mkdir()
    (folder / "a.txt").write_text("alpha", encoding="utf-8")

    async def run():
        content, media, filename = await server._aworkspace_download_payload(folder)
        assert media == "application/zip"
        assert filename == "async-folder.zip"
        assert content.startswith(b"PK")

    asyncio.run(run())


def test_mcp_async_wrappers_roundtrip(tmp_path, monkeypatch):
    cfg = tmp_path / "mcp_config.json"
    monkeypatch.setattr(server, "_MCP_CONFIG_PATH", str(cfg))

    async def run():
        assert await server._amcp_load() == {"servers": {}}
        out = await server._amcp_upsert("pytest", {"enabled": True, "command": "echo"})
        assert out["servers"]["pytest"]["command"] == "echo"
        raw = json.loads(cfg.read_text(encoding="utf-8"))
        assert raw["servers"]["pytest"]["name"] == "pytest"
        deleted = await server._amcp_delete("pytest")
        assert deleted["removed"] is True
        assert (await server._amcp_load())["servers"] == {}

    asyncio.run(run())
