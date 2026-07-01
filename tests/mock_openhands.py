"""Mock OpenHands server for BrowserAI integration tests.

Why this exists
---------------
BrowserAI's hardest bugs live in the BrowserAI<->OpenHands glue: event-cursor
advancement, stop semantics, ask_user mid-stream, idempotency. The real
OpenHands is a heavy Docker stack, and `self-test` only checks an LLM "pong" —
it cannot reproduce a *broken* stream (e.g. bug 2.2: cursor moving past unseen
events when done=False). This mock makes those scenarios deterministic.

Design
------
* Pure stdlib (`http.server` in a background thread) — no aiohttp dependency,
  runs anywhere pytest runs.
* Programmable: a test pushes a *script* of events; the mock serves them via
  the same REST contract BrowserAI consumes.
* Implements the endpoints BrowserAI actually calls:
    POST /api/conversations                      -> {"conversation_id": ...}
    GET  /api/conversations/{cid}                -> {"conversation_id", "status"}
    GET  /api/conversations/{cid}/events?limit=N -> [ {id, action/observation, ...} ]
    POST /api/conversations/{cid}/message        -> {"ok": true}
    POST /api/conversations/{cid}/stop           -> {"ok": true}

Event shape (matches what BrowserAI parses in core/server.py):
    {"id": <int>, "source": "agent", "message": "...", ...}
    turn-complete marker:
    {"id": <int>, "observation": "agent_state_changed",
     "extras": {"agent_state": "finished"}}   # or "stopped" / "error"

Usage in a test:
    with MockOpenHands() as oh:
        cid = oh.create_conversation()
        oh.push_event(cid, message="hello")
        oh.push_event(cid, message="pong")
        oh.finish(cid)                 # appends agent_state_changed=finished
        # point BrowserAI at oh.url, then exercise the streaming endpoint
"""
from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse


class _State:
    """Shared, thread-safe-ish store of conversations and their event logs."""

    def __init__(self) -> None:
        self.conversations: Dict[str, Dict[str, Any]] = {}
        self.events: Dict[str, List[Dict[str, Any]]] = {}
        self.messages: Dict[str, List[str]] = {}   # posted user messages
        self.stops: Dict[str, int] = {}             # stop call counts
        self._next_id: Dict[str, int] = {}
        self.lock = threading.Lock()

    def new_conversation(self, cid: Optional[str] = None) -> str:
        cid = cid or uuid.uuid4().hex
        with self.lock:
            self.conversations[cid] = {"conversation_id": cid, "status": "RUNNING"}
            self.events[cid] = []
            self.messages[cid] = []
            self.stops[cid] = 0
            self._next_id[cid] = 0
        return cid

    def add_event(self, cid: str, event: Dict[str, Any]) -> int:
        with self.lock:
            eid = self._next_id.get(cid, 0)
            self._next_id[cid] = eid + 1
            ev = dict(event)
            ev["id"] = eid
            self.events.setdefault(cid, []).append(ev)
            return eid


class MockOpenHands:
    """Context-managed mock OpenHands HTTP server."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self.state = _State()
        state = self.state

        class Handler(BaseHTTPRequestHandler):
            # silence noisy logging during tests
            def log_message(self, *_args) -> None:  # noqa: D401
                pass

            def _send(self, code: int, payload: Any) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _read_json(self) -> Dict[str, Any]:
                length = int(self.headers.get("Content-Length") or 0)
                if not length:
                    return {}
                try:
                    return json.loads(self.rfile.read(length) or b"{}")
                except Exception:
                    return {}

            # ── routing ────────────────────────────────────────────────
            def do_POST(self) -> None:
                path = urlparse(self.path).path
                parts = [p for p in path.split("/") if p]
                # /api/conversations
                if parts == ["api", "conversations"]:
                    self._read_json()
                    cid = state.new_conversation()
                    self._send(200, {"conversation_id": cid, "status": "RUNNING"})
                    return
                # /api/conversations/{cid}/message
                if len(parts) == 4 and parts[:2] == ["api", "conversations"] and parts[3] == "message":
                    cid = parts[2]
                    body = self._read_json()
                    if cid not in state.conversations:
                        self._send(404, {"error": "not found"})
                        return
                    state.messages[cid].append(str(body.get("message", "")))
                    self._send(200, {"ok": True})
                    return
                # /api/conversations/{cid}/stop
                if len(parts) == 4 and parts[:2] == ["api", "conversations"] and parts[3] == "stop":
                    cid = parts[2]
                    if cid not in state.conversations:
                        self._send(404, {"error": "not found"})
                        return
                    state.stops[cid] += 1
                    state.conversations[cid]["status"] = "STOPPED"
                    self._send(200, {"ok": True})
                    return
                self._send(404, {"error": "unknown route", "path": path})

            def do_GET(self) -> None:
                parsed = urlparse(self.path)
                parts = [p for p in parsed.path.split("/") if p]
                # /api/conversations/{cid}/events
                if len(parts) == 4 and parts[:2] == ["api", "conversations"] and parts[3] == "events":
                    cid = parts[2]
                    if cid not in state.conversations:
                        self._send(404, {"error": "conversation lost"})
                        return
                    with state.lock:
                        events = list(state.events.get(cid, []))
                    self._send(200, events)
                    return
                # /api/conversations/{cid}
                if len(parts) == 3 and parts[:2] == ["api", "conversations"]:
                    cid = parts[2]
                    conv = state.conversations.get(cid)
                    if not conv:
                        self._send(404, {"error": "not found"})
                        return
                    self._send(200, conv)
                    return
                self._send(404, {"error": "unknown route", "path": parsed.path})

        self._server = ThreadingHTTPServer((host, port), Handler)
        self.host, self.port = self._server.server_address[0], self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    # ── lifecycle ──────────────────────────────────────────────────────
    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def __enter__(self) -> "MockOpenHands":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()

    # ── programmable API (used by tests) ───────────────────────────────
    def create_conversation(self, cid: Optional[str] = None) -> str:
        return self.state.new_conversation(cid)

    def push_event(self, cid: str, *, message: str = "", source: str = "agent", **extra) -> int:
        """Append a normal assistant/agent event; returns its event id."""
        ev: Dict[str, Any] = {"source": source, "message": message}
        ev.update(extra)
        return self.state.add_event(cid, ev)

    def finish(self, cid: str, state: str = "finished") -> int:
        """Append the turn-complete marker BrowserAI recognizes."""
        return self.state.add_event(
            cid,
            {"observation": "agent_state_changed", "extras": {"agent_state": state}},
        )

    # introspection helpers
    def messages_for(self, cid: str) -> List[str]:
        return list(self.state.messages.get(cid, []))

    def stop_count(self, cid: str) -> int:
        return self.state.stops.get(cid, 0)

    def event_count(self, cid: str) -> int:
        return len(self.state.events.get(cid, []))
