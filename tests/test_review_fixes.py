"""Regression tests for Sonnet-review fixes (verified against real code).

Covers:
  #7  model-list merge must allow intentional shrink (no phantom regrowth)
  #10 migrations: missing_columns() surfaces schema drift for /api/health/deep
  #1  conversations.get_or_create_conversation is READ-ONLY for last_event_id
      (no peek-and-write that reopens Bug 2.2) — asserted by source inspection
      since the full path needs a live OpenHands.
"""
import json
import os
import sqlite3

import core.database as db
from core.migrations import ensure_columns, missing_columns


# ── #7: model list can shrink on explicit user intent ───────────────────────
def _find_key(kid):
    for k in db.list_keys(include_secrets=False):
        if k["id"] == kid:
            return k
    return None


def _seed_key_with_models(kid, models):
    db.upsert_key({
        "id": kid,
        "name": "test-" + kid,
        "baseUrl": "https://example.com",
        "apiKey": "sk-test",
        "model": models[0] if models else "",
        "availableModels": models,
    })


def test_model_list_shrinks_on_explicit_prune():
    kid = "rk-prune"
    _seed_key_with_models(kid, ["a", "b", "c"])
    # User intentionally prunes to just ["a"]
    db.upsert_key({
        "id": kid, "name": "test-" + kid, "baseUrl": "https://example.com",
        "availableModels": ["a"], "apiKey": "",  # keep existing secret
    })
    assert _find_key(kid)["availableModels"] == ["a"], "explicit prune must stick"


def test_model_list_empty_incoming_preserves_stored():
    kid = "rk-empty"
    _seed_key_with_models(kid, ["x", "y"])
    # Accidental omission (empty) → keep stored list
    db.upsert_key({
        "id": kid, "name": "test-" + kid, "baseUrl": "https://example.com",
        "availableModels": [], "apiKey": "",
    })
    assert set(_find_key(kid)["availableModels"]) == {"x", "y"}, "empty keeps stored"


# ── #10: schema drift is detectable ─────────────────────────────────────────
def test_missing_columns_reports_and_migrate_clears():
    c = sqlite3.connect(":memory:")
    c.executescript("CREATE TABLE agent_runs(chat_id TEXT PRIMARY KEY, status TEXT);")
    gaps = [g for g in missing_columns(c) if g.startswith("agent_runs.")]
    assert "agent_runs.last_turn_id" in gaps
    ensure_columns(c, "agent_runs")
    gaps_after = [g for g in missing_columns(c) if g.startswith("agent_runs.")]
    assert gaps_after == [], "migration should clear drift"


def test_missing_columns_ignores_absent_table():
    c = sqlite3.connect(":memory:")  # no tables at all
    # Absent tables are not drift (CREATE TABLE will build them fresh).
    assert missing_columns(c) == []


# ── #1: conversations path must not write the cursor ────────────────────────
def test_conversations_get_or_create_is_readonly_for_cursor():
    """Guard: the peek-and-write that reopened Bug 2.2 must stay removed.
    We assert the source no longer calls update_last_event inside
    get_or_create_conversation's reused-mapping branch."""
    src = open(os.path.join(os.path.dirname(__file__), "..", "core", "conversations.py")).read()
    # find the function body
    start = src.index("async def get_or_create_conversation")
    end = src.index("\nasync def ", start + 1) if "\nasync def " in src[start + 1:] else len(src)
    body = src[start:end]
    assert "update_last_event(" not in body, (
        "get_or_create_conversation must not write last_event_id "
        "(reopens Bug 2.2 cursor double-writer)"
    )
