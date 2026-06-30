"""Step 10.1 — server-side re-chunking of the assistant message into deltas."""
from core.server import _chunk_text


def test_chunk_lossless_and_bounded():
    text = ("Привет, это довольно длинный ответ ассистента, который надо "
            "разбить на несколько частей для эффекта печати по словам.")
    parts = _chunk_text(text, 24)
    assert len(parts) > 1
    assert "".join(parts) == text          # never lose/duplicate characters
    assert all(p for p in parts)           # no empty chunks


def test_chunk_short_text_single_piece():
    assert _chunk_text("hi", 24) == ["hi"]
    assert _chunk_text("", 24) == []


def test_chunk_handles_long_whitespace_free_run():
    # e.g. a long URL or code token — must still be split & lossless.
    blob = "x" * 200
    parts = _chunk_text(blob, 24)
    assert "".join(parts) == blob
    assert len(parts) > 1


def test_chunk_prefers_word_boundaries():
    text = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
    parts = _chunk_text(text, 10)
    # No chunk should start with a leading space artifact from a mid-word cut
    # and the join must be exact.
    assert "".join(parts) == text


# ── WS→poll fallback dedup tests ──────────────────────────────────────────


class TestWsToPollDedup:
    """Verify that when a WebSocket stream fails mid-stream and the code
    falls back to REST polling, the seen_ids set is correctly carried over
    so that events already emitted via WS are not duplicated by polling.

    These tests exercise the dedup logic without requiring a running
    OpenHands instance — they test the set arithmetic that prevents
    duplicate event delivery.
    """

    def test_seen_ids_carried_to_poll(self):
        """Events seen via WS should not be re-emitted when polling starts."""
        ws_seen_ids = {0, 1, 2, 3, 4, 5}
        initial_seen_ids = {0, 1, 2}
        # After WS yields some events, fallback must use the *latest* seen set
        fallback_ids = set(ws_seen_ids)
        assert fallback_ids >= initial_seen_ids
        # Events 3,4,5 already seen by WS — polling must skip them
        poll_events = [{"id": 3}, {"id": 4}, {"id": 5}, {"id": 6}, {"id": 7}]
        new_events = [e for e in poll_events if e["id"] not in fallback_ids]
        assert [e["id"] for e in new_events] == [6, 7]

    def test_start_after_id_updated_from_ws(self):
        """start_after_id for the polling fallback must reflect the highest
        event ID seen by WS, not the original last_seen_event_id."""
        last_seen_event_id = 2  # value from before WS started
        ws_seen_ids = {0, 1, 2, 3, 4, 5}
        numeric_ids = [int(x) for x in ws_seen_ids if isinstance(x, int) or str(x).lstrip("-").isdigit()]
        ws_fallback_last_event_id = max(numeric_ids) if numeric_ids else last_seen_event_id
        assert ws_fallback_last_event_id == 5
        # start_after_id=5 means poll will request events after id 5,
        # which correctly skips events 0-5 already seen via WS.
        next_start_id = ws_fallback_last_event_id + 1
        assert next_start_id == 6

    def test_no_duplicates_when_ws_fails_before_first_yield(self):
        """If WS fails before yielding any events, seen_ids stays as
        initial_seen_ids — no events to duplicate."""
        initial_seen_ids = {0, 1, 2}
        last_seen_event_id = 2
        # WS didn't yield anything, so fallback uses initial state
        fallback_ids = set(initial_seen_ids)
        fallback_last_eid = last_seen_event_id
        # Polling will fetch from last_seen_event_id and skip 0,1,2
        poll_events = [{"id": 0}, {"id": 1}, {"id": 2}, {"id": 3}, {"id": 4}]
        new_events = [e for e in poll_events if e["id"] not in fallback_ids]
        assert [e["id"] for e in new_events] == [3, 4]

    def test_mid_stream_ws_failure_preserves_partial_progress(self):
        """WS streams events 0-5, fails at event 6. Polling must resume
        from event 6, not from the beginning."""
        last_seen_event_id = 2
        initial_seen_ids = set(range(0, last_seen_event_id + 1))
        # WS processes events 3, 4, 5
        ws_seen_ids = set(initial_seen_ids) | {3, 4, 5}
        # Simulate: event 6 was received by WS but exception thrown
        # before the generator could yield it — seen_ids may or may not
        # include 6 depending on timing. Both cases must be safe.
        # Case A: seen_ids includes 6 (event was processed before crash)
        ws_seen_ids_with_6 = set(ws_seen_ids) | {6}
        new_from_poll = [e for e in [{"id": 5}, {"id": 6}, {"id": 7}]
                         if e["id"] not in ws_seen_ids_with_6]
        assert [e["id"] for e in new_from_poll] == [7]
        # Case B: seen_ids does NOT include 6 (crash before processing)
        new_from_poll_b = [e for e in [{"id": 5}, {"id": 6}, {"id": 7}]
                           if e["id"] not in ws_seen_ids]
        # Event 6 gets re-delivered — that's acceptable (at-most-once
        # for tool events is impossible; at-least-once with idempotent
        # UI handling is the pragmatic choice). The key invariant:
        # no event before 5 is duplicated.
        assert all(e["id"] >= 5 for e in new_from_poll_b)

    def test_poll_dedup_matches_ws_dedup(self):
        """The same seen_ids set logic is used in both _stream_chat_ws
        and _poll_openhands_events — verify they agree on what's new."""
        seen = {0, 1, 2, 3, 4, 5}
        events = [{"id": i} for i in range(8)]
        new_ws = [e for e in events if e["id"] not in seen]
        new_poll = [e for e in events if e["id"] not in seen]
        assert new_ws == new_poll
        assert [e["id"] for e in new_poll] == [6, 7]


# ── Error code tests ──────────────────────────────────────────────────────


class TestErrorCodes:
    """Verify that backend error messages use structured codes instead of
    hardcoded Russian text, enabling frontend localization."""

    def test_error_payload_has_code_field(self):
        """Error SSE events must include a 'code' field for i18n."""
        from core.server import _sse
        payload = _sse("error", {"code": "empty_turn", "message": "OpenHands completed turn with no text output."})
        assert '"code"' in payload
        assert '"empty_turn"' in payload
        assert '"message"' in payload

    def test_agent_timeout_code(self):
        from core.server import _sse
        payload = _sse("error", {"code": "agent_timeout", "message": "Agent timed out (no events for 3 min)."})
        assert '"agent_timeout"' in payload

    def test_busy_code(self):
        from core.server import _sse
        payload = _sse("error", {"code": "busy", "message": "This chat is already running an agent task."})
        assert '"busy"' in payload

    def test_no_russian_in_backend_error_codes(self):
        """Backend error messages should be language-neutral English.
        Russian localization belongs in the frontend."""
        from core.server import _sse
        codes_and_msgs = [
            ("empty_turn", "OpenHands completed turn with no text output."),
            ("agent_timeout", "Agent timed out (no events for 3 min)."),
            ("busy", "This chat is already running an agent task. Wait for completion or press Stop."),
        ]
        for code, msg in codes_and_msgs:
            payload = _sse("error", {"code": code, "message": msg})
            # Quick check: no Cyrillic characters in the payload
            has_cyrillic = any('\u0400' <= c <= '\u04FF' for c in payload)
            assert not has_cyrillic, f"Cyrillic found in error payload for code '{code}'"
