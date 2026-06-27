"""
BrowserAI ↔ OpenHands core monolith (Step 2).

This server is a thin FastAPI app that:
  * Serves the legacy BrowserAI React UI from /app/ui/dist.
  * Exposes the BrowserAI HTTP API contract that the UI expects
    (/api/health, /api/settings, /api/keys, /api/params, /api/chat,
    /api/agent/chat, /api/agent/chat/stop, /api/auth/me, /api/cloud, ...).
  * Bridges agent chats to an OpenHands Agent Server, translating
    OpenHands events into the SSE event stream the BrowserAI UI parses.

Goals for Step 2:
  1. /api/health returns {ok: true, ...} so the UI exits its offline mode.
  2. /api/agent/chat accepts the UI's body shape, pushes the picked LLM to
     OpenHands settings per-call, creates conversation, polls events,
     and emits well-formed SSE for the UI.
  3. CORS configured for credentials (no wildcard).
  4. Stub endpoints (auth/cloud/workspace/...) return safe shapes so the UI
     does not error-out before later steps fill them in.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from core.database import (
    delete_key,
    get_active_key,
    list_keys,
    set_active_key,
    upsert_key,
)
from core.auth import (
    SESSION_COOKIE_NAME,
    check_registration_allowed,
    clear_session_cookie,
    cloud_load,
    cloud_save,
    create_session,
    create_user,
    current_user,
    get_user_by_email,
    init_auth_schema,
    revoke_session,
    set_session_cookie,
    _verify_password,
)

log = logging.getLogger("browserai.core")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

OPENHANDS_SERVER = os.environ.get("OPENHANDS_AGENT_SERVER", "http://openhands:18000")
DEFAULT_MODEL = os.environ.get("BROWSERAI_DEFAULT_MODEL", "glm-4.5-flash")
DEFAULT_BASE_URL = os.environ.get(
    "OPENHANDS_LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"
)
APP_URL = os.environ.get("APP_URL", "http://localhost")
MAX_AGENT_ITERATIONS = int(os.environ.get("BROWSERAI_AGENT_MAX_ITERATIONS", "50"))
EVENT_POLL_INTERVAL = float(os.environ.get("BROWSERAI_EVENT_POLL_INTERVAL", "0.6"))
EVENT_POLL_TIMEOUT_S = int(os.environ.get("BROWSERAI_EVENT_POLL_TIMEOUT_S", "900"))

app = FastAPI(title="BrowserAI-OpenHands Core Monolith", version="0.3.0")


@app.on_event("startup")
async def _startup_init() -> None:
    try:
        init_auth_schema()
        log.info("auth schema ready")
    except Exception as e:
        log.error("auth init failed: %s", e)

# CORS: must NOT be wildcard when allow_credentials is true, otherwise cookies
# are silently dropped by browsers.
_cors_origins = [APP_URL.rstrip("/")]
if "localhost" not in APP_URL:
    _cors_origins += ["http://localhost:5173", "http://127.0.0.1:5173"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _resolve_provider(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Reconstruct provider config from UI body. The UI flattens fields directly
    onto the request body of /api/agent/chat:
      keyId, useStoredSecret, baseUrl, apiKey, authType, authHeader,
      extraHeaders, model, temperature
    Older code paths may instead send providerInput / provider objects.
    Fallback: use the DB-active key.
    """
    pi = body.get("providerInput") or body.get("provider")
    if isinstance(pi, dict) and (pi.get("baseUrl") or pi.get("apiKey") or pi.get("keyId")):
        return pi

    flat = {
        "keyId": body.get("keyId"),
        "useStoredSecret": body.get("useStoredSecret"),
        "baseUrl": body.get("baseUrl"),
        "apiKey": body.get("apiKey"),
        "authType": body.get("authType"),
        "authHeader": body.get("authHeader"),
        "extraHeaders": body.get("extraHeaders"),
        "model": body.get("model"),
        "temperature": body.get("temperature"),
    }
    if any(flat.values()):
        # Resolve stored secret if requested
        if flat.get("useStoredSecret") and flat.get("keyId"):
            stored = next((k for k in list_keys() if k["id"] == flat["keyId"]), None)
            if stored:
                flat["apiKey"] = stored.get("apiKey") or flat.get("apiKey")
                flat["baseUrl"] = flat.get("baseUrl") or stored.get("baseUrl")
                flat["model"] = flat.get("model") or stored.get("model")
        return flat

    # Last resort: DB-active key
    active = get_active_key() or {}
    return {
        "keyId": active.get("id"),
        "useStoredSecret": True,
        "baseUrl": active.get("baseUrl") or DEFAULT_BASE_URL,
        "apiKey": active.get("apiKey") or os.environ.get("BIGMODEL_API_KEY", ""),
        "model": active.get("model") or DEFAULT_MODEL,
    }


def _qualify_model(base_url: str, model: str) -> str:
    """LiteLLM (used inside OpenHands) needs `openai/<model>` for any
    OpenAI-compatible-but-not-OpenAI endpoint."""
    if not model:
        return f"openai/{DEFAULT_MODEL}"
    if "/" in model:
        return model
    if any(host in (base_url or "") for host in ("bigmodel.cn", "api.z.ai", "deepseek.com")):
        return f"openai/{model}"
    return model


def _history_to_prompt(history: List[Dict[str, Any]]) -> str:
    """Find the latest user turn to drive OpenHands. We do NOT replay history
    into OpenHands every call — instead the UI maintains its own chat thread
    and we open a fresh conversation per send. (Multi-turn within one
    OpenHands conversation will be added in Step 6 along with /api/agent/answer.)"""
    for m in reversed(history or []):
        role = m.get("role")
        content = m.get("content")
        if role == "user" and content:
            if isinstance(content, list):
                # OpenAI vision-style; concat text parts
                text = " ".join(
                    p.get("text", "") for p in content if isinstance(p, dict)
                )
                if text:
                    return text
            elif isinstance(content, str):
                return content
    return ""


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ─────────────────────────────────────────────────────────────────────────────
# Health / settings / keys / params
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/health")
async def get_health():
    # Critical: UI checks `data.ok` to decide online/offline. Without it the
    # whole app falls back to localStorage and CloudSync never fires.
    return {
        "ok": True,
        "engine": "openhands",
        "monolith": True,
        "openhands": True,
        "deepseekManaged": False,
        "sandbox": True,
        "browser": True,
    }


@app.get("/api/settings")
@app.get("/api/keys")
async def get_settings():
    keys = list_keys()
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {
        "keys": keys,
        "activeKeyId": active["id"] if active else None,
        "params": {
            "systemPrompt": "Ты — точный и прямой ассистент.",
            "temperature": 0.7,
            "stream": True,
            "useWebAI": False,
        },
        "vault": {"enabled": False, "locked": False},
    }


@app.post("/api/keys")
async def post_key(request: Request):
    data = await request.json()
    if not data.get("id"):
        raise HTTPException(status_code=400, detail="id required")
    keys = upsert_key(data)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None}


@app.post("/api/keys/{key_id}/activate")
async def activate_key(key_id: str):
    keys = set_active_key(key_id)
    return {"keys": keys, "activeKeyId": key_id}


@app.delete("/api/keys/{key_id}")
async def remove_key(key_id: str):
    keys = delete_key(key_id)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None}


@app.put("/api/params")
async def put_params(request: Request):
    # Persisting params (systemPrompt, temperature, stream, useWebAI) per-user
    # is part of Step 3 (auth). For now we just echo.
    data = await request.json()
    return {"ok": True, "params": data}


# ─────────────────────────────────────────────────────────────────────────────
# Auth + per-user cloud sync (Step 3)
# ─────────────────────────────────────────────────────────────────────────────


def _user_public(user: Dict[str, Any]) -> Dict[str, Any]:
    """Strip secrets from a user row before returning to client."""
    return {
        "id": user.get("id"),
        "email": user.get("email"),
        "role": user.get("role") or "user",
        "createdAt": user.get("created_at") or user.get("createdAt"),
    }


@app.get("/api/auth/me")
async def auth_me(request: Request):
    user = current_user(request)
    if not user:
        return JSONResponse({"authenticated": False, "user": None}, status_code=200)
    return {"authenticated": True, "user": _user_public(user)}


@app.post("/api/auth/register")
async def auth_register(request: Request, response: Response):
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not email or not password:
        raise HTTPException(status_code=400, detail="email и password обязательны")

    allowed, default_role = check_registration_allowed(request)
    if not allowed:
        raise HTTPException(
            status_code=403,
            detail="Регистрация закрыта. Нужен X-Registration-Secret.",
        )

    user = create_user(email, password, role=default_role)
    sid = create_session(user["id"], request)
    set_session_cookie(response, sid)
    log.info("registered user %s (role=%s)", email, user["role"])
    return {"authenticated": True, "user": _user_public(user)}


@app.post("/api/auth/login")
async def auth_login(request: Request, response: Response):
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    user = get_user_by_email(email)
    if not user or not _verify_password(password, user.get("password_hash", "")):
        # Generic message — do not leak whether email exists.
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    sid = create_session(user["id"], request)
    set_session_cookie(response, sid)
    return {"authenticated": True, "user": _user_public(user)}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    user = current_user(request)
    if user and user.get("_session_id"):
        revoke_session(user["_session_id"])
    clear_session_cookie(response)
    return {"ok": True}


# ─── Password recovery: stubs that return 200 so UI doesn't error.
# Real email / SMS delivery is a Step-9 concern.


@app.post("/api/auth/forgot-password")
async def auth_forgot(request: Request):
    return {
        "ok": True,
        "message": "Если такой email существует, на него отправлено письмо. (Email-доставка ещё не настроена в этом окружении.)",
    }


@app.post("/api/auth/reset-password")
async def auth_reset():
    raise HTTPException(status_code=501, detail="reset_password_not_configured")


@app.post("/api/auth/sms-send")
@app.post("/api/auth/sms-verify")
@app.put("/api/auth/phone")
async def auth_sms_stub():
    raise HTTPException(status_code=501, detail="sms_provider_not_configured")


# ─── Cloud sync (per-user settings + chats)


@app.get("/api/cloud")
async def cloud_get(request: Request):
    user = current_user(request)
    if not user:
        # Allow anon read with empty payload so UI's CloudSync doesn't crash.
        return {"settings": None, "chats": None, "updatedAt": 0}
    return cloud_load(user["id"])


@app.put("/api/cloud")
async def cloud_put(request: Request):
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="auth_required")
    body = await request.json()
    return cloud_save(user["id"], body.get("settings"), body.get("chats"))


# ─────────────────────────────────────────────────────────────────────────────
# OpenHands bridge — agent chat with proper SSE
# ─────────────────────────────────────────────────────────────────────────────


async def _push_oh_settings(
    client: httpx.AsyncClient,
    provider: Dict[str, Any],
) -> None:
    """Push the chosen LLM into the OpenHands global Settings before each
    conversation. OpenHands consults global Settings when initialising a
    new agent loop."""
    base_url = provider.get("baseUrl") or DEFAULT_BASE_URL
    raw_model = provider.get("model") or DEFAULT_MODEL
    api_key = provider.get("apiKey") or os.environ.get("BIGMODEL_API_KEY", "")
    payload = {
        "agent": "CodeActAgent",
        "llm_model": _qualify_model(base_url, raw_model),
        "llm_api_key": api_key,
        "llm_base_url": base_url,
        "max_iterations": MAX_AGENT_ITERATIONS,
        "confirmation_mode": False,
        "enable_default_condenser": True,
    }
    try:
        r = await client.post(
            f"{OPENHANDS_SERVER}/api/settings", json=payload, timeout=10.0
        )
        if r.status_code >= 400:
            log.warning("OpenHands settings push %s: %s", r.status_code, r.text[:300])
    except Exception as e:
        log.warning("OpenHands settings push error: %s", e)


async def _create_and_start(
    client: httpx.AsyncClient,
    prompt: str,
    extra_system: str = "",
) -> str:
    payload: Dict[str, Any] = {"initial_user_msg": prompt or "hi"}
    if extra_system:
        payload["conversation_instructions"] = extra_system

    r = await client.post(
        f"{OPENHANDS_SERVER}/api/conversations", json=payload, timeout=30.0
    )
    if r.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"OpenHands conversation init failed: {r.status_code} {r.text}",
        )
    body = r.json()
    cid = body.get("conversation_id") or body.get("id")
    if not cid:
        raise HTTPException(
            status_code=502, detail=f"OpenHands returned no conversation_id: {body}"
        )

    # `/start` may take a long time on cold runtime (image build).
    # Use a generous timeout to ride through it.
    try:
        await client.post(
            f"{OPENHANDS_SERVER}/api/conversations/{cid}/start",
            json={},
            timeout=600.0,
        )
    except httpx.TimeoutException:
        log.warning("OpenHands /start timed out for %s — continuing to poll", cid)
    return cid


import re as _re

_THINK_PAIR_RE = _re.compile(r"<think>(.*?)</think>", _re.DOTALL)
_THINK_LEADING_RE = _re.compile(r"^(.*?)</think>\s*", _re.DOTALL)


def _split_think(text: str) -> tuple[str, str]:
    """Return (thinking, final). Handles both paired <think>...</think>
    blocks AND the GLM/DeepSeek style where the model omits the opening
    <think> and only emits a closing </think> before the real answer."""
    if not text:
        return "", ""
    thoughts_parts: list[str] = []

    # Case 1: explicit paired blocks
    for m in _THINK_PAIR_RE.findall(text):
        thoughts_parts.append(m)
    cleaned = _THINK_PAIR_RE.sub("", text)

    # Case 2: leading "...</think>" (implicit opening think)
    m = _THINK_LEADING_RE.match(cleaned)
    if m:
        thoughts_parts.append(m.group(1))
        cleaned = cleaned[m.end():]

    return "\n".join(t.strip() for t in thoughts_parts if t.strip()), cleaned.strip()


def _translate_event(evt: Dict[str, Any], step: int) -> List[Dict[str, Any]]:
    """
    Map an OpenHands v0.59 event dict into one or more SSE events that the
    BrowserAI UI understands.

    Real OpenHands event shape (observed against openhands:main v0.59.0):
        {
          "id": int,
          "timestamp": iso8601,
          "source": "agent" | "user" | "environment",
          "message": str,                       # human-readable summary
          "action": "message"|"recall"|"run"|"read"|"write"|...,
          "observation": "agent_state_changed"|"recall"|"run"|"read"|...,
          "content": str,
          "args": { command, content, path, ... },
          "extras": { agent_state, exit_code, path, ... },
          "llm_metrics": {...},                 # only for agent messages
          "cause": int,                         # id of action this obs answers
          "tool_call_metadata": {...},
        }

    The exact "kind" depends on whether the event carries an `action` or
    `observation` discriminator (they are mutually exclusive top-level strings,
    not nested dicts in this version).
    """
    out: List[Dict[str, Any]] = []

    src = evt.get("source", "")
    action_kind = evt.get("action") if isinstance(evt.get("action"), str) else None
    obs_kind = evt.get("observation") if isinstance(evt.get("observation"), str) else None
    args = evt.get("args") or {}
    extras = evt.get("extras") or {}
    content = evt.get("content") or ""
    message = evt.get("message") or ""

    # ── 0. Drop pure-noise events the UI does not need to render
    #      (system prompt echo, user echo, internal state change action,
    #      condenser book-keeping, etc.)
    if action_kind == "system":
        return out  # system prompt — not for UI
    if src == "user" and action_kind == "message":
        return out  # user's own message — already shown by UI
    if action_kind == "change_agent_state":
        return out  # observation event below covers this
    if action_kind == "condensation" or obs_kind == "condensation":
        return out  # internal condenser

    # ── 1. agent_state_changed → expose phase to UI
    if obs_kind == "agent_state_changed":
        state = extras.get("agent_state") or ""
        phase_map = {
            "loading": "boot",
            "init": "boot",
            "running": "execute",
            "awaiting_user_input": "done",
            "finished": "done",
            "stopped": "done",
            "error": "error",
        }
        phase = phase_map.get(state, state or "execute")
        out.append({"event": "agent_state", "data": {"step": step, "phase": phase, "raw": state}})
        return out

    # ── 2. assistant message (final or intermediate)
    if src == "agent" and action_kind == "message":
        raw = (args.get("content") if isinstance(args, dict) else None) or message or content
        thoughts, final = _split_think(raw)
        if thoughts:
            out.append({"event": "thinking_delta", "data": {"step": step, "chunk": thoughts}})
            out.append({"event": "thought", "data": {"step": step, "text": thoughts}})
        if final:
            out.append({"event": "assistant_delta", "data": {"step": step, "chunk": final}})
        return out

    # ── 3. agent thought / thinking
    if action_kind == "think" or extras.get("thought"):
        text = (args or {}).get("thought") or extras.get("thought") or content or ""
        if text:
            out.append({"event": "thinking_delta", "data": {"step": step, "chunk": text}})
            out.append({"event": "thought", "data": {"step": step, "text": text}})
        return out

    # ── 4. recall: usually an internal lookup, surface as a tiny tool card
    if action_kind == "recall":
        query = (args or {}).get("query") or content or ""
        out.append(
            {"event": "tool_start", "data": {"step": step, "name": "recall", "args": {"query": query}}}
        )
        return out
    if obs_kind == "recall":
        out.append(
            {
                "event": "tool_result",
                "data": {"step": step, "name": "recall", "ok": True, "result": content or message},
            }
        )
        return out

    # ── 5. bash / run / execute_bash
    if action_kind in ("run", "execute_bash", "run_ipython"):
        cmd = (args or {}).get("command") or (args or {}).get("code") or content or ""
        out.append(
            {"event": "tool_start", "data": {"step": step, "name": "bash", "args": {"command": cmd}}}
        )
        return out
    if obs_kind in ("run", "execute_bash", "run_ipython"):
        exit_code = int(extras.get("exit_code", 0) or 0)
        out.append(
            {
                "event": "tool_result",
                "data": {
                    "step": step,
                    "name": "bash",
                    "ok": exit_code == 0,
                    "result": content,
                    "error": content if exit_code != 0 else None,
                },
            }
        )
        return out

    # ── 6. file edit / write
    if action_kind in ("write", "edit", "str_replace_editor"):
        path = (args or {}).get("path") or (args or {}).get("file") or ""
        out.append(
            {"event": "tool_start", "data": {"step": step, "name": "write_file", "args": {"path": path}}}
        )
        return out
    if obs_kind in ("write", "edit"):
        out.append(
            {
                "event": "tool_result",
                "data": {
                    "step": step,
                    "name": "write_file",
                    "ok": True,
                    "result": {"path": extras.get("path", ""), "success": True},
                },
            }
        )
        return out

    # ── 7. file read
    if action_kind in ("read",):
        path = (args or {}).get("path") or ""
        out.append(
            {"event": "tool_start", "data": {"step": step, "name": "read_file", "args": {"path": path}}}
        )
        return out
    if obs_kind in ("read",):
        out.append(
            {
                "event": "tool_result",
                "data": {
                    "step": step,
                    "name": "read_file",
                    "ok": True,
                    "result": {"path": extras.get("path", ""), "content": content},
                },
            }
        )
        return out

    # ── 8. browse
    if action_kind in ("browse", "browse_interactive"):
        url = (args or {}).get("url") or content or ""
        out.append(
            {"event": "tool_start", "data": {"step": step, "name": "browser", "args": {"url": url}}}
        )
        return out
    if obs_kind in ("browse",):
        out.append(
            {
                "event": "tool_result",
                "data": {"step": step, "name": "browser", "ok": True, "result": content[:2000]},
            }
        )
        return out

    # ── 9. error
    if obs_kind == "error" or evt.get("error"):
        err = content or message or "engine error"
        out.append({"event": "error", "data": {"message": err}})
        return out

    # ── 10. unknown event: silently swallow (logged on server) so the UI
    #       does not get spammed with system internals
    log.debug(
        "unknown OpenHands event: src=%s action=%s obs=%s msg=%s",
        src,
        action_kind,
        obs_kind,
        (message or content)[:120],
    )
    return out


async def _stream_chat(
    chat_id: str,
    model: str,
    prompt: str,
    extra_system: str,
    provider: Dict[str, Any],
) -> AsyncIterator[bytes]:
    step = 0
    full_answer = ""
    turn_complete = False  # set as soon as OpenHands emits awaiting_user_input

    # 1) Send stream protocol + initial agent_context up-front so the UI shows
    #    activity even while OpenHands is cold-booting a runtime image.
    yield _sse(
        "stream_protocol",
        {
            "version": 1,
            "events": [
                "stream_protocol",
                "agent_context",
                "agent_state",
                "thinking",
                "thinking_delta",
                "thought",
                "tool_preview",
                "tool_start",
                "tool_progress",
                "tool_result",
                "assistant_delta",
                "assistant",
                "done",
                "error",
            ],
        },
    ).encode("utf-8")
    yield _sse(
        "agent_context",
        {
            "model": model or DEFAULT_MODEL,
            "provider": provider.get("baseUrl") or DEFAULT_BASE_URL,
            "maxSteps": MAX_AGENT_ITERATIONS,
            "serverRoute": "/api/agent/chat",
            "engine": "openhands",
        },
    ).encode("utf-8")
    yield _sse("thinking", {"step": 1}).encode("utf-8")
    yield _sse(
        "agent_state",
        {"phase": "plan", "step": 1, "maxSteps": MAX_AGENT_ITERATIONS, "engine": "openhands"},
    ).encode("utf-8")

    # 2) Push settings + create conversation
    async with httpx.AsyncClient() as client:
        try:
            await _push_oh_settings(client, provider)
            cid = await _create_and_start(client, prompt, extra_system)
        except HTTPException as e:
            yield _sse("error", {"message": str(e.detail)}).encode("utf-8")
            yield _sse("done", {"reason": "engine-error", "steps": step}).encode("utf-8")
            return
        except Exception as e:
            yield _sse("error", {"message": f"OpenHands bridge: {e}"}).encode("utf-8")
            yield _sse("done", {"reason": "engine-error", "steps": step}).encode("utf-8")
            return

        # 3) Poll events
        seen_ids: set = set()
        t0 = time.time()
        last_event_ts = time.time()
        done = False

        while not done and (time.time() - t0) < EVENT_POLL_TIMEOUT_S:
            try:
                r = await client.get(
                    f"{OPENHANDS_SERVER}/api/conversations/{cid}/events", timeout=20.0
                )
                if r.status_code == 404:
                    # Conversation gone
                    yield _sse("error", {"message": "OpenHands conversation lost"}).encode("utf-8")
                    break
                if r.status_code >= 400:
                    await asyncio.sleep(EVENT_POLL_INTERVAL)
                    continue
                body = r.json()
                events = body if isinstance(body, list) else (body.get("events") or body.get("results") or [])
                new_events = [e for e in events if e.get("id") not in seen_ids]
                for e in new_events:
                    seen_ids.add(e.get("id"))
                    last_event_ts = time.time()
                    # End-of-turn signal from OpenHands itself
                    if (
                        e.get("observation") == "agent_state_changed"
                        and (e.get("extras") or {}).get("agent_state")
                        in ("awaiting_user_input", "finished", "stopped", "error")
                    ):
                        turn_complete = True
                    for translated in _translate_event(e, step + 1):
                        ev_name = translated["event"]
                        ev_data = translated["data"]
                        if ev_name == "tool_start":
                            step += 1
                            ev_data["step"] = step
                        if ev_name == "assistant_delta":
                            full_answer += ev_data.get("chunk", "")
                        yield _sse(ev_name, ev_data).encode("utf-8")
            except httpx.TimeoutException:
                pass
            except Exception as e:
                log.warning("event poll error: %s", e)

            # Primary end-of-turn signal: OpenHands sent agent_state_changed
            # to awaiting_user_input/finished/stopped/error. We DON'T wait for
            # /conversations status to flip (it stays RUNNING until conv is
            # actually deleted) — the event is the source of truth.
            if turn_complete and full_answer:
                done = True

            # Belt-and-suspenders: hard status check
            try:
                rs = await client.get(
                    f"{OPENHANDS_SERVER}/api/conversations/{cid}", timeout=10.0
                )
                if rs.status_code == 200:
                    status = ((rs.json() or {}).get("conversation_status") or "").upper()
                    if status in ("STOPPED", "FINISHED", "COMPLETED", "ERROR"):
                        done = True
            except Exception:
                pass

            # Soft fallback: if we have an answer and the agent has been
            # quiet for >6 seconds, close the stream so the UI does not hang
            # if OpenHands forgets to emit awaiting_user_input.
            if full_answer and (time.time() - last_event_ts) > 6:
                done = True

            # Idle watchdog: no new events for 3 minutes → assume hung
            if (time.time() - last_event_ts) > 180:
                yield _sse(
                    "error",
                    {
                        "message": "Агент не отвечает (нет событий 3 минуты). Попробуйте ещё раз."
                    },
                ).encode("utf-8")
                break

            await asyncio.sleep(EVENT_POLL_INTERVAL)

        if full_answer:
            _, clean = _split_think(full_answer)
            if clean:
                yield _sse("assistant", {"step": step, "text": clean}).encode("utf-8")

        yield _sse(
            "done",
            {
                "reason": "complete" if done else "timeout",
                "steps": step,
                "conversationId": cid,
            },
        ).encode("utf-8")


@app.post("/api/agent/chat")
@app.post("/api/chat-pi")
async def agent_chat(request: Request):
    body = await request.json()
    history = body.get("history") or body.get("messages") or []
    extra_system = body.get("extraSystem") or ""
    chat_id = body.get("chatId") or ""
    provider = _resolve_provider(body)
    model = provider.get("model") or body.get("model") or DEFAULT_MODEL
    prompt = _history_to_prompt(history) or body.get("prompt") or "hi"

    return StreamingResponse(
        _stream_chat(chat_id, model, prompt, extra_system, provider),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/chat")
async def regular_chat(request: Request):
    """
    Non-agent chat. For now we still route through OpenHands to keep one
    backend; Step 2.5 will add a direct LiteLLM proxy for cheaper/faster
    plain chat. The SSE event names are the subset {assistant_delta, done}.
    """
    return await agent_chat(request)


@app.post("/api/chat/stop")
@app.post("/api/agent/chat/stop")
async def stop_chat(request: Request):
    data = await request.json()
    cid = data.get("conversationId") or data.get("chatId") or data.get("id")
    if not cid:
        return {"ok": False, "error": "no conversationId"}
    async with httpx.AsyncClient() as client:
        try:
            await client.post(
                f"{OPENHANDS_SERVER}/api/conversations/{cid}/stop", json={}, timeout=10.0
            )
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# Workspace / agent ancillary stubs (filled in Steps 4–8)
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/agent/health")
async def agent_health():
    return {"ok": True, "engine": "openhands", "openhands": True}


@app.get("/api/workspace")
@app.get("/api/workspace/tree")
async def workspace_tree(chatId: Optional[str] = None):
    # TODO Step 4: real workspace listing per chat through OpenHands /list-files
    return {"items": [], "chatId": chatId}


@app.get("/api/workspace/metadata")
async def workspace_meta(chatId: Optional[str] = None):
    return {"chatId": chatId, "items": []}


@app.get("/api/workspace/file")
async def workspace_file(path: str, chatId: Optional[str] = None):
    return JSONResponse({"path": path, "content": ""}, status_code=200)


# Generic catch-all for unimplemented agent endpoints so the UI does not
# blow up with HTML 404s.  We always return JSON {ok:false,...} so the UI's
# JSON-only fetch helpers can swallow it cleanly.


_STUB_ROUTES = [
    "/api/agent/answer",
    "/api/agent/control-plane",
    "/api/agent/questions",
    "/api/agent/recipes",
    "/api/agent/runs",
    "/api/agent/self-test",
    "/api/agent/workflows",
    "/api/agent/policy",
    "/api/agent/provider/diagnose",
    "/api/agent/tasks",
    "/api/agent/jobs",
    "/api/jobs",
    "/api/checkpoints",
    "/api/cost/today",
    "/api/cron",
    "/api/notifications",
    "/api/notifications/summary",
    "/api/notifications/read-all",
    "/api/memory/facts",
    "/api/memory/project",
    "/api/memory/semantic",
    "/api/admin/deepseek/status",
    "/api/admin/deepseek/refresh",
    "/api/admin/deepseek/token",
    "/api/mcp/config",
    "/api/mcp/status",
    "/api/mcp/restart",
    "/api/ops/services",
    "/api/ops/action",
    "/api/ops/audit",
    "/api/gateway/status",
    "/api/approval/policy",
    "/api/push/vapid",
    "/api/push/subscribe",
    "/api/push/unsubscribe",
    "/api/push/test",
    "/api/webhooks/github",
    "/api/webhooks/github/config",
    "/api/webhooks/github/secret",
    "/api/incidents",
    "/api/debug/client-error",
    "/api/operator/missions",
    "/api/operator/projects",
    "/api/operator/projects/analyze",
    "/api/operator/runbooks",
    "/api/operator/runtime-adapters",
    "/api/operator/deploy-sessions",
    "/api/operator/status",
    "/api/operator/recoveries",
    "/api/operator/recoveries/graph",
    "/api/operator/recoveries/supervise",
    "/api/operator/failure/classify",
    "/api/operator/failure/execute",
    "/api/operator/failure/incident",
    "/api/operator/github-automation/comment",
    "/api/operator/github-automation/events",
    "/api/operator/mcp/catalog",
    "/api/operator/mcp/install",
    "/api/operator/project-policy-presets",
    "/api/operator/project-templates",
]


def _stub_response(name: str):
    async def _h(request: Request):
        if request.method.lower() == "get":
            return JSONResponse(
                {"ok": True, "stub": True, "endpoint": name, "data": []}, status_code=200
            )
        return JSONResponse(
            {"ok": True, "stub": True, "endpoint": name}, status_code=200
        )

    return _h


for _path in _STUB_ROUTES:
    app.add_api_route(_path, _stub_response(_path), methods=["GET", "POST", "PUT", "DELETE"])


# ─────────────────────────────────────────────────────────────────────────────
# Static UI mount (must be last so /api/* takes precedence)
# ─────────────────────────────────────────────────────────────────────────────

for _ui_dir in ("/app/ui/dist", "./ui/dist"):
    if os.path.isdir(_ui_dir):
        app.mount("/", StaticFiles(directory=_ui_dir, html=True), name="ui")
        log.info("UI mounted from %s", _ui_dir)
        break
else:
    log.warning("UI dist not found; only /api/* will be served")
