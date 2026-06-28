"""
Per-chat OpenHands conversation reuse.

Workspace isolation:
  Every call to get_or_create_conversation (new or reused) verifies the
  runtime mount is correct. If the mount is wrong (e.g. after OH restart
  recreated the runtime with _sandbox), we remount before sending the
  message. This guarantees the agent ALWAYS works in its per-chat directory.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from core.database import get_conn
from core.utils import safe_chat_id, CHAT_WORKSPACE_ROOT

# Backward-compatible alias
_safe_chat_id = safe_chat_id

log = logging.getLogger("browserai.conversations")


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


def get_all_mappings() -> List[Dict[str, Any]]:
    """Return all chat→conversation mappings. Used by startup cleanup."""
    init_conversations_schema()
    conn = get_conn()
    try:
        rows = conn.execute("SELECT * FROM chat_conversations").fetchall()
        return [dict(r) for r in rows]
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

    Called for BOTH new and reused conversations to guarantee the agent
    NEVER works in the wrong workspace.
    """
    from core.isolation import verify_runtime_mount, remount_runtime_async

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
        await asyncio.sleep(1)
    else:
        log.debug("_ensure_mount_and_send: mount already correct cid=%s", cid)

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

    `was_created=True` → caller should NOT also POST /message.
    `was_created=False` → caller MUST NOT also POST /message (already sent).

    Workspace isolation:
    EVERY call verifies the runtime mount. If wrong (e.g. after OH restart),
    we remount BEFORE sending the message.
    """
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

            await _ensure_mount_and_send(client, oh_url, cid, chat_id, initial_message)
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

    # Ensure per-chat workspace directory exists on host
    safe_id = safe_chat_id(chat_id) if chat_id else ""
    if safe_id:
        chat_host_path = os.path.join(CHAT_WORKSPACE_ROOT, safe_id)
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
