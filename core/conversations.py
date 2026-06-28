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

We also tag conversations with the BrowserAI user_id so /api/cloud and
admin tools can audit / clean up later.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional, Tuple


def _safe_chat_id(chat_id: str) -> str:
    """Sanitize chat_id for use in filesystem paths."""
    raw = str(chat_id or "").strip()
    safe = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in raw)
    return safe[:96] or "default"

import httpx

from core.database import get_conn

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
        # Some statuses imply dead conv we shouldn't reuse
        if body.get("conversation_status") in ("ERROR", "DELETED"):
            return False
        return True
    except Exception as e:
        log.warning("conversation_alive probe failed for %s: %s", cid, e)
        return False


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
    and the initial_message was provided through initial_user_msg; the
    caller should NOT also POST /message.

    `was_created=False` means we reused an existing conversation; the
    caller MUST POST /message with the user's text. The returned
    `last_event_id_at_send_time` is the highest event id observed BEFORE
    the new message — so polling can fetch only the response.
    """
    mapping = get_mapping(chat_id) if chat_id else None
    if mapping:
        cid = mapping["conversation_id"]
        if await conversation_alive(client, oh_url, cid):
            # Capture current max event id BEFORE posting the new message,
            # so polling can skip everything that's already part of prior turns.
            last_id = mapping.get("last_event_id", -1) or -1
            try:
                # OpenHands main v0.59: /events?start_id is broken AND
                # limit is capped at 100. We use reverse=true so the LATEST
                # events come first, take id of first one as the watermark.
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

            # POST the new user message into the existing conversation
            r = await client.post(
                f"{oh_url}/api/conversations/{cid}/message",
                json={"message": initial_message},
                timeout=15.0,
            )
            if r.status_code >= 400:
                log.warning(
                    "POST /message failed (%s) for cid=%s; rotating conversation",
                    r.status_code,
                    cid,
                )
                drop_mapping(chat_id)
            else:
                return cid, False, last_id
        else:
            log.info("stale mapping for chat_id=%s cid=%s — recreating", chat_id, cid)
            drop_mapping(chat_id)

    # Push per-chat workspace isolation: mount only this chat's directory as /workspace
    # This ensures each conversation's runtime sees ONLY its own files.
    safe_id = _safe_chat_id(chat_id) if chat_id else ""
    if safe_id:
        chat_host_path = f"/opt/browserai-data/workspace/chats/{safe_id}"
        # Ensure the directory exists on the host
        import os
        os.makedirs(chat_host_path, exist_ok=True)
        # Write a per-chat config.toml that overrides sandbox.volumes
        _write_oh_sandbox_volumes( f"{chat_host_path}:/workspace:rw")

    # Create fresh conversation
    payload: Dict[str, Any] = {"initial_user_msg": initial_message or "hi"}
    if conversation_instructions:
        payload["conversation_instructions"] = conversation_instructions
    r = await client.post(f"{oh_url}/api/conversations", json=payload, timeout=30.0)
    r.raise_for_status()
    body = r.json()
    cid = body.get("conversation_id") or body.get("id")
    if not cid:
        raise RuntimeError(f"OpenHands returned no conversation_id: {body}")
    # /start may block for ~60s on cold runtime — caller controls timeout
    try:
        await client.post(
            f"{oh_url}/api/conversations/{cid}/start", json={}, timeout=600.0
        )
    except httpx.TimeoutException:
        log.warning("/start timeout for cid=%s (continuing to poll)", cid)
    if chat_id:
        upsert_mapping(chat_id, cid, user_id)
    return cid, True, -1




def _write_oh_sandbox_volumes(volumes_spec: str) -> None:
    """Write sandbox.volumes into the OpenHands config.toml so the next
    runtime container mounts only the specified path as /workspace.
    This provides per-chat filesystem isolation: each conversation's
    runtime container sees ONLY its own /workspace/chats/{chatId}/ directory.
    
    IMPORTANT: The OH container must have this file mounted as config.toml
    via docker-compose volumes. The file is written at:
      /opt/browserai-data/oh-config.toml (host) -> /app/config.toml (container)
    """
    import logging
    log = logging.getLogger("browserai.conversations")
    try:
        config_path = "/data/oh-config.toml"
        # Escape any special chars in the path
        safe_spec = volumes_spec.replace('\\', '\\\\').replace('"', '\\"')
        with open(config_path, "w") as f:
            f.write(f'[sandbox]\nvolumes = "{safe_spec}"\n')
        log.info("oh-config.toml updated: sandbox.volumes = %s", volumes_spec)
    except Exception as e:
        log.warning("oh-config.toml write error: %s", e)
