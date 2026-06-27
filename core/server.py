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
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from core.database import (
    delete_key,
    get_active_key,
    get_key,
    get_params,
    import_keys,
    init_db,
    list_keys,
    set_active_key,
    set_params,
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
from core.conversations import (
    drop_mapping,
    get_mapping,
    get_or_create_conversation,
    init_conversations_schema,
    update_last_event,
)
from core.agent_state import (
    answer_question,
    create_question,
    get_question,
    get_run,
    init_agent_state_schema,
    list_questions,
    list_runs,
    set_run_status,
    upsert_run,
)
from core import providers as provs
from core import vault as vlt
from core.memory_kb import (
    delete_fact,
    delete_project_memory,
    extract_facts,
    kb_add,
    kb_delete,
    kb_list,
    kb_search,
    list_facts,
    list_project_memory,
    search_semantic,
    upsert_fact,
    upsert_project_memory,
)
from core.web_image import generate_image, web_search as do_web_search
from core.admin_data import (
    cost_today as _cost_today,
    deep_health as _deep_health,
    gateway_status as _gateway_status,
    get_job as _get_job,
    get_operator_mission as _get_operator_mission,
    list_incidents as _list_incidents,
    list_jobs as _list_jobs,
    list_notifications as _list_notifications,
    list_operator_missions as _list_operator_missions,
    list_operator_projects as _list_operator_projects,
    mark_all_read as _mark_all_read,
    notifications_summary as _notifications_summary,
    operator_status as _operator_status,
)

from core.obslog import (
    configure_logging as _configure_logging,
    set_trace_context as _set_trace_context,
    trace_id_var as _trace_id_var,
)

log = logging.getLogger("browserai.core")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
# Step 10.6 — JSON logs (LOG_FORMAT=json) + per-request trace_id correlation.
_configure_logging()

OPENHANDS_SERVER = os.environ.get("OPENHANDS_AGENT_SERVER", "http://openhands:18000")
DEFAULT_MODEL = os.environ.get("BROWSERAI_DEFAULT_MODEL", "glm-4.5-flash")
DEFAULT_BASE_URL = os.environ.get(
    "OPENHANDS_LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"
)
APP_URL = os.environ.get("APP_URL", "http://localhost")
MAX_AGENT_ITERATIONS = int(os.environ.get("BROWSERAI_AGENT_MAX_ITERATIONS", "50"))
EVENT_POLL_INTERVAL = float(os.environ.get("BROWSERAI_EVENT_POLL_INTERVAL", "0.6"))
EVENT_POLL_TIMEOUT_S = int(os.environ.get("BROWSERAI_EVENT_POLL_TIMEOUT_S", "900"))
# Step 10.1 — progressive output. OpenHands' event API delivers the assistant
# message as one complete chunk (no token stream), so we re-chunk it server-side
# into small deltas with light pacing for a typewriter feel. Tunable/disableable.
STREAM_RECHUNK = os.environ.get("BROWSERAI_STREAM_RECHUNK", "1") not in ("0", "false", "False")
STREAM_CHUNK_CHARS = int(os.environ.get("BROWSERAI_STREAM_CHUNK_CHARS", "24"))
STREAM_CHUNK_DELAY = float(os.environ.get("BROWSERAI_STREAM_CHUNK_DELAY", "0.02"))
STREAM_RECHUNK_MIN = int(os.environ.get("BROWSERAI_STREAM_RECHUNK_MIN", "48"))

app = FastAPI(title="BrowserAI-OpenHands Core Monolith", version="0.3.0")


@app.on_event("startup")
async def _startup_init() -> None:
    try:
        init_db()
        init_auth_schema()
        init_conversations_schema()
        init_agent_state_schema()
        log.info("all schemas ready (db, auth, conversations, agent_state, vault)")
    except Exception as e:
        log.error("schema init failed: %s", e)

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


@app.middleware("http")
async def _trace_requests(request: Request, call_next):
    """Step 10.6 — assign a trace_id to every request, correlate it with the
    chatId when present, log start/finish as structured records, and echo the
    id back via X-Trace-Id so the UI/ops can grep one request end-to-end."""
    incoming = request.headers.get("X-Trace-Id")
    chat_id = request.query_params.get("chatId") or request.headers.get("X-Chat-Id")
    tid = _set_trace_context(trace_id=incoming, chat_id=chat_id)
    started = time.time()
    log.info("request %s %s", request.method, request.url.path)
    try:
        response = await call_next(request)
    except Exception:
        dt = (time.time() - started) * 1000
        log.exception("request failed %s %s after %.1fms", request.method, request.url.path, dt)
        raise
    dt = (time.time() - started) * 1000
    log.info("response %s %s -> %s in %.1fms",
             request.method, request.url.path, response.status_code, dt)
    response.headers["X-Trace-Id"] = tid
    return response


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _resolve_provider(body: Dict[str, Any], user: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
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
        out = dict(pi)
    else:
        out = {
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

    # If caller wants stored secret, fetch it from DB with full row (secret incl.)
    if out.get("useStoredSecret") and out.get("keyId"):
        stored = get_key(out["keyId"], include_secret=True)
        if stored:
            for k in ("baseUrl", "authType", "authHeader", "extraHeaders", "model"):
                if not out.get(k):
                    out[k] = stored.get(k)
            out["apiKey"] = stored.get("apiKey") or out.get("apiKey") or ""

    # Decrypt secret if vault is enabled and unlocked
    if user and out.get("apiKey", "").startswith("enc:"):
        out["apiKey"] = vlt.resolve_secret(user["id"], out["apiKey"])

    # Last-resort default
    if not (out.get("apiKey") or out.get("baseUrl")):
        active = get_active_key(include_secret=True) or {}
        if active:
            if user and active.get("apiKey", "").startswith("enc:"):
                active["apiKey"] = vlt.resolve_secret(user["id"], active["apiKey"])
            out.update({
                "keyId": active.get("id"),
                "useStoredSecret": True,
                "baseUrl": active.get("baseUrl") or DEFAULT_BASE_URL,
                "apiKey": active.get("apiKey") or os.environ.get("BIGMODEL_API_KEY", ""),
                "model": out.get("model") or active.get("model") or DEFAULT_MODEL,
                "authType": active.get("authType") or "bearer",
                "extraHeaders": active.get("extraHeaders") or {},
            })
    return out


def _qualify_model(base_url: str, model: str) -> str:
    # Thin wrapper kept for backwards-compat with any external imports.
    return provs.qualify_model(base_url, model)


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


@app.get("/api/health/deep")
async def get_health_deep():
    """Step 10.5 — deep readiness probe (db, OpenHands, active key, disk>5GB).
    Returns 200 with status=ready, or 503 with status=degraded so a
    load-balancer / uptime check can act on it."""
    result = await _deep_health(OPENHANDS_SERVER)
    return JSONResponse(result, status_code=200 if result.get("ok") else 503)


def _settings_payload(request: Request) -> Dict[str, Any]:
    user = current_user(request)
    keys = list_keys(include_secrets=False)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {
        "keys": keys,
        "activeKeyId": active["id"] if active else None,
        "params": get_params(),
        "vault": vlt.status(user["id"]) if user else {"enabled": False, "locked": False, "available": vlt.is_available()},
    }


@app.get("/api/settings")
async def get_settings(request: Request):
    return _settings_payload(request)


@app.get("/api/keys")
async def get_keys():
    keys = list_keys(include_secrets=False)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None}


@app.post("/api/keys")
async def post_key(request: Request):
    data = await request.json()
    if not data.get("id"):
        raise HTTPException(status_code=400, detail="id required")
    # If vault is unlocked, encrypt secret transparently on its way to disk.
    user = current_user(request)
    if user and vlt.is_available() and data.get("apiKey"):
        st = vlt.status(user["id"])
        if st.get("enabled") and not st.get("locked"):
            enc = vlt.encrypt(user["id"], data["apiKey"])
            if enc:
                data["apiKey"] = enc
    keys = upsert_key(data)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": [_k for _k in keys], "activeKeyId": active["id"] if active else None}


@app.post("/api/keys/import")
async def keys_import(request: Request):
    body = await request.json()
    incoming = body.get("keys") or []
    active_id = body.get("activeKeyId")
    keys = import_keys(incoming, active_id)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None, "imported": len(incoming)}


@app.post("/api/keys/{key_id}/activate")
async def activate_key(key_id: str, request: Request):
    keys = set_active_key(key_id)
    # Push new provider into OpenHands settings so next chat uses it
    asyncio.create_task(_sync_active_provider_to_openhands(request))
    return {"keys": keys, "activeKeyId": key_id}


@app.delete("/api/keys/{key_id}")
async def remove_key(key_id: str):
    keys = delete_key(key_id)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None}


@app.get("/api/params")
async def params_get():
    return get_params()


@app.put("/api/params")
async def put_params(request: Request):
    body = await request.json()
    p = set_params(body or {})
    asyncio.create_task(_sync_active_provider_to_openhands(request))
    return {"ok": True, "params": p}


# ── Validation ──────────────────────────────────────────────────────────────


@app.post("/api/validate")
async def keys_validate(request: Request):
    body = await request.json()
    # Caller may send full provider dict OR {keyId} to validate stored one
    if body.get("keyId") and not body.get("apiKey"):
        stored = get_key(body["keyId"], include_secret=True)
        if not stored:
            raise HTTPException(status_code=404, detail="key not found")
        provider = stored
    else:
        provider = body
    # Resolve encrypted secret if needed
    user = current_user(request)
    if user and provider.get("apiKey", "").startswith("enc:"):
        provider = {**provider, "apiKey": vlt.resolve_secret(user["id"], provider["apiKey"])}
    return await provs.validate_key(provider)


# ── Model catalog ───────────────────────────────────────────────────────────


@app.get("/api/models")
async def list_models(request: Request, baseUrl: Optional[str] = None, keyId: Optional[str] = None):
    provider: Dict[str, Any] = {"baseUrl": baseUrl or ""}
    if keyId:
        stored = get_key(keyId, include_secret=True)
        if stored:
            provider = stored
    user = current_user(request)
    if user and provider.get("apiKey", "").startswith("enc:"):
        provider["apiKey"] = vlt.resolve_secret(user["id"], provider["apiKey"])
    if not provider.get("baseUrl") and not baseUrl:
        active = get_active_key()
        if active:
            provider = active
    models = await provs.fetch_models(provider.get("baseUrl") or "", provider)
    return {"baseUrl": provider.get("baseUrl"), "models": models, "count": len(models)}


# ── Vault ───────────────────────────────────────────────────────────────────


def _require_user(request: Request) -> Dict[str, Any]:
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="auth_required")
    return user


@app.get("/api/vault/status")
async def vault_status(request: Request):
    user = current_user(request)
    if not user:
        return {"enabled": False, "locked": False, "available": vlt.is_available()}
    return vlt.status(user["id"])


@app.post("/api/vault/setup")
async def vault_setup(request: Request):
    user = _require_user(request)
    body = await request.json()
    try:
        return vlt.setup(user["id"], body.get("passphrase") or "", int(body.get("autolockMinutes") or 30))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/api/vault/unlock")
async def vault_unlock(request: Request):
    user = _require_user(request)
    body = await request.json()
    try:
        return vlt.unlock(user["id"], body.get("passphrase") or "")
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/api/vault/lock")
async def vault_lock(request: Request):
    user = _require_user(request)
    return vlt.lock(user["id"])


@app.post("/api/vault/change")
async def vault_change(request: Request):
    user = _require_user(request)
    body = await request.json()
    try:
        return vlt.change(user["id"], body.get("passphrase") or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/vault/disable")
async def vault_disable(request: Request):
    user = _require_user(request)
    return vlt.disable(user["id"])


@app.post("/api/vault/autolock")
async def vault_autolock(request: Request):
    user = _require_user(request)
    body = await request.json()
    return vlt.autolock(user["id"], int(body.get("minutes") or 30))


@app.get("/api/vault/backup")
async def vault_backup(request: Request):
    user = _require_user(request)
    try:
        return vlt.backup(user["id"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/vault/restore")
async def vault_restore(request: Request):
    user = _require_user(request)
    body = await request.json()
    try:
        return vlt.restore(user["id"], body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── OpenHands settings sync helper ─────────────────────────────────────────


async def _sync_active_provider_to_openhands(request: Request) -> None:
    """Fire-and-forget push of currently-active key + params to OH."""
    try:
        active = get_active_key(include_secret=True)
        if not active:
            return
        user = current_user(request)
        if user and active.get("apiKey", "").startswith("enc:"):
            active["apiKey"] = vlt.resolve_secret(user["id"], active["apiKey"])
        async with httpx.AsyncClient() as c:
            await provs.push_to_openhands(c, OPENHANDS_SERVER, active, get_params())
    except Exception as e:
        log.warning("sync_active_provider_to_openhands failed: %s", e)


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
    """Push the chosen LLM + global params into OpenHands. Thin wrapper
    over providers.push_to_openhands; kept for legacy import sites."""
    ok = await provs.push_to_openhands(client, OPENHANDS_SERVER, provider, get_params())
    if not ok:
        log.warning("OpenHands settings push failed; agent may use stale config")


# Note: conversation create/start/reuse is delegated to core.conversations.
# Kept as a thin alias only for legacy callers/tests.
async def _create_and_start(
    client: httpx.AsyncClient,
    prompt: str,
    extra_system: str = "",
    chat_id: str = "",
    user_id: Optional[str] = None,
) -> Tuple[str, bool, int]:
    return await get_or_create_conversation(
        client, OPENHANDS_SERVER, chat_id, user_id, prompt, extra_system
    )


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


def _chunk_text(text: str, size: int) -> List[str]:
    """Split text into ~`size`-char chunks, preferring word boundaries so the
    typewriter effect doesn't cut words awkwardly (Step 10.1). Falls back to a
    hard cut for very long whitespace-free runs (e.g. code/URLs)."""
    if size <= 0 or len(text) <= size:
        return [text] if text else []
    chunks: List[str] = []
    i, n = 0, len(text)
    while i < n:
        end = min(i + size, n)
        if end < n:
            # extend to the next whitespace to avoid splitting mid-word,
            # but cap the look-ahead so we never run away.
            j = end
            limit = min(end + size, n)
            while j < limit and not text[j].isspace():
                j += 1
            if j < limit:
                end = j
        chunks.append(text[i:end])
        i = end
    return chunks


def _extract_ask_user_payload(text: str) -> Optional[Dict[str, Any]]:
    """Best-effort parser for agent questions.

    Supports:
      1) JSON block like:
         ASK_USER:{"question":"...","options":[{"id":"a","label":"A"}]}
      2) Plain Russian/English question ending with '?' and short bullet/
         numbered options.
    """
    if not text:
        return None
    m = _re.search(r"ASK_USER\s*:\s*(\{.*\})", text, _re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(1))
            q = (data.get("question") or "").strip()
            opts = data.get("options") or []
            if q:
                return {"question": q, "options": opts}
        except Exception:
            pass

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return None
    qline = next((ln for ln in lines if ln.endswith("?")), "")
    if not qline:
        return None
    opts = []
    for ln in lines:
        mm = _re.match(r"^(?:[-*]|\d+[\.)]|[A-Za-zА-Яа-я][\.)])\s+(.+)$", ln)
        if mm:
            label = mm.group(1).strip()
            if label and label != qline:
                oid = f"opt_{len(opts)+1}"
                opts.append({"id": oid, "label": label})
    return {"question": qline, "options": opts[:6]}


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

    # ── 8b. agent finish (final/no-more-actions)
    if action_kind == "finish":
        # The 'finish' action means the agent is done with this turn. We don't
        # emit anything special — the next agent_state_changed event will
        # carry awaiting_user_input which closes the stream cleanly.
        return out

    # ── 9. error — IMPORTANT distinction:
    #     OpenHands emits observation=error to mean "a tool call failed and
    #     I will retry/recover" — this is NOT fatal, the agent keeps going.
    #     Examples: "Missing required parameters for function 'X': {'security_risk'}"
    #     when GLM forgets the security_risk arg, OH retries with auto-fixed args.
    #
    #     The truly-fatal signal is agent_state_changed -> error (handled in
    #     section 1 via the awaiting_user_input/finished/stopped/error match).
    #
    #     So we surface tool errors as a small thinking note rather than a
    #     UI-killing error event.
    if obs_kind == "error" or evt.get("error"):
        err = content or message or "engine error"
        out.append({
            "event": "thinking_delta",
            "data": {"step": step, "chunk": f"⚠️ tool error (retrying): {err[:200]}"},
        })
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
    user_id: Optional[str] = None,
) -> AsyncIterator[bytes]:
    step = 0
    full_answer = ""
    turn_complete = False  # set as soon as OpenHands emits awaiting_user_input
    ask_user_sent = False  # Step 6: emit ask_user at most once per turn

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

    # 2) Push settings + open/reuse conversation
    async with httpx.AsyncClient() as client:
        try:
            await _push_oh_settings(client, provider)
            cid, was_created, last_seen_event_id = await get_or_create_conversation(
                client,
                OPENHANDS_SERVER,
                chat_id,
                user_id,
                prompt,
                extra_system,
            )
            if chat_id:
                upsert_run(chat_id, cid, user_id, "running", last_prompt=prompt, last_event_id=last_seen_event_id)
            try:
                from core.obslog import bind_conversation as _bind_conv
                _bind_conv(cid)
            except Exception:
                pass
        except HTTPException as e:
            if chat_id:
                upsert_run(chat_id, None, user_id, "error", last_prompt=prompt, last_error=str(e.detail))
            yield _sse("error", {"message": str(e.detail)}).encode("utf-8")
            yield _sse("done", {"reason": "engine-error", "steps": step}).encode("utf-8")
            return
        except Exception as e:
            if chat_id:
                upsert_run(chat_id, None, user_id, "error", last_prompt=prompt, last_error=str(e))
            yield _sse("error", {"message": f"OpenHands bridge: {e}"}).encode("utf-8")
            yield _sse("done", {"reason": "engine-error", "steps": step}).encode("utf-8")
            return

        # Tell the UI whether this is a fresh sandbox boot or a warm reuse.
        # That lets the UI show a smarter "cold start in progress" hint.
        yield _sse(
            "agent_state",
            {
                "step": 0,
                "phase": "warm" if not was_created else "cold",
                "raw": "warm" if not was_created else "cold",
                "conversationId": cid,
            },
        ).encode("utf-8")

        # 3) Poll events incrementally — start AFTER the last event we already
        #    showed for this chat. For new conversations this is 0; for reused
        #    ones it's the id of the event just before our new POST /message.
        seen_ids: set = set()
        next_start_id = last_seen_event_id + 1 if last_seen_event_id >= 0 else 0
        t0 = time.time()
        last_event_ts = time.time()
        done = False

        # OpenHands main v0.59 has both:
        #   * a broken /events?start_id filter (returns []),
        #   * a hard max of limit<=100.
        # We always fetch the tail with limit=100 and dedup via seen_ids.
        # For warm reuse we pre-seed seen_ids with everything prior to this
        # turn so we only stream the response to THIS message.
        if not was_created and last_seen_event_id >= 0:
            seen_ids = set(range(0, last_seen_event_id + 1))

        while not done and (time.time() - t0) < EVENT_POLL_TIMEOUT_S:
            try:
                r = await client.get(
                    f"{OPENHANDS_SERVER}/api/conversations/{cid}/events?limit=100",
                    timeout=20.0,
                )
                if r.status_code == 404:
                    yield _sse("error", {"message": "OpenHands conversation lost"}).encode("utf-8")
                    # Forget the mapping so the next user message creates a fresh one
                    if chat_id:
                        drop_mapping(chat_id)
                    break
                if r.status_code >= 400:
                    await asyncio.sleep(EVENT_POLL_INTERVAL)
                    continue
                body = r.json()
                events = body if isinstance(body, list) else (body.get("events") or body.get("results") or [])
                # `start_id` is inclusive, so we still de-dup against seen_ids
                new_events = [e for e in events if e.get("id") not in seen_ids]
                for e in new_events:
                    seen_ids.add(e.get("id"))
                    last_event_ts = time.time()
                    eid = int(e.get("id", -1))
                    if eid >= next_start_id:
                        next_start_id = eid + 1
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
                            if not ask_user_sent and chat_id:
                                ask_payload = _extract_ask_user_payload(full_answer)
                                if ask_payload:
                                    qid = f"q_{uuid.uuid4().hex[:12]}"
                                    create_question(
                                        qid, chat_id, cid, user_id,
                                        ask_payload.get("question") or "",
                                        ask_payload.get("options") or [],
                                    )
                                    yield _sse(
                                        "ask_user",
                                        {
                                            "question_id": qid,
                                            "question": ask_payload.get("question"),
                                            "options": ask_payload.get("options") or [],
                                        },
                                    ).encode("utf-8")
                                    ask_user_sent = True
                        # Step 10.1 — re-chunk the (whole) assistant message into
                        # small paced deltas for a streaming/typewriter feel.
                        # The UI already buffers assistant_delta, so this is a
                        # pure presentation improvement. Disable via env if the
                        # provider ever delivers true token deltas.
                        if (
                            ev_name == "assistant_delta"
                            and STREAM_RECHUNK
                            and len(ev_data.get("chunk", "")) > STREAM_RECHUNK_MIN
                        ):
                            _whole = ev_data.get("chunk", "")
                            _step = ev_data.get("step")
                            for _piece in _chunk_text(_whole, STREAM_CHUNK_CHARS):
                                yield _sse(
                                    "assistant_delta",
                                    {"step": _step, "chunk": _piece},
                                ).encode("utf-8")
                                if STREAM_CHUNK_DELAY > 0:
                                    await asyncio.sleep(STREAM_CHUNK_DELAY)
                        else:
                            yield _sse(ev_name, ev_data).encode("utf-8")
            except httpx.TimeoutException:
                pass
            except Exception as e:
                log.warning("event poll error: %s", e)

            # Primary end-of-turn signal: OpenHands sent agent_state_changed
            # to awaiting_user_input/finished/stopped/error. We DON'T wait for
            # /conversations status to flip (it stays RUNNING until conv is
            # actually deleted) — the event is the source of truth.
            #
            # Note: 'finished' can come WITHOUT any full_answer (e.g. GLM ends
            # via a 'finish' action after a tool call, without summarising in
            # natural language). Close the stream anyway — the UI already saw
            # the tool_result cards.
            if turn_complete:
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

            # Soft fallback: if we have an answer OR tool steps and the agent
            # has been quiet for >8 seconds, close the stream so the UI does
            # not hang if OpenHands forgets to emit awaiting_user_input.
            if (full_answer or step > 0) and (time.time() - last_event_ts) > 8:
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
                if not ask_user_sent and chat_id:
                    ask_payload = _extract_ask_user_payload(clean)
                    if ask_payload:
                        qid = f"q_{uuid.uuid4().hex[:12]}"
                        create_question(
                            qid, chat_id, cid, user_id,
                            ask_payload.get("question") or "",
                            ask_payload.get("options") or [],
                        )
                        yield _sse(
                            "ask_user",
                            {
                                "question_id": qid,
                                "question": ask_payload.get("question"),
                                "options": ask_payload.get("options") or [],
                            },
                        ).encode("utf-8")
                        ask_user_sent = True
                yield _sse("assistant", {"step": step, "text": clean}).encode("utf-8")
        elif step > 0 and done:
            # Agent finished via pure tool execution with no natural-language
            # summary (common with GLM after a single write/edit). Emit a
            # generic 'assistant' so the UI shows something instead of an
            # empty bubble.
            yield _sse(
                "assistant",
                {"step": step, "text": "✅ Готово."},
            ).encode("utf-8")

        # Persist max event id we've seen so the next /api/agent/chat for
        # this chat skips replaying old events from THIS turn.
        if chat_id and seen_ids:
            try:
                max_seen = max(seen_ids)
                update_last_event(chat_id, max_seen)
                set_run_status(chat_id, "done" if done else "timeout")
                upsert_run(chat_id, cid, user_id, "done" if done else "timeout", last_prompt=prompt, last_event_id=max_seen)
            except Exception as e:
                log.warning("update_last_event failed: %s", e)
        elif chat_id:
            try:
                set_run_status(chat_id, "done" if done else "timeout")
            except Exception:
                pass

        yield _sse(
            "done",
            {
                "reason": "complete" if done else "timeout",
                "steps": step,
                "conversationId": cid,
                "reused": not was_created,
            },
        ).encode("utf-8")


@app.post("/api/agent/chat")
@app.post("/api/chat-pi")
async def agent_chat(request: Request):
    body = await request.json()
    history = body.get("history") or body.get("messages") or []
    extra_system = body.get("extraSystem") or ""
    chat_id = body.get("chatId") or ""
    user = current_user(request)
    user_id = user["id"] if user else None
    provider = _resolve_provider(body, user=user)
    model = provider.get("model") or body.get("model") or DEFAULT_MODEL
    prompt = _history_to_prompt(history) or body.get("prompt") or "hi"

    # Step 7.1 — auto-extract durable facts from the user's message (best-effort)
    if user_id and prompt:
        try:
            extract_facts(user_id, prompt)
        except Exception as e:
            log.debug("fact extraction skipped: %s", e)

    # If the provider has no usable secret (vault locked, no key), fail fast
    # so the UI shows a clean message instead of OH returning 502 later.
    if not provider.get("apiKey") and (provider.get("authType") or "bearer") == "bearer":
        async def _err_stream():
            yield _sse("error", {"message": "API ключ не настроен или vault заблокирован. Откройте Настройки."}).encode("utf-8")
            yield _sse("done", {"reason": "no-provider"}).encode("utf-8")
        return StreamingResponse(_err_stream(), media_type="text/event-stream")

    return StreamingResponse(
        _stream_chat(chat_id, model, prompt, extra_system, provider, user_id=user_id),
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
            chat_id = data.get("chatId")
            if chat_id:
                set_run_status(chat_id, "stopped")
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — interactive agent flow: questions, answers, runs/control-plane,
# history, recipes, self-test, workflows. Backed by core.agent_state (SQLite).
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/agent/questions")
async def agent_questions(request: Request, chatId: Optional[str] = None):
    user = current_user(request)
    items = list_questions(chat_id=chatId, user_id=(user["id"] if user and not chatId else None))
    return {"ok": True, "items": items}


@app.post("/api/agent/answer")
async def agent_answer(request: Request):
    user = current_user(request)
    body = await request.json()
    qid = body.get("question_id") or body.get("questionId")
    if not qid:
        raise HTTPException(status_code=400, detail="question_id required")
    q = get_question(qid)
    if not q:
        raise HTTPException(status_code=404, detail="question_not_found")
    answer = {
        "answer": body.get("answer"),
        "selectedOptionId": body.get("selectedOptionId"),
        "customResponse": body.get("customResponse"),
        "answeredBy": user["id"] if user else None,
    }
    saved = answer_question(qid, answer)
    text = answer.get("customResponse") or answer.get("answer") or answer.get("selectedOptionId") or "ok"
    cid = q.get("conversation_id")
    if cid:
        async with httpx.AsyncClient() as client:
            try:
                await client.post(
                    f"{OPENHANDS_SERVER}/api/conversations/{cid}/message",
                    json={"message": f"User answered question '{q.get('question')}': {text}"},
                    timeout=15.0,
                )
            except Exception as e:
                log.warning("agent answer relay failed: %s", e)
    return {"ok": True, "question": saved}


@app.post("/api/agent/runs/{chat_id}/reset")
async def agent_run_reset(chat_id: str):
    m = get_mapping(chat_id)
    cid = m["conversation_id"] if m else None
    if cid:
        async with httpx.AsyncClient() as client:
            try:
                await client.delete(f"{OPENHANDS_SERVER}/api/conversations/{cid}", timeout=15.0)
            except Exception:
                pass
    drop_mapping(chat_id)
    set_run_status(chat_id, "reset")
    return {"ok": True, "chatId": chat_id, "conversationId": cid, "reset": True}


@app.get("/api/agent/runs/{chat_id}/history")
async def agent_run_history(chat_id: str):
    m = get_mapping(chat_id)
    if not m:
        return {"ok": True, "chatId": chat_id, "items": []}
    cid = m["conversation_id"]
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(f"{OPENHANDS_SERVER}/api/conversations/{cid}/events?limit=100", timeout=20.0)
            body = r.json() if r.status_code == 200 else []
            events = body if isinstance(body, list) else (body.get("events") or body.get("results") or [])
            transformed = []
            step = 0
            for e in events:
                for t in _translate_event(e, step + 1):
                    if t["event"] == "tool_start":
                        step += 1
                        t["data"]["step"] = step
                    transformed.append(t)
            return {"ok": True, "chatId": chat_id, "conversationId": cid, "items": transformed[-200:]}
        except Exception as e:
            return {"ok": False, "chatId": chat_id, "items": [], "error": str(e)}


@app.get("/api/agent/control-plane")
async def agent_control_plane(request: Request):
    user = current_user(request)
    runs = list_runs(user["id"] if user else None)
    return {"ok": True, "runs": runs, "count": len(runs)}


@app.post("/api/agent/control-plane")
async def agent_control_plane_action(request: Request):
    body = await request.json()
    action = body.get("action")
    chat_id = body.get("chatId")
    if action == "abort" and chat_id:
        run = get_run(chat_id)
        cid = run.get("conversation_id") if run else None
        if cid:
            async with httpx.AsyncClient() as client:
                try:
                    await client.post(f"{OPENHANDS_SERVER}/api/conversations/{cid}/stop", json={}, timeout=10.0)
                except Exception as e:
                    return {"ok": False, "error": str(e)}
        set_run_status(chat_id, "aborted")
        return {"ok": True, "action": action, "chatId": chat_id}
    if action == "pause" and chat_id:
        set_run_status(chat_id, "paused")
        return {"ok": True, "action": action, "chatId": chat_id}
    if action == "resume" and chat_id:
        set_run_status(chat_id, "running")
        return {"ok": True, "action": action, "chatId": chat_id}
    return {"ok": False, "error": "unsupported_action"}


@app.get("/api/agent/recipes")
async def agent_recipes():
    return {"ok": True, "items": [
        {"id": "repo_audit", "title": "Аудит репозитория", "prompt": "Проанализируй репозиторий и перечисли ключевые риски и next steps."},
        {"id": "bugfix", "title": "Исправить баг", "prompt": "Найди причину бага, исправь код и кратко опиши изменения."},
        {"id": "deploy_check", "title": "Проверить деплой", "prompt": "Проверь состояние сервера, контейнеров и health endpoint'ов."},
    ]}


@app.post("/api/agent/self-test")
async def agent_self_test(request: Request):
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    user = current_user(request)
    provider = _resolve_provider(body, user=user)
    model = provider.get("model") or DEFAULT_MODEL
    prompt = body.get("prompt") or "Ответь ровно словом pong"
    return StreamingResponse(
        _stream_chat(
            f"self-test-{uuid.uuid4().hex[:8]}",
            model,
            prompt,
            body.get("extraSystem") or "",
            provider,
            user_id=(user or {}).get("id"),
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/agent/workflows")
async def agent_workflows():
    return {"ok": True, "items": []}


# ─────────────────────────────────────────────────────────────────────────────
# Workspace / agent ancillary stubs (filled in Steps 4–8)
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/agent/health")
async def agent_health():
    return {"ok": True, "engine": "openhands", "openhands": True}


# ─────────────────────────────────────────────────────────────────────────────
# Workspace — per-chat, via OpenHands sandbox (Step 4)
# ─────────────────────────────────────────────────────────────────────────────


def _bind_chat_to_oh(chat_id: Optional[str]) -> Optional[str]:
    """Return the OpenHands conversation_id mapped to chat_id, or None."""
    if not chat_id:
        return None
    m = get_mapping(chat_id)
    return m["conversation_id"] if m else None


def _to_tree_item(raw_path: str, base: str = "/workspace") -> Dict[str, Any]:
    """Normalize OpenHands list-files entries into the {name, path, type}
    shape the BrowserAI UI's FileTree expects."""
    if not raw_path:
        return {"name": "", "path": "", "type": "file"}
    p = raw_path.rstrip("/")
    is_dir = raw_path.endswith("/") or raw_path == base
    # Strip leading /workspace/ so UI shows relative paths
    rel = p
    if base and rel.startswith(base + "/"):
        rel = rel[len(base) + 1 :]
    elif rel == base:
        rel = ""
    name = rel.split("/")[-1] if rel else ""
    return {"name": name, "path": rel, "type": "dir" if is_dir else "file"}


@app.get("/api/workspace")
@app.get("/api/workspace/tree")
async def workspace_tree(chatId: Optional[str] = None, path: Optional[str] = None):
    cid = _bind_chat_to_oh(chatId)
    if not cid:
        return {"items": [], "chatId": chatId, "path": path or ""}
    qs = ""
    if path:
        qs = f"?path={path.lstrip('/')}"
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(
                f"{OPENHANDS_SERVER}/api/conversations/{cid}/list-files{qs}",
                timeout=15.0,
            )
            if r.status_code >= 400:
                return {"items": [], "chatId": chatId, "path": path or "", "error": r.text[:200]}
            entries = r.json() or []
        except Exception as e:
            return {"items": [], "chatId": chatId, "path": path or "", "error": str(e)}
    items = [_to_tree_item(p) for p in entries if isinstance(p, str)]
    return {"items": items, "chatId": chatId, "path": path or ""}


@app.get("/api/workspace/metadata")
async def workspace_meta(chatId: Optional[str] = None):
    cid = _bind_chat_to_oh(chatId)
    return {"chatId": chatId, "conversationId": cid, "ready": bool(cid)}


@app.get("/api/workspace/file")
async def workspace_file(path: str, chatId: Optional[str] = None):
    cid = _bind_chat_to_oh(chatId)
    if not cid:
        return JSONResponse(
            {"path": path, "content": "", "error": "no_conversation_for_chat"},
            status_code=200,
        )
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(
                f"{OPENHANDS_SERVER}/api/conversations/{cid}/select-file",
                params={"file": path},
                timeout=15.0,
            )
            if r.status_code >= 400:
                return JSONResponse(
                    {"path": path, "content": "", "error": r.text[:200]},
                    status_code=200,
                )
            body = r.json() or {}
            return {
                "path": path,
                "content": body.get("code") or body.get("content") or "",
            }
        except Exception as e:
            return JSONResponse(
                {"path": path, "content": "", "error": str(e)}, status_code=200
            )


@app.get("/api/workspace/download")
async def workspace_download(chatId: str, path: Optional[str] = None):
    """Download the whole workspace (or a sub-path) as a zip stream."""
    cid = _bind_chat_to_oh(chatId)
    if not cid:
        raise HTTPException(status_code=404, detail="no_conversation_for_chat")
    qs = ""
    if path:
        qs = f"?path={path.lstrip('/')}"
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{OPENHANDS_SERVER}/api/conversations/{cid}/zip-directory{qs}",
            timeout=120.0,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text[:300])
        return Response(
            content=r.content,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="workspace-{chatId or "chat"}.zip"'
            },
        )


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


@app.get("/api/memory/facts")
async def memory_facts_get(request: Request):
    user = _require_user(request)
    return {"ok": True, "items": list_facts(user["id"])}


@app.post("/api/memory/facts")
async def memory_facts_post(request: Request):
    user = _require_user(request)
    body = await request.json()
    key = (body.get("key") or "").strip()
    value = (body.get("value") or "").strip()
    if not key or not value:
        raise HTTPException(status_code=400, detail="key and value required")
    return {"ok": True, "item": upsert_fact(user["id"], key, value)}


@app.delete("/api/memory/facts")
async def memory_facts_delete(request: Request):
    user = _require_user(request)
    body = await request.json()
    key = (body.get("key") or "").strip()
    return {"ok": delete_fact(user["id"], key)}


@app.get("/api/memory/semantic")
async def memory_semantic_get(request: Request, q: str = "", limit: int = 10):
    user = _require_user(request)
    return {"ok": True, "items": search_semantic(user["id"], q, limit=max(1, min(limit, 50)))}


@app.get("/api/memory/project")
async def memory_project_get(request: Request, chatId: Optional[str] = None):
    user = _require_user(request)
    return {"ok": True, "items": list_project_memory(user["id"], chatId)}


@app.post("/api/memory/project")
async def memory_project_post(request: Request):
    user = _require_user(request)
    body = await request.json()
    chat_id = (body.get("chatId") or "").strip()
    key = (body.get("key") or "").strip()
    value = (body.get("value") or "").strip()
    if not chat_id or not key:
        raise HTTPException(status_code=400, detail="chatId and key required")
    return {"ok": True, "item": upsert_project_memory(user["id"], chat_id, key, value)}


@app.delete("/api/memory/project")
async def memory_project_delete(request: Request):
    user = _require_user(request)
    body = await request.json()
    return {"ok": delete_project_memory(user["id"], (body.get("chatId") or "").strip(), (body.get("key") or "").strip())}


@app.get("/api/kb/list")
async def kb_list_get(request: Request):
    user = _require_user(request)
    return {"ok": True, "items": kb_list(user["id"])}


@app.get("/api/web/search")
async def api_web_search(request: Request, q: str = "", limit: int = 8):
    _require_user(request)
    return {"ok": True, "items": await do_web_search(q, limit=max(1, min(limit, 20)))}


@app.post("/api/image/generate")
async def api_image_generate(request: Request):
    user = _require_user(request)
    body = await request.json()
    # Resolve the active provider (with vault decryption) so we hit a real
    # images API instead of returning a placeholder.
    provider = _resolve_provider(body, user=user)
    result = await generate_image(
        body.get("prompt") or "",
        body.get("size") or "1024x1024",
        provider=provider,
        model=body.get("model") or "",
    )
    return {"ok": bool(result.get("ok", True)), "image": result}


@app.get("/api/kb/search")
async def kb_search_get(request: Request, q: str = "", limit: int = 10):
    user = _require_user(request)
    return {"ok": True, "items": kb_search(user["id"], q, limit=max(1, min(limit, 50)))}


@app.post("/api/kb/add")
async def kb_add_post(request: Request):
    user = _require_user(request)
    body = await request.json()
    title = (body.get("title") or "").strip()
    text = body.get("text") or body.get("content") or ""
    source = (body.get("source") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    return {"ok": True, "document": kb_add(user["id"], title, text, source)}


@app.delete("/api/kb/delete")
async def kb_delete_post(request: Request):
    user = _require_user(request)
    body = await request.json()
    doc_id = (body.get("id") or body.get("docId") or "").strip()
    if not doc_id:
        raise HTTPException(status_code=400, detail="id required")
    return {"ok": kb_delete(user["id"], doc_id)}


# ─────────────────────────────────────────────────────────────────────────────
# Step 8 — Jobs / Cost / Notifications (real data from legacy tables)
# ─────────────────────────────────────────────────────────────────────────────


def _is_owner(user: Optional[Dict[str, Any]]) -> bool:
    return bool(user and (user.get("role") == "owner"))


@app.get("/api/jobs")
async def jobs_list(request: Request, status: Optional[str] = None, limit: int = 100):
    user = _require_user(request)
    return {"ok": True, "items": _list_jobs(user["id"], _is_owner(user), status, limit)}


@app.get("/api/jobs/{job_id}")
async def jobs_get(job_id: str, request: Request):
    user = _require_user(request)
    job = _get_job(user["id"], _is_owner(user), job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job_not_found")
    return {"ok": True, "job": job}


@app.get("/api/cost/today")
async def cost_today_get(request: Request):
    user = _require_user(request)
    return _cost_today(user["id"], _is_owner(user))


@app.get("/api/notifications")
async def notifications_list(request: Request, limit: int = 50):
    user = _require_user(request)
    return {"ok": True, "items": _list_notifications(user["id"], _is_owner(user), limit)}


@app.get("/api/notifications/summary")
async def notifications_summary_get(request: Request):
    user = _require_user(request)
    return _notifications_summary(user["id"], _is_owner(user))


@app.put("/api/notifications/read-all")
@app.post("/api/notifications/read-all")
async def notifications_read_all(request: Request):
    user = _require_user(request)
    return _mark_all_read(user["id"], _is_owner(user))


# ─────────────────────────────────────────────────────────────────────────────
# Step 9 — Operator / Gateway (real data from legacy tables)
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/operator/missions")
async def operator_missions(request: Request, limit: int = 50):
    user = _require_user(request)
    return {"ok": True, "items": _list_operator_missions(user["id"], _is_owner(user), limit)}


@app.get("/api/operator/missions/{mission_id}")
async def operator_mission_detail(mission_id: str, request: Request):
    user = _require_user(request)
    m = _get_operator_mission(user["id"], _is_owner(user), mission_id)
    if not m:
        raise HTTPException(status_code=404, detail="mission_not_found")
    return {"ok": True, "mission": m}


@app.get("/api/operator/projects")
async def operator_projects(request: Request, limit: int = 50):
    user = _require_user(request)
    return {"ok": True, "items": _list_operator_projects(user["id"], _is_owner(user), limit)}


@app.get("/api/operator/status")
async def operator_status_ep(request: Request):
    user = _require_user(request)
    return _operator_status(user["id"], _is_owner(user))


@app.get("/api/incidents")
async def incidents_list(request: Request, limit: int = 50):
    user = _require_user(request)
    return {"ok": True, "items": _list_incidents(user["id"], _is_owner(user), limit)}


@app.get("/api/gateway/status")
async def gateway_status_ep(request: Request):
    _require_user(request)
    return await _gateway_status(OPENHANDS_SERVER)


# Paths now backed by real handlers — exclude from stub registration.
_REAL_NOW = {
    "/api/jobs", "/api/cost/today", "/api/notifications",
    "/api/notifications/summary", "/api/notifications/read-all",
    "/api/operator/missions", "/api/operator/projects", "/api/operator/status",
    "/api/incidents", "/api/gateway/status",
    "/api/memory/facts", "/api/memory/project", "/api/memory/semantic",
    "/api/web/search", "/api/image/generate",
    "/api/agent/questions", "/api/agent/answer", "/api/agent/runs",
    "/api/agent/control-plane", "/api/agent/recipes", "/api/agent/self-test",
    "/api/agent/workflows",
}

for _path in _STUB_ROUTES:
    if _path in _REAL_NOW:
        continue
    # Unique operation name per stub + keep stubs out of the OpenAPI schema so
    # /docs only documents real endpoints (Step 10.4) and FastAPI doesn't warn
    # about duplicate operation IDs.
    _op_name = "stub_" + _path.strip("/").replace("/", "_").replace("{", "").replace("}", "")
    app.add_api_route(
        _path,
        _stub_response(_path),
        methods=["GET", "POST", "PUT", "DELETE"],
        name=_op_name,
        include_in_schema=False,
    )


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
