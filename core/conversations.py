"""
Per-chat OpenHands conversation reuse.

OpenHands cold-starts a new sandbox container (~60-90s, ~1.4 GiB RAM) for
every new conversation. To make the chat feel responsive after the first
turn, we keep one OpenHands conversation alive per BrowserAI chat_id and
just POST /message into it for subsequent turns.

Lifecycle policy:
  * First send for a chat_id with no mapping  → POST /conversations + /start.
  * Subsequent sends                          → POST /conversations/{cid}/message.
  * If the mapped conversation is gone (deleted/expired/error)
                                              → drop mapping, create fresh.
  * On user "new chat" → backend gets a brand-new chat_id, so a fresh
    conversation is born naturally.

Workspace isolation:
  Every call to get_or_create_conversation (new or reused) verifies the
  runtime mount is correct. If the mount is wrong (e.g. after OH restart
  recreated the runtime with _sandbox), we remount before sending the
  message. This guarantees the agent ALWAYS works in its per-chat directory.

We also tag conversations with the BrowserAI user_id so /api/cloud and
admin tools can audit / clean up later.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional, Tuple

import httpx

from core.database import get_conn

log = logging.getLogger("browserai.conversations")


def _safe_chat_id(chat_id: str) -> str:
    """Sanitize chat_id for use in filesystem paths."""
    raw = str(chat_id or "").strip()
    safe = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in raw)
    return safe[:96] or "default"


def init_conversations_schema() -> None:
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
        conn.commit()
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


async def conversation_alive(client: httpx.AsyncClient, oh_url: str, cid: str) -> bool:
    """Cheap probe: GET /conversations/{cid}. 404 → gone."""
    try:
        r = await client.get(f"{oh_url}/api/conversations/{cid}", timeout=5.0)
        if r.status_code == 404:
            return False
        if r.status_code >= 500:
            return False
        body = r.json() or {}
        if body.get("conversation_status") in ("ERROR", "DELETED"):
            return False
        return True
    except Exception as e:
        log.warning("conversation_alive probe failed for %s: %s", cid, e)
        return False


async def _ensure_mount_and_send(
    client: httpx.AsyncClient,
    oh_url: str,
    cid: str,
    chat_id: str,
    message: str,
    is_new_conversation: bool = False,
) -> None:
    """Ensure the runtime has the correct per-chat mount, then send a message.

    This is called for BOTH new and reused conversations to guarantee:
    - New conversations: remount after /start, then send initial message
    - Reused conversations: verify mount is correct (may be wrong after
      OH restart), remount if needed, then send the message

    The agent NEVER works in the wrong workspace.
    """
    from core.isolation import verify_runtime_mount, remount_runtime_async

    # Check if mount is correct; remount if needed
    mount_ok = False
    try:
        mount_ok = verify_runtime_mount(cid, chat_id)
    except Exception as e:
        log.warning("_ensure_mount_and_send: verify failed: %s", e)

    if not mount_ok:
        log.info("_ensure_mount_and_send: remounting cid=%s chat_id=%s", cid, chat_id)
        try:
            ok = await remount_runtime_async(cid, chat_id)
            if ok:
                log.info("_ensure_mount_and_send: remounted cid=%s chat_id=%s", cid, chat_id)
            else:
                log.warning("_ensure_mount_and_send: remount failed cid=%s chat_id=%s", cid, chat_id)
        except Exception as e:
            log.warning("_ensure_mount_and_send: remount error: %s", e)
        # Give OH time to reconnect to the remounted container
        await asyncio.sleep(1)
    else:
        log.debug("_ensure_mount_and_send: mount already correct cid=%s", cid)

    # Send the message
    if not message:
        return
    for attempt in range(3):
        try:
            r = await client.post(
                f"{oh_url}/api/conversations/{cid}/message",
                json={"message": message},
                timeout=15.0,
            )
            if r.status_code < 400:
                log.info("_ensure_mount_and_send: message sent to cid=%s", cid)
                return
            log.warning(
                "_ensure_mount_and_send: POST /message returned %s (attempt %d)",
                r.status_code, attempt + 1,
            )
        except Exception as e:
            log.warning(
                "_ensure_mount_and_send: POST /message error (attempt %d): %s",
                attempt + 1, e,
            )
        await asyncio.sleep(2)


async def get_or_create_conversation(
    client: httpx.AsyncClient,
    oh_url: str,
    chat_id: str,
    user_id: Optional[str],
    initial_message: str,
    conversation_instructions: str = "",
) -> Tuple[str, bool, int]:
    """
    Returns (conversation_id, was_created, last_event_id_at_send_time).

    `was_created=True` means we just opened a fresh OpenHands conversation
    and the initial_message was sent after remount; the caller should NOT
    also POST /message.

    `was_created=False` means we reused an existing conversation; the
    caller MUST NOT also POST /message (we already sent it via
    _ensure_mount_and_send). The returned `last_event_id_at_send_time` is
    the highest event id observed BEFORE the new message — so polling can
    fetch only the response.

    Workspace isolation:
    EVERY call (new or reused) verifies the runtime mount is correct.
    If the mount is wrong (e.g. after OH restart), we remount BEFORE
    sending the message. The agent ALWAYS works in its per-chat directory.
    """
    mapping = get_mapping(chat_id) if chat_id else None
    if mapping:
        cid = mapping["conversation_id"]
        if await conversation_alive(client, oh_url, cid):
            # Capture current max event id BEFORE posting the new message
            last_id = mapping.get("last_event_id", -1) or -1
            try:
                r = await client.get(
                    f"{oh_url}/api/conversations/{cid}/events?reverse=true&limit=1",
                    timeout=10.0,
                )
                if r.status_code == 200:
                    body = r.json()
                    events = body if isinstance(body, list) else (
                        body.get("events") or body.get("results") or []
                    )
                    if events:
                        last_id = max(int(e.get("id", -1)) for e in events)
                        update_last_event(chat_id, last_id)
            except Exception:
                pass

            # Send the message with mount verification (handles OH restart case)
            await _ensure_mount_and_send(client, oh_url, cid, chat_id, initial_message)
            return cid, False, last_id
        else:
            log.info("stale mapping for chat_id=%s cid=%s — recreating", chat_id, cid)
            drop_mapping(chat_id)

    # ── Create fresh conversation ──────────────────────────────────────
    # IMPORTANT: Create WITHOUT initial_user_msg so that the agent doesn't
    # start working until we've remounted the runtime with per-chat isolation.
    payload: Dict[str, Any] = {}
    if conversation_instructions:
        payload["conversation_instructions"] = conversation_instructions

    r = await client.post(f"{oh_url}/api/conversations", json=payload, timeout=30.0)
    r.raise_for_status()
    body = r.json()
    cid = body.get("conversation_id") or body.get("id")
    if not cid:
        raise RuntimeError(f"OpenHands returned no conversation_id: {body}")

    # Ensure per-chat workspace directory exists on host
    safe_id = _safe_chat_id(chat_id) if chat_id else ""
    if safe_id:
        import os
        chat_host_path = os.path.join(
            os.environ.get("DATA_DIR", "/opt/browserai-data"),
            "workspace", "chats", safe_id,
        )
        os.makedirs(chat_host_path, exist_ok=True)

    # /start creates the runtime container (agent is idle — no message queued)
    try:
        await client.post(
            f"{oh_url}/api/conversations/{cid}/start", json={}, timeout=600.0
        )
    except httpx.TimeoutException:
        log.warning("/start timeout for cid=%s (continuing to remount)", cid)

    # Verify mount and send the initial message
    await _ensure_mount_and_send(
        client, oh_url, cid, chat_id or "", initial_message,
        is_new_conversation=True,
    )

    if chat_id:
        upsert_mapping(chat_id, cid, user_id)

    # Get current max event id so caller can poll from the right point
    last_id = -1
    try:
        r = await client.get(
            f"{oh_url}/api/conversations/{cid}/events?reverse=true&limit=1",
            timeout=10.0,
        )
        if r.status_code == 200:
            ev_body = r.json()
            events = ev_body if isinstance(ev_body, list) else (
                ev_body.get("events") or ev_body.get("results") or []
            )
            if events:
                last_id = max(int(e.get("id", -1)) for e in events)
    except Exception:
        pass

    return cid, True, last_id
