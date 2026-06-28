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
) -> Tuple[str, bool, int]:
    """Returns (conversation_id, was_created, last_event_id)."""

    mapping = get_mapping(chat_id) if chat_id else None
    if mapping:
        cid = mapping["conversation_id"]
        if await conversation_alive(client, oh_url, cid):
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
    payload: Dict[str, Any] = {}
    if conversation_instructions:
        payload["conversation_instructions"] = conversation_instructions

    r = await client.post(f"{oh_url}/api/conversations", json=payload, timeout=30.0)
    r.raise_for_status()
    body = r.json()
    cid = body.get("conversation_id") or body.get("id")
    if not cid:
        raise RuntimeError(f"OpenHands returned no conversation_id: {body}")

    safe_id = _safe_chat_id(chat_id) if chat_id else ""
    if safe_id:
        chat_host_path = os.path.join(
            os.environ.get("DATA_DIR", "/opt/browserai-data"),
            "workspace", "chats", safe_id,
        )
        os.makedirs(chat_host_path, exist_ok=True)

    try:
        await client.post(
            f"{oh_url}/api/conversations/{cid}/start", json={}, timeout=600.0
        )
    except httpx.TimeoutException:
        log.warning("/start timeout for cid=%s (continuing to remount)", cid)

    # Workspace mounting is configured in OpenHands config.toml; just send message.
    await _send_initial_message(client, oh_url, cid, initial_message)

    if chat_id:
        upsert_mapping(chat_id, cid, user_id)

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
