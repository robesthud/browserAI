import asyncio
import io
import tarfile
import zipfile

import pytest
from fastapi import HTTPException

from core import server


def test_store_download_payload_plain_file(tmp_path):
    out = server._store_download_payload_sync(tmp_path, "hello.txt", b"hello")
    assert out == {"ok": True, "kind": "file", "path": "hello.txt", "size": 5}
    assert (tmp_path / "hello.txt").read_bytes() == b"hello"


def test_store_download_payload_zip_extracts_safely(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("dir/a.txt", "alpha")
    out = server._store_download_payload_sync(tmp_path, "archive.zip", buf.getvalue())
    assert out["kind"] == "zip"
    assert (tmp_path / "archive" / "dir" / "a.txt").read_text() == "alpha"


def test_store_download_payload_rejects_zip_path_traversal(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("../evil.txt", "nope")
    with pytest.raises(HTTPException) as e:
        server._store_download_payload_sync(tmp_path, "bad.zip", buf.getvalue())
    assert e.value.detail == "archive_contains_path_traversal"


def test_store_download_payload_rejects_tar_unsafe_member(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        t.addfile(info)
    with pytest.raises(HTTPException) as e:
        server._store_download_payload_sync(tmp_path, "bad.tar", buf.getvalue())
    assert e.value.detail == "archive_contains_unsafe_member"


def test_store_download_payload_async_wrapper(tmp_path):
    async def run():
        out = await server._astore_download_payload(tmp_path, "async.txt", b"async")
        assert out["kind"] == "file"
        assert (tmp_path / "async.txt").read_bytes() == b"async"

    asyncio.run(run())
