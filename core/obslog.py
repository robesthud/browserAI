"""
Step 10.6 — structured logging & request tracing.

Provides:
  * A JSON log formatter, toggled by env LOG_FORMAT=json (default: plain text,
    so local/dev output stays readable and we don't change prod log shape
    unless explicitly asked).
  * A per-request trace_id stored in a contextvar so any log line emitted while
    handling a request is automatically correlated. The trace_id is also
    surfaced to the client via the X-Trace-Id response header and, for agent
    chats, correlated with chatId / OpenHands conversation_id.

Wiring lives in core/server.py (install_request_logging(app)).
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from contextvars import ContextVar
from typing import Any, Dict, Optional

# Per-request correlation id (and optional chat/conversation correlation).
trace_id_var: ContextVar[Optional[str]] = ContextVar("trace_id", default=None)
chat_id_var: ContextVar[Optional[str]] = ContextVar("chat_id", default=None)
conversation_id_var: ContextVar[Optional[str]] = ContextVar("conversation_id", default=None)


def new_trace_id() -> str:
    return uuid.uuid4().hex[:16]


def set_trace_context(trace_id: Optional[str] = None,
                      chat_id: Optional[str] = None,
                      conversation_id: Optional[str] = None) -> str:
    tid = trace_id or new_trace_id()
    trace_id_var.set(tid)
    if chat_id is not None:
        chat_id_var.set(chat_id)
    if conversation_id is not None:
        conversation_id_var.set(conversation_id)
    return tid


def bind_conversation(conversation_id: Optional[str]) -> None:
    """Call once an OpenHands conversation_id is known, to correlate logs."""
    if conversation_id:
        conversation_id_var.set(conversation_id)


class _ContextFilter(logging.Filter):
    """Attach current trace/chat/conversation ids to every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = trace_id_var.get()
        record.chat_id = chat_id_var.get()
        record.conversation_id = conversation_id_var.get()
        return True


class JsonFormatter(logging.Formatter):
    """Render log records as one-line JSON for ingestion by log shippers."""

    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
                  + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        tid = getattr(record, "trace_id", None)
        if tid:
            payload["trace_id"] = tid
        cid = getattr(record, "chat_id", None)
        if cid:
            payload["chat_id"] = cid
        conv = getattr(record, "conversation_id", None)
        if conv:
            payload["conversation_id"] = conv
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging() -> None:
    """Install the context filter + (optionally) JSON formatter on the root
    handlers. Safe to call multiple times."""
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    root = logging.getLogger()
    root.setLevel(level)

    use_json = os.environ.get("LOG_FORMAT", "").lower() == "json"

    # Ensure at least one handler exists (basicConfig may have added one).
    if not root.handlers:
        root.addHandler(logging.StreamHandler())

    ctx_filter = _ContextFilter()
    for h in root.handlers:
        # Avoid stacking duplicate filters across reloads.
        if not any(isinstance(f, _ContextFilter) for f in h.filters):
            h.addFilter(ctx_filter)
        if use_json:
            h.setFormatter(JsonFormatter())
        else:
            h.setFormatter(logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s [trace=%(trace_id)s] %(message)s"
            ))
