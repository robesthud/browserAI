"""Sonnet review #4 — the file-API boundary that IS enforced.

Per-chat folders are organization, not an OS trust boundary (documented in
core/isolation.py). But the HTTP file APIs MUST stay confined to the workspace
root via _safe_abs(): reject '..' escapes and path traversal. These tests lock
that guarantee in so a refactor can't silently open a traversal hole.
"""
import os
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from core.server import _safe_abs, _safe_rel, _WORKSPACE_ROOT


def test_safe_rel_leading_slash_becomes_contained_relative():
    # An absolute-looking path is treated as workspace-relative (contained),
    # NOT an escape: '/etc/passwd' -> 'etc/passwd' under the root.
    assert _safe_rel("/etc/passwd") == "etc/passwd"
    assert not _safe_rel("/etc/passwd").startswith("/")


def test_safe_rel_rejects_parent_traversal():
    # '..' traversal is rejected outright at the _safe_rel layer.
    with pytest.raises(HTTPException) as ei:
        _safe_rel("../../etc/passwd")
    assert ei.value.status_code == 400


def test_safe_abs_rejects_parent_escape():
    with pytest.raises(HTTPException) as ei:
        _safe_abs("../../../etc/passwd")
    assert ei.value.status_code == 400


def test_safe_abs_absolute_path_stays_contained():
    # '/etc/shadow' -> contained under workspace root, never the real /etc.
    p = _safe_abs("/etc/shadow")
    root = _WORKSPACE_ROOT.resolve()
    assert root in p.parents and str(p).endswith("etc/shadow")


def test_safe_abs_allows_normal_relative_path():
    p = _safe_abs("chats/abc/file.txt")
    root = _WORKSPACE_ROOT.resolve()
    assert root == p or root in p.parents


def test_safe_abs_rejects_symlink_escape(tmp_path, monkeypatch):
    # Build a fake workspace with a symlink pointing outside it
    ws = tmp_path / "ws"
    ws.mkdir()
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "s.txt").write_text("top secret")
    link = ws / "escape"
    os.symlink(outside, link)
    # point _safe_abs at this ws via base=
    with pytest.raises(HTTPException):
        _safe_abs("escape/s.txt", base=ws)
