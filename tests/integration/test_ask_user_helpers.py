"""Bug 3.1 & 3.2 — tests wired to the REAL functions in core.server.

Unlike the mock-based tests, these import the actual helpers so they cannot
drift from the shipped code (a concern raised in review about mirrored logic).

Bug 3.1: the raw ASK_USER:{...} marker must never reach the user as text.
Bug 3.2: /api/agent/answer must relay the user's ACTUAL selection/custom text
         (frontend sends {"selected": [...], "custom": "..."}), not "ok".
"""
import os
import sys

# core.server imports read env at import; point DB somewhere disposable.
os.environ.setdefault("BROWSERAI_DB", "/tmp/browserai_helpers_test.db")
os.environ.setdefault("OPENHANDS_AGENT_SERVER", "http://127.0.0.1:9")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from core.server import _strip_ask_user_marker, _format_answer_text  # noqa: E402


# ── Bug 3.1: marker stripping ────────────────────────────────────────────────
def test_strip_marker_removes_ask_user_json():
    txt = 'Here are your choices ASK_USER:{"question":"Which?","options":[{"id":"a","label":"A"}]}'
    assert _strip_ask_user_marker(txt) == "Here are your choices"


def test_strip_marker_keeps_trailing_prose():
    txt = 'ASK_USER:{"question":"Q","options":[]} Please choose above.'
    assert _strip_ask_user_marker(txt) == "Please choose above."


def test_strip_marker_handles_nested_json():
    txt = 'Intro ASK_USER:{"question":"Q","options":[{"id":"1","meta":{"x":2}}]} end'
    out = _strip_ask_user_marker(txt)
    assert "ASK_USER" not in out and "Intro" in out and "end" in out


def test_strip_marker_noop_without_marker():
    assert _strip_ask_user_marker("just a normal reply") == "just a normal reply"
    assert _strip_ask_user_marker("") == ""


def test_strip_marker_unbalanced_drops_tail():
    txt = 'Before ASK_USER:{"question":"Q" broken'
    assert _strip_ask_user_marker(txt) == "Before"


# ── Bug 3.2: answer text formatting ──────────────────────────────────────────
OPTS = [{"id": "prod", "label": "Production"}, {"id": "dev", "label": "Development"}]


def test_format_single_selection_maps_label():
    assert _format_answer_text({"selected": ["prod"]}, OPTS) == "Production"


def test_format_multi_selection_joined_labels():
    assert _format_answer_text({"selected": ["prod", "dev"]}, OPTS) == "Production, Development"


def test_format_selection_plus_custom():
    assert _format_answer_text({"selected": ["dev"], "custom": "also staging"}, OPTS) == "Development, also staging"


def test_format_custom_only():
    assert _format_answer_text({"custom": "free text"}, OPTS) == "free text"


def test_format_unknown_id_falls_back_to_id():
    assert _format_answer_text({"selected": ["mystery"]}, OPTS) == "mystery"


def test_format_empty_is_ok_sentinel():
    assert _format_answer_text({}, OPTS) == "ok"
    assert _format_answer_text(None, OPTS) == "ok"


def test_format_legacy_string_answer():
    assert _format_answer_text("legacy", OPTS) == "legacy"


def test_format_regression_not_ok_when_selection_present():
    # The exact Bug 3.2 regression: previously collapsed to "ok".
    assert _format_answer_text({"selected": ["prod"]}, OPTS) != "ok"
