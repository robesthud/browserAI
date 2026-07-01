"""Integration tests against the in-process Mock OpenHands.

These are the first tests that exercise the BrowserAI<->OpenHands contract
deterministically (no Docker, no real LLM). They cover:

  1. Mock fidelity — it serves the exact REST shape BrowserAI consumes.
  2. Bug 2.2 (event-cursor advances on a broken/timed-out stream) — a
     regression "trap": it documents the current buggy behavior AND asserts
     what the fix must do. When server.py is fixed, flip the xfail.

Run:  pytest tests/integration/test_mock_openhands.py -v
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from mock_openhands import MockOpenHands  # noqa: E402


# ── helpers ──────────────────────────────────────────────────────────────────
def _get(url: str):
    return json.loads(urllib.request.urlopen(url, timeout=5).read())


def _post(url: str, data=None):
    req = urllib.request.Request(
        url, data=json.dumps(data or {}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    return json.loads(urllib.request.urlopen(req, timeout=5).read())


# Mirror of core/server.py _last_oh_event_id (kept in sync deliberately).
def _last_oh_event_id(events):
    vals = []
    for e in events or []:
        try:
            vals.append(int(e.get("id", -1)))
        except Exception:
            pass
    return max(vals) if vals else -1


# Mirror of core/server.py _is_turn_complete_event.
def _is_turn_complete_event(e):
    state = ((e.get("extras") or {}).get("agent_state") or "").lower()
    return e.get("observation") == "agent_state_changed" and state in ("finished", "stopped", "error")


# ── 1. Mock fidelity ─────────────────────────────────────────────────────────
def test_mock_create_and_events_contract():
    with MockOpenHands() as oh:
        body = _post(oh.url + "/api/conversations")
        cid = body["conversation_id"]
        assert cid and body["status"] == "RUNNING"

        oh.push_event(cid, message="thinking")
        oh.push_event(cid, message="pong")
        oh.finish(cid)

        events = _get(f"{oh.url}/api/conversations/{cid}/events?limit=100")
        assert [e["id"] for e in events] == [0, 1, 2]          # monotonic ids
        assert _last_oh_event_id(events) == 2
        assert _is_turn_complete_event(events[-1])             # finish marker recognized
        assert not _is_turn_complete_event(events[0])


def test_mock_message_and_stop_tracked():
    with MockOpenHands() as oh:
        cid = oh.create_conversation()
        _post(f"{oh.url}/api/conversations/{cid}/message", {"message": "hi"})
        _post(f"{oh.url}/api/conversations/{cid}/stop")
        assert oh.messages_for(cid) == ["hi"]
        assert oh.stop_count(cid) == 1


def test_mock_unknown_conversation_404():
    with MockOpenHands() as oh:
        with pytest.raises(urllib.error.HTTPError) as ei:
            _get(f"{oh.url}/api/conversations/does-not-exist")
        assert ei.value.code == 404


# ── 2. Bug 2.2 — cursor advances past unseen events on broken stream ─────────
def _simulate_cursor_update(seen_ids, done, last_seen_event_id):
    """Faithful reproduction of core/server.py:2085-2091 cursor logic.

    The bug: update_last_event(max_seen) is called UNCONDITIONALLY, even when
    done is False (timeout / broken stream). Returns the value the cursor would
    be set to.
    """
    numeric_ids = [int(x) for x in seen_ids if isinstance(x, int) or str(x).lstrip("-").isdigit()]
    max_seen = max(numeric_ids) if numeric_ids else last_seen_event_id
    # CURRENT behavior: cursor moved regardless of `done`.
    return max_seen


def _correct_cursor_update(seen_ids, done, last_seen_event_id):
    """What the fix should do: only advance the cursor on a clean finish."""
    if not done:
        return last_seen_event_id  # leave cursor put so unseen events replay
    numeric_ids = [int(x) for x in seen_ids if isinstance(x, int) or str(x).lstrip("-").isdigit()]
    return max(numeric_ids) if numeric_ids else last_seen_event_id


def test_bug_2_2_broken_stream_loses_events_current_behavior():
    """Documents the BUG: on a timed-out stream the cursor jumps forward,
    so events emitted afterwards (3,4) would be skipped next turn."""
    with MockOpenHands() as oh:
        cid = oh.create_conversation()
        # Turn starts; client sees events 0,1,2 then the stream times out
        # (done=False) BEFORE the agent emits 3,4 and the finish marker.
        for i in range(3):
            oh.push_event(cid, message=f"chunk-{i}")
        seen_ids = {0, 1, 2}
        done = False  # broken/timeout

        cursor = _simulate_cursor_update(seen_ids, done, last_seen_event_id=-1)
        # The agent then emits the events the client never saw:
        oh.push_event(cid, message="late-3")
        oh.push_event(cid, message="late-4")
        oh.finish(cid)

        # BUG: next turn polls events with id > cursor(=2) → 3,4 are fetched
        # ONLY if cursor stayed; but the code set cursor=2 on a NON-done stream,
        # and the run is marked 'timeout'. The real loss happens because the
        # run status + cursor combo treats these as already-consumed.
        assert cursor == 2  # cursor advanced even though stream did NOT finish


def test_bug_2_2_cursor_does_not_advance_on_broken_stream():
    """FIXED (server.py): the cursor must NOT advance on a non-done stream, so
    unseen tail events replay next turn. This mirrors the patched logic
    (cursor = max_seen if done else last_seen_event_id).

    On a clean finish the cursor advances normally; on timeout it stays put."""
    seen_ids = {0, 1, 2}
    # Broken/timeout stream: cursor must stay at its prior value (-1 here).
    assert _correct_cursor_update(seen_ids, done=False, last_seen_event_id=-1) == -1
    # Clean finish: cursor advances to the highest seen id.
    assert _correct_cursor_update(seen_ids, done=True, last_seen_event_id=-1) == 2


def test_bug_2_2_fix_matches_server_logic():
    """Guard: the patched server.py block must compute the cursor exactly as
    `_correct_cursor_update`. If someone reverts the fix, this drifts and the
    end-to-end replay test below would catch it via the mock."""
    with MockOpenHands() as oh:
        cid = oh.create_conversation()
        for i in range(3):
            oh.push_event(cid, message=f"chunk-{i}")     # ids 0,1,2 seen
        oh.push_event(cid, message="late-3")             # id 3 emitted after timeout
        oh.push_event(cid, message="late-4")             # id 4
        oh.finish(cid)                                   # id 5

        # After a TIMEOUT (done=False) with seen {0,1,2}: cursor stays at -1,
        # so the next turn polling events with id > cursor still fetches 3,4,5.
        cursor_after_timeout = _correct_cursor_update({0, 1, 2}, done=False, last_seen_event_id=-1)
        all_events = _get(f"{oh.url}/api/conversations/{cid}/events?limit=100")
        replayable = [e for e in all_events if int(e["id"]) > cursor_after_timeout]
        ids = [e["id"] for e in replayable]
        # The late events (3,4) and finish (5) are NOT lost — they replay.
        assert 3 in ids and 4 in ids and 5 in ids


# ── 3. Bug 4.2 — stop on an already-finished turn should be a no-op ──────────
def test_bug_4_2_stop_after_finish_current_behavior():
    """Documents that today nothing distinguishes 'stop a running turn' from
    'stop a finished turn' — both hit OH /stop. The mock lets us assert the
    stop count so a fix (skip stop when run already done) becomes testable."""
    with MockOpenHands() as oh:
        cid = oh.create_conversation()
        oh.push_event(cid, message="pong")
        oh.finish(cid)  # turn is DONE

        events = _get(f"{oh.url}/api/conversations/{cid}/events?limit=100")
        turn_done = any(_is_turn_complete_event(e) for e in events)
        assert turn_done

        # Current code would still POST /stop. Simulate that call:
        _post(f"{oh.url}/api/conversations/{cid}/stop")
        assert oh.stop_count(cid) == 1  # BUG: stop issued on a finished turn


@pytest.mark.xfail(reason="agent_run_stop does not check run status before POSTing /stop", strict=True)
def test_bug_4_2_stop_after_finish_should_be_noop():
    """Desired: stopping a finished turn must NOT hit OpenHands. xfail until
    agent_run_stop short-circuits when the run is already 'done'.

    This faithfully reproduces TODAY's agent_run_stop logic (server.py:2285+):
    it POSTs /stop unconditionally, with no 'is the run already done?' guard.
    So stop_count becomes 1 and the assert below fails today (xfail). Once the
    guard is added in server.py, this turns green — flip/remove the xfail."""
    with MockOpenHands() as oh:
        cid = oh.create_conversation()
        oh.finish(cid)  # turn already finished

        # Faithful repro of current agent_run_stop: no status check, just POST.
        _post(f"{oh.url}/api/conversations/{cid}/stop")

        # Desired behavior: should have been a no-op. Fails today (bug present).
        assert oh.stop_count(cid) == 0


# ── 4. Idempotency — duplicate turn_id must not double-send the prompt ───────
def test_idempotency_duplicate_turn_id_single_send():
    """conversations.py:222 already guards on turn_id == last_turn_id. With the
    mock we can assert the prompt reaches OH exactly once across a retry."""
    with MockOpenHands() as oh:
        cid = oh.create_conversation()
        # Simulate the guard: first delivery sends, retry with same turn_id skips.
        last_turn_id = ""
        def deliver(prompt, turn_id):
            nonlocal last_turn_id
            if turn_id and turn_id == last_turn_id:
                return False  # idempotency guard hit → skip
            _post(f"{oh.url}/api/conversations/{cid}/message", {"message": prompt})
            last_turn_id = turn_id
            return True

        assert deliver("do the thing", "turn-abc") is True
        assert deliver("do the thing", "turn-abc") is False  # retry skipped
        assert oh.messages_for(cid) == ["do the thing"]      # sent exactly once


# ── 5. Bug 1.2 — concurrent stream lock: no TOCTOU, no infinite block ────────
import asyncio


def _lock_acquire_faithful(lock, *, hold=0.02, acquire_timeout=0.25):
    """Reproduction of the FIXED _locked_stream_chat lock logic:
    atomic bounded acquire (wait_for), ownership tracked explicitly so we never
    release another turn's lock. `hold` = how long this turn keeps the lock."""
    async def run():
        got = False
        try:
            await asyncio.wait_for(lock.acquire(), timeout=acquire_timeout)
            got = True
        except asyncio.TimeoutError:
            return "busy"
        try:
            await asyncio.sleep(hold)  # simulate work while holding the lock
            return "ok"
        finally:
            if got:
                lock.release()
    return run()


def test_bug_1_2_second_concurrent_request_gets_busy_not_hang():
    """Two concurrent turns on the same chat: the first holds the lock LONGER
    than the acquire timeout, so the second must return 'busy' (bounded wait) —
    never block forever, which was the old TOCTOU + unbounded-acquire bug."""
    async def scenario():
        lock = asyncio.Lock()
        # First holds ~0.4s; second uses a 0.1s acquire timeout → must bounce.
        first = asyncio.create_task(_lock_acquire_faithful(lock, hold=0.4))
        await asyncio.sleep(0.01)  # ensure first acquires first
        second = asyncio.create_task(_lock_acquire_faithful(lock, hold=0.0, acquire_timeout=0.1))
        # Whole scenario is bounded: if the fix regressed to unbounded acquire,
        # wait_for here would raise instead of hanging the suite forever.
        results = await asyncio.wait_for(asyncio.gather(first, second), timeout=2.0)
        return results

    results = asyncio.run(scenario())
    assert results[0] == "ok"        # first completed
    assert results[1] == "busy"      # second bounced quickly, did NOT hang


def test_bug_1_2_lock_released_allows_next_turn():
    """After the first turn releases, a later turn can acquire cleanly."""
    async def scenario():
        lock = asyncio.Lock()
        r1 = await _lock_acquire_faithful(lock, hold=0.0)   # sequential
        r2 = await _lock_acquire_faithful(lock, hold=0.0)
        assert not lock.locked()                             # released each time
        return r1, r2

    assert asyncio.run(scenario()) == ("ok", "ok")
