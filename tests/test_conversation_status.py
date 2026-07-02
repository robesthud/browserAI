"""Sonnet review #8 — conversation_status must distinguish 'gone' from
transient 'unknown', so a blip never drops the mapping (history loss)."""
import asyncio
import json

import core.conversations as conv


class _Resp:
    def __init__(self, status_code, body=None, raises=False):
        self.status_code = status_code
        self._body = body
        self._raises = raises
    def json(self):
        if self._raises:
            raise ValueError("bad json")
        return self._body


class _Client:
    """Minimal async httpx-like stub returning a canned response (or raising)."""
    def __init__(self, resp=None, exc=None):
        self._resp = resp
        self._exc = exc
    async def get(self, url, timeout=None):
        if self._exc:
            raise self._exc
        return self._resp


def _status(resp=None, exc=None):
    client = _Client(resp=resp, exc=exc)
    return asyncio.run(conv.conversation_status(client, "http://oh", "cid1"))


def test_alive_on_valid_conversation():
    assert _status(_Resp(200, {"conversation_id": "cid1", "conversation_status": "RUNNING"})) == "alive"


def test_gone_on_404():
    assert _status(_Resp(404)) == "gone"


def test_gone_on_null_body():
    assert _status(_Resp(200, None)) == "gone"


def test_gone_on_deleted_status():
    assert _status(_Resp(200, {"conversation_id": "cid1", "conversation_status": "DELETED"})) == "gone"


def test_unknown_on_500():
    # transient: OpenHands overloaded/restarting — must NOT be 'gone'
    assert _status(_Resp(503)) == "unknown"


def test_unknown_on_exception():
    # connection reset / timeout — must NOT be 'gone'
    assert _status(exc=ConnectionResetError("reset")) == "unknown"


def test_alive_wrapper_treats_unknown_as_alive():
    # back-compat boolean wrapper: transient must not read as dead
    client = _Client(resp=_Resp(503))
    assert asyncio.run(conv.conversation_alive(client, "http://oh", "cid1")) is True


def test_alive_wrapper_false_only_on_gone():
    client = _Client(resp=_Resp(404))
    assert asyncio.run(conv.conversation_alive(client, "http://oh", "cid1")) is False
