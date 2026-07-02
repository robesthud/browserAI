"""
Per-chat OpenHands conversation reuse.

Phase 2.3: new conversations create WITHOUT initial_user_msg → /start →
POST /message. Workspace mounting is handled by OpenHands config.toml
`sandbox.volumes`; BrowserAI does not remount runtime containers.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Optional, Tuple

import httpx

from core.database import get_conn

log = logging.getLogger("browserai.conversations")


def _safe_chat_id(chat_id: str) -> str:
    raw = str(chat_id or "").strip()
    safe = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in raw)
    return safe[:96] or "default"


_schema_ready = False


def init_conversations_schema(force: bool = False) -> None:
    # Sonnet #5: run the schema/migration work once per process, not on every
    # hot-path call (get_mapping/upsert_mapping/update_last_event...).
    if _schema_ready and not force:
        return
    conn = get_conn()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS chat_conversations (
                chat_id         TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                user_id         TEXT,
                last_event_id   INTEGER NOT NULL DEFAULT -1,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS chat_conv_user ON chat_conversations(user_id);
            CREATE INDEX IF NOT EXISTS chat_conv_cid  ON chat_conversations(conversation_id);
            """
        )
        # Self-healing migration for chat_conversations. See core/migrations.py.
        try:
            from core.migrations import ensure_columns
            ensure_columns(conn, "chat_conversations")
        except Exception:
            pass
        conn.commit()
        globals()["_schema_ready"] = True
    finally:
        conn.close()


def _now() -> int:
    return int(time.time() * 1000)


def get_mapping(chat_id: str) -> Optional[Dict[str, Any]]:
    if not chat_id:
        return None
    init_conversations_schema()
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM chat_conversations WHERE chat_id = ?", (chat_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def upsert_mapping(chat_id: str, conversation_id: str, user_id: Optional[str]) -> None:
    init_conversations_schema()
    now = _now()
    conn = get_conn()
    try:
        conn.execute(
            """
            INSERT INTO chat_conversations
                (chat_id, conversation_id, user_id, last_event_id, created_at, updated_at)
            VALUES (?, ?, ?, -1, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
                conversation_id = excluded.conversation_id,
                user_id         = excluded.user_id,
                last_event_id   = -1,
                updated_at      = excluded.updated_at
            """,
            (chat_id, conversation_id, user_id or "", now, now),
        )
        conn.commit()
    finally:
        conn.close()


def update_last_event(chat_id: str, last_event_id: int) -> None:
    if not chat_id:
        return
    init_conversations_schema()
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE chat_conversations SET last_event_id = ?, updated_at = ? WHERE chat_id = ?",
            (last_event_id, _now(), chat_id),
        )
        conn.commit()
    finally:
        conn.close()


def drop_mapping(chat_id: str) -> None:
    if not chat_id:
        return
    init_conversations_schema()
    conn = get_conn()
    try:
        conn.execute("DELETE FROM chat_conversations WHERE chat_id = ?", (chat_id,))
        conn.commit()
    finally:
        conn.close()


async def conversation_status(client: httpx.AsyncClient, oh_url: str, cid: str) -> str:
    """Probe an OpenHands conversation and classify the result (Sonnet #8).

    Returns one of:
      "alive"   — conversation exists and is usable.
      "gone"    — confirmed absent (404, JSON null, ERROR/DELETED status). Safe
                  to drop the local mapping and start fresh.
      "unknown" — transport error / 5xx / timeout. The conversation MIGHT still
                  exist (OpenHands restart, brief overload); the caller must NOT
                  drop the mapping — that would permanently discard history on a
                  transient blip. Retry/backoff instead.
    """
    try:
        r = await client.get(f"{oh_url}/api/conversations/{cid}", timeout=5.0)
        if r.status_code == 404:
            return "gone"
        if r.status_code >= 500:
            return "unknown"  # transient: OH overloaded/restarting
        body = r.json() or {}
        if not isinstance(body, dict):
            return "gone"
        # OpenHands can return HTTP 200 with JSON null for conversations that
        # disappeared after container restart. Treat that as confirmed gone.
        if not (body.get("conversation_id") or body.get("id") or body.get("conversation_status")):
            return "gone"
        if body.get("conversation_status") in ("ERROR", "DELETED"):
            return "gone"
        return "alive"
    except Exception as e:
        # Transport error (connection reset, timeout, DNS). NOT proof the
        # conversation is gone — could be an OpenHands restart mid-request.
        log.warning("conversation_status probe transient error for %s: %s", cid, e)
        return "unknown"


async def conversation_alive(client: httpx.AsyncClient, oh_url: str, cid: str) -> bool:
    """Back-compat boolean wrapper. Treats "unknown" (transient) as alive so a
    blip never triggers mapping deletion via this path."""
    return (await conversation_status(client, oh_url, cid)) != "gone"


async def _send_initial_message(
    client: httpx.AsyncClient,
    oh_url: str,
    cid: str,
    initial_message: str,
) -> None:
    """Send the initial user message after OpenHands has started the runtime."""
    if not initial_message:
        return
    # Give OH a short moment to attach after /start. The old Docker remount hack
    # needed this too; now it is only a startup grace period.
    await asyncio_sleep(1)
    for attempt in range(3):
        try:
            r = await client.post(
                f"{oh_url}/api/conversations/{cid}/message",
                json={"message": initial_message},
                timeout=15.0,
            )
            if r.status_code < 400:
                log.info("_send_initial_message: message sent to cid=%s", cid)
                return
            log.warning(
                "_send_initial_message: POST /message returned %s (attempt %d)",
                r.status_code,
                attempt + 1,
            )
        except Exception as e:
            log.warning(
                "_send_initial_message: POST /message error (attempt %d): %s",
                attempt + 1,
                e,
            )
        await asyncio_sleep(2)


async def asyncio_sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)


async def get_or_create_conversation(
    client: httpx.AsyncClient,
    oh_url: str,
    chat_id: str,
    user_id: Optional[str],
    initial_message: str,
    conversation_instructions: str = "",
    turn_id: str = "",
) -> Tuple[str, bool, int]:
    """Returns (conversation_id, was_created, last_event_id).

    If turn_id is provided and matches the last_turn_id stored in
    agent_runs (and the run is still in 'running' status), the user
    message is NOT re-sent to OpenHands — the previous delivery is
    assumed to still be in flight.  This prevents duplicate user
    messages on client-side retries after connection drops.
    """
    from core.agent_state import get_run

    mapping = get_mapping(chat_id) if chat_id else None
    if mapping:
        cid = mapping["conversation_id"]
        status = await conversation_status(client, oh_url, cid)
        if status == "unknown":
            # Sonnet #8: transient OpenHands error (5xx / restart / timeout). Do
            # NOT drop the mapping — that would permanently discard conversation
            # history on a blip. Keep the mapping and signal a retryable error so
            # the client reconnects to the SAME conversation.
            raise RuntimeError(
                f"OpenHands temporarily unavailable for conversation {cid}; "
                "keeping mapping, retry shortly"
            )
        if status == "alive":
            last_id = mapping.get("last_event_id", -1) or -1
            # NOTE (seam-hardening, Sonnet review #1): we intentionally do NOT
            # peek OpenHands' latest event id and write it back here. Doing so
            # advanced chat_conversations.last_event_id past the unseen tail of a
            # previously-broken stream — silently reopening the Bug 2.2 event-loss
            # class right next to the done-gated fix in _stream_chat. This path is
            # now READ-ONLY for the cursor; _stream_chat is the single writer.

            # Idempotency guard: if the same turn_id was already accepted
            # and the run is still in-flight, skip re-sending the message.
            # This prevents duplicate prompts on client retries after
            # connection drops (common on flaky mobile networks).
            if turn_id and chat_id:
                run = get_run(chat_id)
                if (run
                    and run.get("last_turn_id") == turn_id
                    and run.get("status") in ("running", "paused", "awaiting_input")):
                    log.info("duplicate turn_id=%s for chat_id=%s — skipping re-send", turn_id, chat_id)
                    return cid, False, last_id

            # Reused conversation — mount already set from init
            r = await client.post(
                f"{oh_url}/api/conversations/{cid}/message",
                json={"message": initial_message},
                timeout=15.0,
            )
            if r.status_code >= 400:
                log.warning("POST /message failed (%s) for cid=%s; rotating", r.status_code, cid)
                drop_mapping(chat_id)
            else:
                return cid, False, last_id
        else:
            log.info("stale mapping for chat_id=%s cid=%s — recreating", chat_id, cid)
            drop_mapping(chat_id)

    # ── Create fresh conversation ──────────────────────────────────────
    # Phase 2.3 removed the runtime-remount gap. Send the first user message as
    # OpenHands' native `initial_user_msg` so it is queued into the agent loop
    # after the runtime is actually ready. Posting `/message` while the runtime
    # is still loading can be recorded as a user event but never processed.
    payload: Dict[str, Any] = {}
    if conversation_instructions:
        payload["conversation_instructions"] = conversation_instructions
    if initial_message:
        payload["initial_user_msg"] = initial_message

    safe_id = _safe_chat_id(chat_id) if chat_id else ""
    if safe_id:
        chat_host_path = os.path.join(
            os.environ.get("DATA_DIR", "/opt/browserai-data"),
            "workspace", "chats", safe_id,
        )
        os.makedirs(chat_host_path, exist_ok=True)

    r = await client.post(f"{oh_url}/api/conversations", json=payload, timeout=600.0)
    r.raise_for_status()
    body = r.json()
    cid = body.get("conversation_id") or body.get("id")
    if not cid:
        raise RuntimeError(f"OpenHands returned no conversation_id: {body}")

    if chat_id:
        upsert_mapping(chat_id, cid, user_id)

    # New conversation events all belong to this first turn; stream from the
    # beginning and let BrowserAI drop the echoed user message in _translate_event.
    return cid, True, -1
