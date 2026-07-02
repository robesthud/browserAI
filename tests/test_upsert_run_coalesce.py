"""Sonnet #6 — upsert_run must preserve unspecified fields via SQL (no Python
read-then-write race) and update the ones it's given."""
import core.agent_state as st


def _reset(chat_id):
    # ensure a clean row per test by using unique chat ids
    return chat_id


def test_status_only_update_preserves_event_and_turn():
    st.init_agent_state_schema()
    cid = "t6-preserve"
    st.upsert_run(cid, "conv", "u", "running", last_prompt="hi", last_event_id=5, last_turn_id="t1")
    st.upsert_run(cid, "conv", "u", "awaiting_input")  # no eid/turn provided
    r = st.get_run(cid)
    assert r["status"] == "awaiting_input"
    assert r["last_event_id"] == 5      # preserved
    assert r["last_turn_id"] == "t1"    # preserved


def test_explicit_event_id_overrides_but_keeps_turn():
    st.init_agent_state_schema()
    cid = "t6-override"
    st.upsert_run(cid, "conv", "u", "running", last_event_id=3, last_turn_id="turnX")
    st.upsert_run(cid, "conv", "u", "done", last_event_id=9)  # new eid, no turn
    r = st.get_run(cid)
    assert r["last_event_id"] == 9
    assert r["last_turn_id"] == "turnX"


def test_created_at_is_stable_across_updates():
    st.init_agent_state_schema()
    cid = "t6-created"
    st.upsert_run(cid, "conv", "u", "running", last_event_id=1)
    c0 = st.get_run(cid)["created_at"]
    st.upsert_run(cid, "conv", "u", "done", last_event_id=2)
    assert st.get_run(cid)["created_at"] == c0


def test_fresh_insert_defaults():
    st.init_agent_state_schema()
    cid = "t6-fresh"
    st.upsert_run(cid, "conv", "u", "running")  # no eid/turn
    r = st.get_run(cid)
    assert r["last_event_id"] == -1
    assert r["last_turn_id"] == ""
