"""Socket.IO/WebSocket client for OpenHands conversation events.

OpenHands exposes its realtime bridge as Socket.IO on `/socket.io/` and emits
`oh_event` payloads for a joined conversation. BrowserAI keeps REST polling as a
fallback, but this module provides the Phase 2.1 realtime path without adding a
hard dependency on python-socketio.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, Optional
from urllib.parse import urlencode, urlparse, urlunparse

try:
    import websockets
except ModuleNotFoundError:  # pragma: no cover - depends on runtime image
    websockets = None

log = logging.getLogger("browserai.core.bridge.ws")


@dataclass
class OpenHandsWsUnavailable(Exception):
    """Raised when the Socket.IO bridge cannot be used and caller should poll."""

    reason: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.reason


def _socketio_ws_url(base_url: str, conversation_id: str, latest_event_id: int = -1) -> str:
    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    qs = urlencode(
        {
            "conversation_id": conversation_id,
            "latest_event_id": str(int(latest_event_id)),
            "EIO": "4",
            "transport": "websocket",
        }
    )
    return urlunparse((scheme, parsed.netloc, "/socket.io/", "", qs, ""))


def _decode_engineio_message(raw: str) -> Optional[Dict[str, Any]]:
    """Decode enough Socket.IO protocol to extract `oh_event` payloads.

    Engine.IO packet prefixes used here:
      * `0{...}` open
      * `2` ping; caller must send `3` pong
      * `40...` Socket.IO namespace connected
      * `42[...]` Socket.IO event
    """
    if not raw or not raw.startswith("42"):
        return None
    try:
        payload = json.loads(raw[2:])
    except Exception:
        return None
    if not isinstance(payload, list) or len(payload) < 2:
        return None
    event_name, data = payload[0], payload[1]
    if event_name != "oh_event" or not isinstance(data, dict):
        return None
    return data


async def stream_openhands_events_ws(
    base_url: str,
    conversation_id: str,
    latest_event_id: int = -1,
    *,
    connect_timeout: float = 8.0,
    idle_timeout: float = 15.0,
) -> AsyncIterator[Dict[str, Any]]:
    """Yield OpenHands `oh_event` dicts over Socket.IO WebSocket.

    The generator intentionally raises OpenHandsWsUnavailable on connection or
    protocol setup errors. Runtime idle timeouts also raise it so BrowserAI can
    fall back to REST polling mid-turn if the Socket.IO stream goes quiet.
    """

    if websockets is None:
        raise OpenHandsWsUnavailable("python package 'websockets' is not installed")

    url = _socketio_ws_url(base_url, conversation_id, latest_event_id)
    try:
        async with websockets.connect(url, open_timeout=connect_timeout, ping_interval=None) as ws:
            # Engine.IO handshake frame must arrive first.
            try:
                first = await asyncio.wait_for(ws.recv(), timeout=connect_timeout)
            except asyncio.TimeoutError as e:
                raise OpenHandsWsUnavailable("socket.io handshake timeout") from e
            if not isinstance(first, str) or not first.startswith("0"):
                raise OpenHandsWsUnavailable(f"unexpected socket.io handshake: {str(first)[:80]}")

            # Send Socket.IO connect packet for default namespace.
            await ws.send("40")

            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=idle_timeout)
                except asyncio.TimeoutError as e:
                    raise OpenHandsWsUnavailable("socket.io idle timeout") from e
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                if raw == "2":
                    await ws.send("3")
                    continue
                if raw.startswith("40"):
                    continue
                if raw.startswith("41"):
                    raise OpenHandsWsUnavailable("socket.io namespace disconnected")
                event = _decode_engineio_message(raw)
                if event is not None:
                    yield event
    except OpenHandsWsUnavailable:
        raise
    except Exception as e:
        raise OpenHandsWsUnavailable(f"socket.io unavailable: {e}") from e
