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
import base64
import fnmatch
import json
import logging
import mimetypes
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles


from core.bridge.ws_client import OpenHandsWsUnavailable, stream_openhands_events_ws

from core.database import (
    delete_key,
    get_active_key,
    get_conn,
    get_key,
    get_params,
    import_keys,
    init_db,
    list_keys,
    set_active_key,
    set_params,
    upsert_key,
)
# ── Phase 1: shared httpx client (avoids per-call connection pools) ──
_SHARED_HTTP_LIMITS = httpx.Limits(max_connections=30, max_keepalive_connections=10)
_shared_http_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    """Return a process-wide shared AsyncClient with sensible pool limits."""
    global _shared_http_client
    if _shared_http_client is None or _shared_http_client.is_closed:
        _shared_http_client = httpx.AsyncClient(
            limits=_SHARED_HTTP_LIMITS,
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=5.0),
        )
    return _shared_http_client
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
    upsert_mapping,
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
OPENHANDS_STREAM_TRANSPORT = os.environ.get("BROWSERAI_OPENHANDS_STREAM_TRANSPORT", "auto").lower()
# Step 10.1 — progressive output. OpenHands' event API delivers the assistant
# message as one complete chunk (no token stream), so we re-chunk it server-side
# into small deltas with light pacing for a typewriter feel. Tunable/disableable.
STREAM_RECHUNK = os.environ.get("BROWSERAI_STREAM_RECHUNK", "1") not in ("0", "false", "False")
STREAM_CHUNK_CHARS = int(os.environ.get("BROWSERAI_STREAM_CHUNK_CHARS", "24"))
STREAM_CHUNK_DELAY = float(os.environ.get("BROWSERAI_STREAM_CHUNK_DELAY", "0.02"))
STREAM_RECHUNK_MIN = int(os.environ.get("BROWSERAI_STREAM_RECHUNK_MIN", "48"))

# Phase 2.1 — per-chat stream lock. OpenHands conversations are stateful; two
# concurrent sends to the same conversation corrupt event boundaries and mix
# tool calls in the UI. Keep this in-process lock until the bridge is split out.
_chat_stream_locks: Dict[str, asyncio.Lock] = {}


def _stream_lock_for(chat_id: str) -> asyncio.Lock:
    key = str(chat_id or "").strip() or "__default__"
    lock = _chat_stream_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _chat_stream_locks[key] = lock
    return lock

app = FastAPI(title="BrowserAI-OpenHands Core Monolith", version="0.3.0")


@app.on_event("startup")
async def _startup_init() -> None:
    # Phase 1: AUTH_SECRET must be set in production
    _auth_secret = os.environ.get("AUTH_SECRET") or os.environ.get("SESSION_SECRET")
    _is_production = os.environ.get("NODE_ENV", "").lower() == "production"
    if not _auth_secret:
        if _is_production:
            log.error("⛔ FATAL: AUTH_SECRET is not set and NODE_ENV=production. Refusing to start.")
            raise SystemExit("AUTH_SECRET must be set in production. Set AUTH_SECRET or SESSION_SECRET env var.")
        log.warning("⚠️  AUTH_SECRET not set — auth will crash on first request!")
    elif _auth_secret in ("replace-with-another-long-random-string", "dev-secret", "replace-with-a-long-random-string", ""):
        if _is_production:
            log.error("⛔ FATAL: AUTH_SECRET is still the default value in production. Refusing to start.")
            raise SystemExit("AUTH_SECRET must not be the default value in production. Generate with: openssl rand -base64 48")
        log.warning("⚠️  AUTH_SECRET is still the default value — set a real secret!")

    try:
        init_db()
        # Phase 1: ensure WAL + busy_timeout (WAL is already set in get_conn,
        # but add busy_timeout pragma for lock contention resilience)
        conn = get_conn()
        try:
            conn.execute("PRAGMA busy_timeout=5000")
            conn.commit()
        finally:
            conn.close()
        init_auth_schema()
        init_conversations_schema()
        init_agent_state_schema()
        log.info("all schemas ready (db, auth, conversations, agent_state, vault)")
    except Exception as e:
        log.error("schema init failed: %s", e)

    # Phase 2.3: config-based OpenHands workspace mounting. BrowserAI no
    # longer remounts runtime containers or needs docker.sock.
    try:
        from core.isolation import ensure_openhands_config, ensure_sandbox_dir
        sandbox = ensure_sandbox_dir()
        oh_config = ensure_openhands_config()
        # "workspace config" not "isolation": the shared /workspace mount is an
        # organization convenience, not a per-chat security boundary (#4).
        log.info("workspace config ready: sandbox=%s openhands_config=%s", sandbox, oh_config)
    except Exception as e:
        log.warning("workspace config setup failed: %s", e)

    # Push OH settings on startup (they are lost on OH container restart)
    try:
        async with httpx.AsyncClient() as c:
            active = get_active_key(include_secret=True)
            if active:
                await provs.push_to_openhands(c, OPENHANDS_SERVER, active, get_params())
                log.info("OH settings pushed on startup")
            else:
                log.info("no active key found - skipping OH settings push on startup")
    except Exception as e:
        log.warning("OH settings push on startup failed: %s", e)



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


def _safe_chat_id_for_path(chat_id: Optional[str]) -> str:
    raw = str(chat_id or "").strip()
    safe = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in raw)
    return safe[:96] or "default"


def _chat_workspace_rel(chat_id: Optional[str]) -> str:
    return f"chats/{_safe_chat_id_for_path(chat_id)}"


def _chat_workspace_abs(chat_id: Optional[str]) -> Path:
    # _WORKSPACE_ROOT is defined in the workspace section below; Python resolves
    # it at call time. NOTE (Sonnet review #4): this is per-chat *organization*,
    # not a security boundary. The HTTP file APIs are confined to this subtree by
    # _safe_abs (rejects path-escape + escaping symlinks), but the agent RUNTIME
    # shares one /workspace mount across chats, so a prompt-injected agent could
    # still touch a sibling chat's folder. Single-tenant accepts this; do not
    # rely on chats/<id> as a trust boundary between mutually-distrusting users.
    return (_WORKSPACE_ROOT / _chat_workspace_rel(chat_id)).resolve()


def _ensure_chat_workspace(chat_id: Optional[str]) -> Optional[Path]:
    if not chat_id:
        return None
    p = _chat_workspace_abs(chat_id)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _chat_workspace_instruction(chat_id: Optional[str]) -> str:
    if not chat_id:
        return ""
    rel = _chat_workspace_rel(chat_id)
    abs_path = f"/workspace/{rel}"
    # Single-tenant: per-chat folders are kept purely to keep separate projects
    # from clobbering each other's files — NOT for multi-user isolation. So we
    # just point the agent at this chat's working directory without the old
    # "don't peek into other chats" multi-tenant warnings.
    return (
        "\n\n[BrowserAI workspace]\n"
        f"Use {abs_path} as the working directory for this chat. "
        f"Run `mkdir -p {abs_path}` if needed and prefer `cd {abs_path} && <command>` "
        "so each chat's project files stay organized in their own folder.\n"
    )


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
    # Sonnet review #10: surface schema drift. If a self-healing migration
    # failed (disk full, perms, bad DDL), EXPECTED columns will be missing and
    # routes touching them will 500. Report it here instead of failing silently.
    try:
        from core.migrations import missing_columns
        conn = get_conn()
        try:
            gaps = missing_columns(conn)
        finally:
            conn.close()
        result["schemaDrift"] = gaps
        if gaps:
            result["ok"] = False
            result["status"] = "degraded"
    except Exception as e:
        result["schemaDrift"] = f"check_failed: {e}"
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
    _require_user(request)
    return _settings_payload(request)


@app.get("/api/keys")
async def get_keys(request: Request):
    _require_user(request)
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
    _require_user(request)
    body = await request.json()
    incoming = body.get("keys") or []
    active_id = body.get("activeKeyId")
    keys = import_keys(incoming, active_id)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None, "imported": len(incoming)}


@app.post("/api/keys/{key_id}/activate")
async def activate_key(key_id: str, request: Request):
    _require_user(request)
    keys = set_active_key(key_id)
    # Push new provider into OpenHands settings so next chat uses it
    asyncio.create_task(_sync_active_provider_to_openhands(request))
    return {"keys": keys, "activeKeyId": key_id}


@app.post("/api/keys/rotate")
async def rotate_key(request: Request):
    """Step 10.8 — rotate the secret of a key in place.

    Flow (server-side, atomic from the UI's perspective):
      1) validate the NEW secret against the provider (real 1-token probe);
      2) on success, overwrite the stored secret (vault-encrypted) on the
         SAME key id — this revokes the old secret by replacement while keeping
         the key id stable so chats / OpenHands settings keep pointing at it;
      3) make it active and push to OpenHands.

    Body: { keyId?, apiKey (new secret, required), baseUrl?, model?, authType?,
            skipValidate? }. If keyId is omitted the currently-active key is used.
    """
    body = await request.json()
    new_secret = (body.get("apiKey") or "").strip()
    if not new_secret:
        raise HTTPException(status_code=400, detail="apiKey (new secret) required")

    key_id = body.get("keyId")
    stored = get_key(key_id, include_secret=True) if key_id else get_active_key(include_secret=True)
    if not stored:
        raise HTTPException(status_code=404, detail="key not found")
    key_id = stored["id"]

    # Build the provider dict we will validate against (new secret + existing
    # endpoint/model, overridable by the request).
    provider = {
        **stored,
        "apiKey": new_secret,
        "baseUrl": body.get("baseUrl") or stored.get("baseUrl"),
        "model": body.get("model") or stored.get("model"),
        "authType": body.get("authType") or stored.get("authType") or "bearer",
    }

    # 1) Validate the new secret (unless explicitly skipped).
    validation = {"ok": True, "skipped": True}
    if not body.get("skipValidate"):
        validation = await provs.validate_key(provider)
        if not validation.get("ok"):
            return {
                "ok": False,
                "stage": "validate",
                "message": "Новый ключ не прошёл проверку — ротация отменена, старый ключ не тронут.",
                "validation": validation,
            }

    # 2) Persist the new secret onto the same key id (vault-encrypted if unlocked).
    user = current_user(request)
    to_store = new_secret
    if user and vlt.is_available():
        st = vlt.status(user["id"])
        if st.get("enabled") and not st.get("locked"):
            enc = vlt.encrypt(user["id"], new_secret)
            if enc:
                to_store = enc
    record = {
        **{k: v for k, v in stored.items() if k not in ("apiKey", "maskedApiKey")},
        "id": key_id,
        "apiKey": to_store,
        "baseUrl": provider["baseUrl"],
        "model": provider["model"],
        "isActive": True,
    }
    keys = upsert_key(record)
    set_active_key(key_id)

    # 3) Push to OpenHands so the next chat uses the new secret immediately.
    asyncio.create_task(_sync_active_provider_to_openhands(request))

    safe_keys = list_keys(include_secrets=False)
    return {
        "ok": True,
        "stage": "rotated",
        "message": "Ключ успешно заменён. Старый секрет перезаписан.",
        "validation": validation,
        "keys": safe_keys,
        "activeKeyId": key_id,
    }


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


def _parse_oh_ts(value: Any, fallback_ms: Optional[int] = None) -> int:
    """OpenHands returns ISO strings; BrowserAI chats use epoch millis."""
    if isinstance(value, (int, float)):
        # Be tolerant of either seconds or millis.
        return int(value if value > 10_000_000_000 else value * 1000)
    if isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            pass
    return fallback_ms if fallback_ms is not None else int(time.time() * 1000)


def _browserai_chat_id_for_oh(conversation_id: str, mapping_by_cid: Optional[Dict[str, str]] = None) -> str:
    if mapping_by_cid and conversation_id in mapping_by_cid:
        return mapping_by_cid[conversation_id]
    return f"oh_{conversation_id}"


def _mapping_by_conversation_id() -> Dict[str, str]:
    init_conversations_schema()
    conn = get_conn()
    try:
        rows = conn.execute("SELECT chat_id, conversation_id FROM chat_conversations").fetchall()
        return {r["conversation_id"]: r["chat_id"] for r in rows if r["conversation_id"] and r["chat_id"]}
    finally:
        conn.close()


def _last_oh_event_id(events: List[Dict[str, Any]]) -> int:
    vals = []
    for e in events or []:
        try:
            vals.append(int(e.get("id", -1)))
        except Exception:
            pass
    return max(vals) if vals else -1


def _oh_events_to_browserai_messages(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Lossy but practical import of OpenHands history into BrowserAI chat.

    We only turn real user/assistant chat messages into BrowserAI messages and
    skip environment noise, recall actions and the giant system prompt event.
    Tool/action events still remain accessible through /api/agent/runs/<chat>/history.
    """
    out: List[Dict[str, Any]] = []
    for e in events or []:
        source = e.get("source")
        action = e.get("action")
        args = e.get("args") or {}
        text = args.get("content") if isinstance(args, dict) else None
        if not text:
            text = e.get("message") or e.get("content") or ""
        text = str(text or "").strip()
        if not text:
            continue
        # Skip OpenHands' injected system prompt and helper user actions. Keep
        # agent `finish` as a normal assistant message: many file/edit tasks end
        # with action=finish + args.final_thought rather than action=message.
        if source == "agent" and action == "finish":
            text = str((args.get("final_thought") if isinstance(args, dict) else "") or text or "Done.").strip()
        elif source == "agent" and action != "message":
            continue
        if source == "user" and action != "message":
            continue
        if source == "agent" and text.startswith("You are OpenHands agent"):
            continue
        if source not in ("user", "agent"):
            continue
        ts = _parse_oh_ts(e.get("timestamp"))
        role = "assistant" if source == "agent" else "user"
        item: Dict[str, Any] = {
            "id": f"oh_evt_{e.get('id', uuid.uuid4().hex[:8])}",
            "role": role,
            "content": text,
            "createdAt": ts,
        }
        if role == "assistant":
            item.update({"pending": False, "agent": True, "toolCalls": []})
        else:
            item["attachments"] = []
        out.append(item)
    return out


async def _fetch_oh_conversations_for_cloud(limit: int = 100) -> List[Dict[str, Any]]:
    """Read OpenHands' own conversation store and convert it to BrowserAI chats.

    This is the missing part that caused the visible mismatch: OpenHands kept
    20+ sessions, while BrowserAI only rendered the local/cloud BrowserAI chat
    list. We merge the OH list into /api/cloud so login/reload shows both.
    """
    chats: List[Dict[str, Any]] = []
    mapping_by_cid = _mapping_by_conversation_id()
    async with httpx.AsyncClient(timeout=20.0) as client:
        page_id: Optional[str] = None
        fetched = 0
        while fetched < limit:
            params: Dict[str, Any] = {"limit": min(100, limit - fetched)}
            if page_id:
                params["page_id"] = page_id
            r = await client.get(f"{OPENHANDS_SERVER}/api/conversations", params=params)
            if r.status_code >= 400:
                break
            body = r.json()
            items = body if isinstance(body, list) else (body.get("results") or [])
            if not items:
                break
            for conv in items:
                cid = conv.get("conversation_id") or conv.get("id")
                if not cid:
                    continue
                chat_id = _browserai_chat_id_for_oh(str(cid), mapping_by_cid)
                events: List[Dict[str, Any]] = []
                try:
                    er = await client.get(
                        f"{OPENHANDS_SERVER}/api/conversations/{cid}/events",
                        params={"limit": 100},
                        timeout=20.0,
                    )
                    if er.status_code == 200:
                        eb = er.json()
                        events = eb if isinstance(eb, list) else (eb.get("events") or eb.get("results") or [])
                except Exception:
                    events = []
                created = _parse_oh_ts(conv.get("created_at") or conv.get("createdAt"))
                updated = _parse_oh_ts(conv.get("last_updated_at") or conv.get("updated_at"), created)
                title = (conv.get("title") or "").strip() or f"OpenHands {str(cid)[:8]}"
                messages = _oh_events_to_browserai_messages(events)
                # Keep the mapping, so selecting this imported chat and sending
                # a new message continues the SAME OpenHands conversation.
                try:
                    upsert_mapping(chat_id, str(cid), None)
                    if events:
                        update_last_event(chat_id, _last_oh_event_id(events))
                except Exception:
                    pass
                chats.append({
                    "id": chat_id,
                    "title": title,
                    "createdAt": created,
                    "updatedAt": updated,
                    "summary": "",
                    "summarizedUntil": 0,
                    "messages": messages,
                    "openhands": {
                        "conversationId": str(cid),
                        "status": conv.get("status"),
                        "runtimeStatus": conv.get("runtime_status"),
                        "conversationVersion": conv.get("conversation_version"),
                        "trigger": conv.get("trigger"),
                    },
                })
                fetched += 1
                if fetched >= limit:
                    break
            page_id = body.get("next_page_id") if isinstance(body, dict) else None
            if not page_id:
                break
    return chats


async def _cloud_with_openhands_chats(user_id: str) -> Dict[str, Any]:
    data = cloud_load(user_id)
    try:
        imported = await _fetch_oh_conversations_for_cloud(
            int(os.environ.get("BROWSERAI_IMPORT_OPENHANDS_CHATS_LIMIT", "100"))
        )
    except Exception as e:
        log.warning("OpenHands conversation import skipped: %s", e)
        # If OpenHands is temporarily unavailable, return an empty chat list
        # instead of resurrecting BrowserAI's old cached copy. OpenHands is the
        # source of truth; BrowserAI is only the shell.
        data["chats"] = []
        data["openhandsImported"] = 0
        data["openhandsError"] = str(e)
        return data

    # IMPORTANT MERGE POLICY:
    # OpenHands is canonical for chat/conversation history. BrowserAI must not
    # keep a second persisted chat list and then merge it back, because that is
    # exactly how deleted/stale chats reappear. The UI may keep transient local
    # state while a stream is running, but reload/login should render the OH
    # conversation store directly.
    data["chats"] = sorted(imported, key=lambda c: int(c.get("updatedAt") or 0), reverse=True)
    data["openhandsImported"] = len(imported)
    data["chatSource"] = "openhands"
    return data


@app.get("/api/cloud")
async def cloud_get(request: Request):
    user = current_user(request)
    if not user:
        # Allow anon read with empty payload so UI's CloudSync doesn't crash.
        return {"settings": None, "chats": None, "updatedAt": 0}
    return await _cloud_with_openhands_chats(user["id"])


@app.get("/api/openhands/conversations")
async def openhands_conversations():
    """Debug/sync endpoint for the BrowserAI↔OpenHands merge."""
    chats = await _fetch_oh_conversations_for_cloud(
        int(os.environ.get("BROWSERAI_IMPORT_OPENHANDS_CHATS_LIMIT", "100"))
    )
    return {"ok": True, "count": len(chats), "chats": chats}


@app.put("/api/cloud")
async def cloud_put(request: Request): 
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="auth_required")
    body = await request.json()
    # BrowserAI is an OpenHands shell: persist user settings, but do NOT persist
    # BrowserAI's local chat array as canonical history. Chat history is read
    # from OpenHands on /api/cloud. Keeping local chats here would create a
    # second source of truth and resurrect stale/deleted conversations.
    return cloud_save(user["id"], body.get("settings"), [])


# ─────────────────────────────────────────────────────────────────────────────
# Chats — rename / delete (OpenHands-backed)
# ─────────────────────────────────────────────────────────────────────────────

@app.patch("/api/chats/{chat_id}")
@app.put("/api/chats/{chat_id}")
async def rename_chat(chat_id: str, request: Request):
    """Rename a BrowserAI chat → OpenHands conversation title.
    
    Body: { "title": "..." }
    Returns: { ok: true, chatId, title, conversationId }
    """
    body = await request.json()
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title required")
    if len(title) > 200:
        title = title[:200]
    
    # Find OpenHands conversation_id for this BrowserAI chat_id
    m = get_mapping(chat_id)
    if not m:
        # No OH conversation yet (chat never sent) — nothing to rename in OH,
        # return ok so UI can keep local title. Next /api/cloud will still
        # pull from OH once conversation is created.
        return {"ok": True, "chatId": chat_id, "title": title, "conversationId": None, "local_only": True}
    
    cid = m["conversation_id"]
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.patch(
                f"{OPENHANDS_SERVER}/api/conversations/{cid}",
                json={"title": title},
            )
            if r.status_code == 404:
                raise HTTPException(status_code=404, detail="conversation_not_found_in_openhands")
            if r.status_code >= 400:
                # Try to surface OH error details
                try:
                    detail = r.json()
                except Exception:
                    detail = r.text
                raise HTTPException(status_code=502, detail=f"openhands_rename_failed: {detail}")
            ok = r.json() if r.headers.get("content-type", "").startswith("application/json") else True
            if ok is False:
                raise HTTPException(status_code=502, detail="openhands_rename_rejected")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"openhands_unreachable: {e}")

    return {"ok": True, "chatId": chat_id, "title": title, "conversationId": cid}


# ── Phase 1: Fast chat list + lazy message loading ────────────────────────
# These endpoints decouple chat list rendering from full history loading.
# The UI can show the sidebar instantly and fetch messages on demand.

@app.get("/api/chats/list")
async def chats_list(request: Request):
    """Return lightweight chat metadata only (no messages).
    Merges BrowserAI's cloud_state chats with OpenHands conversations.
    This is the fast path for sidebar rendering."""
    user = current_user(request)
    if not user:
        return {"chats": [], "updatedAt": 0}

    # Get cloud_state settings (which chats the user has locally)
    cloud = cloud_load(user["id"])
    local_chats = cloud.get("chats") or []

    # Fetch OH conversations for titles + last_updated
    try:
        oh_chats = await _fetch_oh_conversations_for_cloud(limit=100)
    except Exception:
        oh_chats = []

    # Build a merged list: OH conversations are canonical, local chats fill gaps
    seen_cids = set()
    merged = []

    # First: OH conversations (canonical source)
    for oc in oh_chats:
        cid = oc.get("conversation_id") or oc.get("id")
        seen_cids.add(cid)
        merged.append({
            "id": oc.get("chat_id") or cid,  # BrowserAI chat_id or fallback
            "conversationId": cid,
            "title": oc.get("title") or "Без названия",
            "updatedAt": oc.get("last_updated") or 0,
            "source": "openhands",
        })

    # Then: local-only chats not yet in OH (created but never sent)
    for lc in local_chats:
        cid = (lc.get("openhands") or {}).get("conversationId")
        chat_id = lc.get("id")
        if chat_id and chat_id not in {m["id"] for m in merged}:
            merged.append({
                "id": chat_id,
                "conversationId": cid,
                "title": lc.get("title") or "Без названия",
                "updatedAt": lc.get("updatedAt") or 0,
                "source": "local",
            })

    # Sort by updatedAt desc
    merged.sort(key=lambda c: c.get("updatedAt", 0), reverse=True)
    return {"chats": merged, "updatedAt": int(time.time() * 1000)}


@app.get("/api/chats/{chat_id}/messages")
async def chat_messages(chat_id: str, request: Request, limit: int = 100):
    """Lazy-load messages for a specific chat.
    Fetches events from OpenHands and converts them to BrowserAI message format.
    Returns recent events (configurable via limit query param)."""
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="auth_required")

    m = get_mapping(chat_id)
    if not m:
        return {"messages": [], "chatId": chat_id, "conversationId": None}

    cid = m["conversation_id"]
    last_event_id = m.get("last_event_id", -1)

    try:
        client = get_http_client()
        r = await client.get(
            f"{OPENHANDS_SERVER}/api/conversations/{cid}/events?limit={limit}",
            timeout=20.0,
        )
        if r.status_code == 404:
            return {"messages": [], "chatId": chat_id, "conversationId": cid, "error": "conversation_not_found"}
        if r.status_code >= 400:
            return {"messages": [], "chatId": chat_id, "conversationId": cid, "error": "openhands_error"}

        body = r.json()
        events = body if isinstance(body, list) else (body.get("events") or body.get("results") or [])

        # Convert events to BrowserAI message format
        messages = []
        current_user_msg = None
        current_assistant_msg = None

        for e in events:
            eid = e.get("id", 0)
            if eid <= last_event_id:
                continue

            action = e.get("action", "")
            observation = e.get("observation", "")
            args = e.get("args") or {}
            extras = e.get("extras") or {}

            # User message
            if action == "message":
                content = args.get("content") or args.get("text") or ""
                if content:
                    if current_assistant_msg:
                        messages.append(current_assistant_msg)
                        current_assistant_msg = None
                    current_user_msg = {
                        "id": f"evt-{eid}",
                        "role": "user",
                        "content": content,
                        "timestamp": e.get("timestamp"),
                    }
                    messages.append(current_user_msg)
                    current_user_msg = None

            # Assistant message
            elif observation == "assistant":
                content = extras.get("content") or args.get("content") or ""
                if content:
                    thinking, clean = _split_think(content)
                    current_assistant_msg = {
                        "id": f"evt-{eid}",
                        "role": "assistant",
                        "content": clean,
                        "thinking": thinking or None,
                        "timestamp": e.get("timestamp"),
                    }
                    messages.append(current_assistant_msg)

            # Tool calls
            elif observation and observation not in ("agent_state_changed",):
                if current_assistant_msg is None:
                    current_assistant_msg = {
                        "id": f"evt-{eid}-tools",
                        "role": "assistant",
                        "content": "",
                        "toolCalls": [],
                        "timestamp": e.get("timestamp"),
                    }
                tc = {
                    "name": observation,
                    "args": args,
                    "result": extras,
                    "status": "done",
                    "ok": not extras.get("error"),
                }
                current_assistant_msg.setdefault("toolCalls", []).append(tc)

        # Don't forget the last assistant msg
        if current_assistant_msg and current_assistant_msg not in messages:
            messages.append(current_assistant_msg)

        return {"messages": messages, "chatId": chat_id, "conversationId": cid}

    except Exception as e:
        log.warning("chat_messages fetch failed: %s", e)
        return {"messages": [], "chatId": chat_id, "conversationId": cid, "error": str(e)}


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
    """Parse an explicit ask-user marker from model text.

    In OpenHands bridge mode, normal assistant replies often end with a human
    question like "How can I help you today?". BrowserAI must render that as a
    regular assistant message, NOT as an interactive ask_user card. Therefore
    only an explicit marker is accepted:

        ASK_USER:{"question":"...","options":[{"id":"a","label":"A"}]}
    """
    if not text:
        return None
    m = _re.search(r"ASK_USER\s*:\s*(\{.*\})", text, _re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
        q = (data.get("question") or "").strip()
        opts = data.get("options") or []
        if q:
            return {"question": q, "options": opts}
    except Exception:
        pass
    return None


def _strip_ask_user_marker(text: str) -> str:
    """Remove an ASK_USER:{...} marker (and its trailing JSON) from text.

    Bug 3.1: the raw ``ASK_USER:{"question":...}`` marker must never reach the
    user as assistant text — it is machine syntax the UI renders as a card.
    We drop the marker starting at ``ASK_USER:`` through the balanced JSON
    object that follows, then tidy surrounding whitespace.
    """
    if not text:
        return text
    m = _re.search(r"ASK_USER\s*:\s*", text, _re.DOTALL)
    if not m:
        return text
    start = m.start()
    # Find the balanced JSON object that follows the marker prefix.
    brace_start = text.find("{", m.end() - 1)
    if brace_start == -1:
        return text[:start].rstrip()
    depth = 0
    end = None
    in_str = False
    esc = False
    for i in range(brace_start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        # Unbalanced — drop from the marker onward.
        return text[:start].rstrip()
    cleaned = (text[:start] + text[end:]).strip()
    return cleaned


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


async def _prepare_openhands_turn(
    client: httpx.AsyncClient,
    chat_id: str,
    model: str,
    prompt: str,
    extra_system: str,
    provider: Dict[str, Any],
    user_id: Optional[str] = None,
    turn_id: str = "",
) -> Tuple[str, bool, int]:
    """Push settings, create/reuse OpenHands conversation and send prompt.

    Context prefix (warm-start summary) is fetched BEFORE the new prompt
    is sent, so (a) it appears before the question in the transcript and
    (b) the just-sent prompt is not duplicated in the context summary.
    """
    await _push_oh_settings(client, provider)
    if chat_id:
        _ensure_chat_workspace(chat_id)
    isolated_extra_system = (extra_system or "") + _chat_workspace_instruction(chat_id)
    isolated_prompt = prompt
    if chat_id:
        isolated_prompt = f"{prompt}\n\n[Use workspace: /workspace/{_chat_workspace_rel(chat_id)}]"

    # Phase 1.3 memory context for warm reuse.
    # Fetch BEFORE get_or_create_conversation() so that:
    #   (a) the just-sent prompt is NOT yet in the event list → no duplication
    #   (b) context can be folded into conversation_instructions to appear
    #       BEFORE the new question in the LLM's transcript
    context_prefix = ""
    mapping = get_mapping(chat_id) if chat_id else None
    if mapping and mapping.get("last_event_id", -1) >= 0:
        pre_cid = mapping["conversation_id"]
        if await conversation_alive(client, OPENHANDS_SERVER, pre_cid):
            try:
                ctx_r = await client.get(
                    f"{OPENHANDS_SERVER}/api/conversations/{pre_cid}/events?limit=80",
                    timeout=15.0,
                )
                if ctx_r.status_code == 200:
                    ctx_body = ctx_r.json()
                    ctx_events = ctx_body if isinstance(ctx_body, list) else (ctx_body.get("events") or [])
                    recent_turns = []
                    for ce in ctx_events[-50:]:
                        ce_action = ce.get("action", "")
                        ce_obs = ce.get("observation", "")
                        ce_args = ce.get("args") or {}
                        ce_extras = ce.get("extras") or {}
                        if ce_action == "message":
                            msg = ce_args.get("content") or ce_args.get("text") or ""
                            if msg:
                                recent_turns.append(f"User: {msg[:700]}")
                        elif ce_obs == "assistant":
                            msg = ce_extras.get("content") or ce_args.get("content") or ce_extras.get("message") or ""
                            if msg:
                                _, clean_msg = _split_think(msg)
                                clean_msg = (clean_msg or msg).strip()
                                if clean_msg:
                                    recent_turns.append(f"Assistant: {clean_msg[:700]}")
                    recent_turns = recent_turns[-20:]
                    if recent_turns:
                        context_prefix = (
                            "[Previous turns in this conversation; use as continuity context, "
                            "do not repeat verbatim]\n" + "\n".join(recent_turns)
                        )
                        log.debug("loaded warm context prefix for chat_id=%s turns=%d chars=%d", chat_id, len(recent_turns), len(context_prefix))
            except Exception as e:
                log.debug("context prefix fetch failed (non-critical): %s", e)

    # Fold context_prefix into conversation_instructions so it appears
    # BEFORE the user's new question in the LLM transcript, rather than
    # sending it as a separate /message after the prompt.
    if context_prefix:
        isolated_extra_system = context_prefix + "\n\n" + isolated_extra_system

    cid, was_created, last_seen_event_id = await get_or_create_conversation(
        client,
        OPENHANDS_SERVER,
        chat_id,
        user_id,
        isolated_prompt,
        isolated_extra_system,
        turn_id=turn_id,
    )

    if chat_id:
        upsert_run(chat_id, cid, user_id, "running", last_prompt=prompt, last_event_id=last_seen_event_id, last_turn_id=turn_id)
    try:
        from core.obslog import bind_conversation as _bind_conv
        _bind_conv(cid)
    except Exception:
        pass
    return cid, was_created, last_seen_event_id


def _is_turn_complete_event(e: Dict[str, Any]) -> bool:
    state = ((e.get("extras") or {}).get("agent_state") or "").lower()
    return (
        e.get("observation") == "agent_state_changed"
        and state in ("finished", "stopped", "error", "awaiting_user_input")
    )


async def _emit_translated_event(
    translated: Dict[str, Any],
    *,
    chat_id: str,
    cid: str,
    user_id: Optional[str],
    step: int,
    full_answer_ref: Dict[str, str],
    ask_user_sent_ref: Dict[str, bool],
) -> AsyncIterator[Tuple[bytes, int]]:
    ev_name = translated["event"]
    ev_data = translated["data"]
    if ev_name == "tool_start":
        step += 1
        ev_data["step"] = step
    if ev_name in ("tool_start", "tool_result") and chat_id:
        try:
            _ledger_tool_event(chat_id, cid, user_id, ev_name, ev_data)
        except Exception as e:
            log.debug("tool ledger skipped: %s", e)
    if ev_name == "assistant_delta":
        full_answer_ref["text"] += ev_data.get("chunk", "")
        if not ask_user_sent_ref["sent"] and chat_id:
            ask_payload = _extract_ask_user_payload(full_answer_ref["text"])
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
                ).encode("utf-8"), step
                ask_user_sent_ref["sent"] = True
    # Bug 3.1: once the running buffer contains an ASK_USER marker, stop
    # streaming assistant_delta chunks — the raw marker JSON would otherwise
    # leak into the UI character by character. The cleaned final `assistant`
    # event (emitted after the turn) carries any legitimate prose.
    if ev_name == "assistant_delta" and _re.search(r"ASK_USER\s*:", full_answer_ref.get("text", "")):
        return
    if (
        ev_name == "assistant_delta"
        and STREAM_RECHUNK
        and len(ev_data.get("chunk", "")) > STREAM_RECHUNK_MIN
    ):
        _whole = ev_data.get("chunk", "")
        _step = ev_data.get("step")
        for _piece in _chunk_text(_whole, STREAM_CHUNK_CHARS):
            yield _sse("assistant_delta", {"step": _step, "chunk": _piece}).encode("utf-8"), step
            if STREAM_CHUNK_DELAY > 0:
                await asyncio.sleep(STREAM_CHUNK_DELAY)
    else:
        yield _sse(ev_name, ev_data).encode("utf-8"), step


async def _poll_openhands_events(
    client: httpx.AsyncClient,
    cid: str,
    *,
    chat_id: str,
    user_id: Optional[str],
    start_after_id: int,
    initial_seen_ids: Optional[set] = None,
    step: int = 0,
    full_answer_ref: Optional[Dict[str, str]] = None,
    ask_user_sent_ref: Optional[Dict[str, bool]] = None,
    timeout_s: Optional[int] = None,
) -> AsyncIterator[Tuple[bytes, int, bool, set]]:
    seen_ids = set(initial_seen_ids or set())
    next_start_id = start_after_id + 1 if start_after_id >= 0 else 0
    full_answer_ref = full_answer_ref or {"text": ""}
    ask_user_sent_ref = ask_user_sent_ref or {"sent": False}
    t0 = time.time()
    last_event_ts = time.time()
    done = False
    timeout_s = timeout_s or EVENT_POLL_TIMEOUT_S
    log.info("agent.poll.start cid=%s chat_id=%s start_after=%s seen=%s timeout=%s", cid, chat_id, start_after_id, len(seen_ids), timeout_s)

    while not done and (time.time() - t0) < timeout_s:
        try:
            r = await client.get(f"{OPENHANDS_SERVER}/api/conversations/{cid}/events?limit=100", timeout=20.0)
            if r.status_code == 404:
                yield _sse("error", {"message": "OpenHands conversation lost"}).encode("utf-8"), step, True, seen_ids
                if chat_id:
                    drop_mapping(chat_id)
                return
            if r.status_code >= 400:
                await asyncio.sleep(EVENT_POLL_INTERVAL)
                continue
            body = r.json()
            events = body if isinstance(body, list) else (body.get("events") or body.get("results") or [])
            new_events = [e for e in events if e.get("id") not in seen_ids]
            log.info("agent.poll.tick cid=%s total=%s new=%s", cid, len(events), len(new_events))
            for e in new_events:
                seen_ids.add(e.get("id"))
                last_event_ts = time.time()
                eid = int(e.get("id", -1))
                if eid >= next_start_id:
                    next_start_id = eid + 1
                log.info("agent.poll.event cid=%s event_id=%s action=%s obs=%s", cid, e.get("id"), e.get("action"), e.get("observation"))
                if _is_turn_complete_event(e):
                    done = True
                for translated in _translate_event(e, step + 1):
                    async for chunk, step in _emit_translated_event(
                        translated,
                        chat_id=chat_id,
                        cid=cid,
                        user_id=user_id,
                        step=step,
                        full_answer_ref=full_answer_ref,
                        ask_user_sent_ref=ask_user_sent_ref,
                    ):
                        yield chunk, step, done, seen_ids
                # Bug 3.3: an emitted ask_user IS a turn boundary. Once the
                # agent has posed a question it is waiting on the user, so end
                # this turn cleanly (release the per-chat lock, close the SSE
                # stream) instead of polling for up to 180s. The user's answer
                # relayed via /api/agent/answer starts the next turn.
                if ask_user_sent_ref.get("sent"):
                    done = True
        except httpx.TimeoutException:
            pass
        except Exception as e:
            log.warning("event poll error: %s", e)

        if done:
            break
        # Check live conversation status before considering idle-finish.
        # Previously a bare 8-second quiet window was treated as turn
        # completion, which prematurely ended long-running tool calls
        # (builds, test suites, downloads routinely have >8s gaps).
        # Now we only declare done if the conversation status confirms it,
        # or if we already have a turn-complete event.
        try:
            rs = await client.get(f"{OPENHANDS_SERVER}/api/conversations/{cid}", timeout=10.0)
            if rs.status_code == 200:
                status = ((rs.json() or {}).get("conversation_status") or "").upper()
                if status in ("STOPPED", "FINISHED", "COMPLETED", "ERROR"):
                    done = True
                    break
                # If the conversation is still RUNNING/PAUSED/AWAITING_USER_INPUT,
                # do NOT declare done just because events are quiet — the agent
                # may be executing a long tool call with no intermediate events.
        except Exception:
            pass
        # 180-second absolute watchdog: if no events for 3 minutes, the
        # agent is genuinely stuck or the conversation was lost.
        if (time.time() - last_event_ts) > 180:
            log.warning("agent.poll.timeout cid=%s step=%s seen=%s", cid, step, len(seen_ids))
            yield _sse("error", {"code": "agent_timeout", "message": "Agent timed out (no events for 3 min)."}).encode("utf-8"), step, False, seen_ids
            break
        await asyncio.sleep(EVENT_POLL_INTERVAL)
    log.info("agent.poll.end cid=%s done=%s step=%s seen=%s answer_chars=%s", cid, done, step, len(seen_ids), len(full_answer_ref.get("text", "")))
    yield b"", step, done, seen_ids


async def _stream_chat_ws(
    client: httpx.AsyncClient,
    cid: str,
    *,
    chat_id: str,
    user_id: Optional[str],
    last_seen_event_id: int,
    was_created: bool,
    step: int,
    full_answer_ref: Dict[str, str],
    ask_user_sent_ref: Dict[str, bool],
    seen_ids: Optional[set] = None,
) -> AsyncIterator[Tuple[bytes, int, bool, set]]:
    """Phase 2.1: stream OpenHands Socket.IO events, fallback handled by caller."""
    if seen_ids is None:
        seen_ids = set()
    if not was_created and last_seen_event_id >= 0 and not seen_ids:
        seen_ids.update(range(0, last_seen_event_id + 1))
    done = False
    t0 = time.time()
    last_event_ts = time.time()
    log.info("agent.ws.start cid=%s chat_id=%s last_seen=%s was_created=%s", cid, chat_id, last_seen_event_id, was_created)
    async for e in stream_openhands_events_ws(OPENHANDS_SERVER, cid, last_seen_event_id):
        eid_raw = e.get("id")
        if eid_raw in seen_ids:
            continue
        seen_ids.add(eid_raw)
        last_event_ts = time.time()
        if _is_turn_complete_event(e):
            done = True
        log.info("agent.ws.event cid=%s event_id=%s action=%s obs=%s", cid, e.get("id"), e.get("action"), e.get("observation"))
        for translated in _translate_event(e, step + 1):
            async for chunk, step in _emit_translated_event(
                translated,
                chat_id=chat_id,
                cid=cid,
                user_id=user_id,
                step=step,
                full_answer_ref=full_answer_ref,
                ask_user_sent_ref=ask_user_sent_ref,
            ):
                yield chunk, step, done, seen_ids
        if done:
            break
        if (time.time() - t0) > EVENT_POLL_TIMEOUT_S:
            break
        if (time.time() - last_event_ts) > 180:
            yield _sse("error", {"code": "agent_timeout", "message": "Agent timed out (no events for 3 min)."}).encode("utf-8"), step, False, seen_ids
            break
    log.info("agent.ws.end cid=%s done=%s step=%s seen=%s answer_chars=%s", cid, done, step, len(seen_ids), len(full_answer_ref.get("text", "")))
    yield b"", step, done, seen_ids


async def _stream_chat(
    chat_id: str,
    model: str,
    prompt: str,
    extra_system: str,
    provider: Dict[str, Any],
    user_id: Optional[str] = None,
    turn_id: str = "",
) -> AsyncIterator[bytes]:
    step = 0
    full_answer_ref = {"text": ""}
    ask_user_sent_ref = {"sent": False}
    done = False
    seen_ids: set = set()
    was_created = False
    cid = ""

    yield _sse(
        "stream_protocol",
        {
            "version": 1,
            "events": [
                "stream_protocol", "agent_context", "agent_state", "thinking",
                "thinking_delta", "thought", "tool_preview", "tool_start",
                "tool_progress", "tool_result", "assistant_delta", "assistant",
                "done", "error",
            ],
        },
    ).encode("utf-8")
    yield _sse("agent_context", {
        "model": model or DEFAULT_MODEL,
        "provider": provider.get("baseUrl") or DEFAULT_BASE_URL,
        "maxSteps": MAX_AGENT_ITERATIONS,
        "serverRoute": "/api/agent/chat",
        "engine": "openhands",
    }).encode("utf-8")
    yield _sse("thinking", {"step": 1}).encode("utf-8")
    yield _sse("agent_state", {"phase": "plan", "step": 1, "maxSteps": MAX_AGENT_ITERATIONS, "engine": "openhands"}).encode("utf-8")

    client = get_http_client()
    log.info("agent.stream.start chat_id=%s user_id=%s model=%s prompt_chars=%s", chat_id, user_id, model, len(prompt or ""))
    try:
        cid, was_created, last_seen_event_id = await _prepare_openhands_turn(
            client, chat_id, model, prompt, extra_system, provider, user_id, turn_id=turn_id
        )
        log.info("agent.stream.prepared chat_id=%s cid=%s was_created=%s last_seen=%s", chat_id, cid, was_created, last_seen_event_id)
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

    yield _sse("agent_state", {
        "step": 0,
        "phase": "warm" if not was_created else "cold",
        "raw": "warm" if not was_created else "cold",
        "conversationId": cid,
    }).encode("utf-8")

    initial_seen_ids = set(range(0, last_seen_event_id + 1)) if (not was_created and last_seen_event_id >= 0) else set()
    use_ws = OPENHANDS_STREAM_TRANSPORT in ("auto", "ws", "websocket", "socketio")
    transport_used = "poll"
    if use_ws:
        # Track the last seen_ids from WS so the polling fallback can
        # resume exactly where the WS stream stopped, avoiding duplicate
        # events.  The `seen_ids` variable inside the loop is only bound
        # after at least one yield from _stream_chat_ws; if WS fails
        # before yielding anything we fall back to initial_seen_ids.
        ws_fallback_seen_ids = set(initial_seen_ids)
        ws_fallback_last_event_id = last_seen_event_id
        try:
            transport_used = "ws"
            log.info("agent.stream.transport cid=%s transport=ws", cid)
            yield _sse("agent_state", {"step": 0, "phase": "stream-ws", "raw": "websocket", "conversationId": cid}).encode("utf-8")
            ws_seen_ids = set(initial_seen_ids)
            async for chunk, step, done, seen_ids in _stream_chat_ws(
                client,
                cid,
                chat_id=chat_id,
                user_id=user_id,
                last_seen_event_id=last_seen_event_id,
                was_created=was_created,
                step=step,
                full_answer_ref=full_answer_ref,
                ask_user_sent_ref=ask_user_sent_ref,
                seen_ids=ws_seen_ids,
            ):
                # Snapshot the latest dedup state for potential WS→poll fallback.
                ws_fallback_seen_ids = set(seen_ids)
                numeric_ids = [int(x) for x in seen_ids if isinstance(x, int) or str(x).lstrip("-").isdigit()]
                if numeric_ids:
                    ws_fallback_last_event_id = max(numeric_ids)
                if chunk:
                    yield chunk
                if done:
                    break
        except OpenHandsWsUnavailable as e:
            transport_used = "poll"
            log.info("OpenHands WS unavailable; falling back to polling: %s", e)
            log.info("agent.stream.transport cid=%s transport=poll reason=ws-fallback seen=%s last_eid=%s",
                     cid, len(ws_fallback_seen_ids), ws_fallback_last_event_id)
            yield _sse("agent_state", {"step": 0, "phase": "stream-poll", "raw": "ws-fallback", "reason": str(e), "conversationId": cid}).encode("utf-8")
            async for chunk, step, done, seen_ids in _poll_openhands_events(
                client,
                cid,
                chat_id=chat_id,
                user_id=user_id,
                start_after_id=ws_fallback_last_event_id,
                initial_seen_ids=ws_fallback_seen_ids,
                step=step,
                full_answer_ref=full_answer_ref,
                ask_user_sent_ref=ask_user_sent_ref,
            ):
                if chunk:
                    yield chunk
    else:
        log.info("agent.stream.transport cid=%s transport=poll reason=config", cid)
        yield _sse("agent_state", {"step": 0, "phase": "stream-poll", "raw": "polling", "conversationId": cid}).encode("utf-8")
        async for chunk, step, done, seen_ids in _poll_openhands_events(
            client,
            cid,
            chat_id=chat_id,
            user_id=user_id,
            start_after_id=last_seen_event_id,
            initial_seen_ids=initial_seen_ids,
            step=step,
            full_answer_ref=full_answer_ref,
            ask_user_sent_ref=ask_user_sent_ref,
        ):
            if chunk:
                yield chunk

    log.info("agent.stream.after-events cid=%s done=%s step=%s answer_chars=%s transport=%s", cid, done, step, len(full_answer_ref.get("text", "")), transport_used)
    full_answer = full_answer_ref["text"]
    if done and step <= 0 and not full_answer.strip():
        log.warning("agent.stream.empty-turn chat_id=%s cid=%s transport=%s", chat_id, cid, transport_used)
        yield _sse("error", {"code": "empty_turn", "message": "OpenHands completed turn with no text output."}).encode("utf-8")
        yield _sse("done", {"reason": "empty-turn", "steps": step, "conversationId": cid, "reused": not was_created, "transport": transport_used}).encode("utf-8")
        return
    if full_answer:
        _, clean = _split_think(full_answer)
        if clean:
            if not ask_user_sent_ref["sent"] and chat_id:
                ask_payload = _extract_ask_user_payload(clean)
                if ask_payload:
                    qid = f"q_{uuid.uuid4().hex[:12]}"
                    create_question(qid, chat_id, cid, user_id, ask_payload.get("question") or "", ask_payload.get("options") or [])
                    yield _sse("ask_user", {"question_id": qid, "question": ask_payload.get("question"), "options": ask_payload.get("options") or []}).encode("utf-8")
                    ask_user_sent_ref["sent"] = True
            # Bug 3.1: never surface the raw ASK_USER:{...} marker as assistant
            # text — it is machine syntax already rendered as an interactive card.
            clean = _strip_ask_user_marker(clean)
            if clean:
                yield _sse("assistant", {"step": step, "text": clean}).encode("utf-8")
    elif step > 0 and done:
        yield _sse("assistant", {"step": step, "text": "Done."}).encode("utf-8")

    if chat_id and seen_ids:
        try:
            numeric_ids = [int(x) for x in seen_ids if isinstance(x, int) or str(x).lstrip("-").isdigit()]
            max_seen = max(numeric_ids) if numeric_ids else last_seen_event_id
            # Bug 2.2 fix: only advance the persisted event cursor when the turn
            # actually completed (done=True). On a timeout/broken stream the
            # agent may still emit events > max_seen that the client never saw;
            # if we moved the cursor to max_seen here, those events would be
            # skipped forever on the next turn. Leaving the cursor at its prior
            # value lets the unseen tail replay. Run status is still recorded.
            cursor = max_seen if done else last_seen_event_id
            update_last_event(chat_id, cursor)
            # Bug #3 (Sonnet review): distinguish "paused for a question" from
            # "genuinely finished". If this turn ended only because the agent
            # asked the user something (ask_user_sent), the conversation is NOT
            # done — the agent will resume after /api/agent/answer. Writing
            # "done" here made Stop a no-op (already_finished guard) and hid the
            # fact that work continues. Use "awaiting_input" so Stop/resume can
            # tell the difference.
            final_status = "awaiting_input" if ask_user_sent_ref.get("sent") else ("done" if done else "timeout")
            set_run_status(chat_id, final_status)
            upsert_run(chat_id, cid, user_id, final_status, last_prompt=prompt, last_event_id=cursor)
        except Exception as e:
            log.warning("update_last_event failed: %s", e)
    elif chat_id:
        try:
            final_status = "awaiting_input" if ask_user_sent_ref.get("sent") else ("done" if done else "timeout")
            set_run_status(chat_id, final_status)
        except Exception:
            pass

    log.info("agent.stream.done chat_id=%s cid=%s done=%s step=%s transport=%s", chat_id, cid, done, step, transport_used)
    yield _sse("done", {
            "reason": "complete" if done else "timeout",
            "steps": step,
            "conversationId": cid,
            "reused": not was_created,
            "transport": transport_used,
        }).encode("utf-8")


async def _locked_stream_chat(
    chat_id: str,
    model: str,
    prompt: str,
    extra_system: str,
    provider: Dict[str, Any],
    user_id: Optional[str] = None,
    turn_id: str = "",
) -> AsyncIterator[bytes]:
    """Phase 2.1: prevent concurrent streams for the same BrowserAI chat."""
    lock: Optional[asyncio.Lock] = None
    acquired = False
    if chat_id:
        lock = _stream_lock_for(chat_id)
        # Bug 1.2 fix: acquire atomically with a short timeout instead of the
        # old check-then-acquire (TOCTOU). Previously `if lock.locked(): return`
        # followed by an unbounded `await lock.acquire()` meant that if another
        # request grabbed the lock in between, this coroutine blocked forever.
        # A bounded wait_for both closes the race and guarantees we never hang.
        try:
            await asyncio.wait_for(lock.acquire(), timeout=0.25)
            acquired = True
        except asyncio.TimeoutError:
            # Sonnet #9: the busy error fires BEFORE the turn_id idempotency
            # check in get_or_create_conversation, so a duplicate submit of the
            # SAME turn (flaky-mobile retry) surfaces as a user-visible error
            # instead of a harmless no-op. If the in-flight run already owns this
            # exact turn_id, treat the retry as a duplicate: close the stream
            # cleanly (the original stream is delivering the real events) rather
            # than shouting "busy".
            if turn_id and chat_id:
                try:
                    run = get_run(chat_id)
                    if run and run.get("last_turn_id") == turn_id and (run.get("status") or "").lower() in ("running", "awaiting_input", "paused"):
                        log.info("duplicate turn_id=%s hit busy lock for chat_id=%s — treating as no-op", turn_id, chat_id)
                        yield _sse("done", {"reason": "duplicate-turn", "chatId": chat_id}).encode("utf-8")
                        return
                except Exception:
                    pass
            yield _sse("error", {"code": "busy", "message": "This chat is already running an agent task. Wait for completion or press Stop."}).encode("utf-8")
            yield _sse("done", {"reason": "busy", "chatId": chat_id}).encode("utf-8")
            return
    try:
        async for chunk in _stream_chat(chat_id, model, prompt, extra_system, provider, user_id=user_id, turn_id=turn_id):
            yield chunk
    finally:
        # Only release if WE acquired it (never release another turn's lock).
        if acquired and lock is not None:
            lock.release()


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
    turn_id = body.get("turnId") or body.get("turn_id") or ""
    log.info("agent.chat.request chat_id=%s user_id=%s history=%s prompt_chars=%s", chat_id, user_id, len(history), len(prompt or ""))

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
        _locked_stream_chat(chat_id, model, prompt, extra_system, provider, user_id=user_id, turn_id=turn_id),
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
    """Stop the agent's current turn via the OpenHands conversation stop API.

    Resolves chatId -> conversation_id server-side via get_mapping(), never
    trusts a client-supplied id as the OpenHands cid.  Checks the response
    status code before reporting success.
    """
    data = await request.json()
    chat_id = data.get("chatId") or data.get("chat_id")
    if not chat_id:
        return {"ok": False, "error": "no chatId"}
    m = get_mapping(chat_id)
    if not m:
        # No mapping exists — either the run already finished or was reset.
        # Not an error per se, but nothing to stop.
        set_run_status(chat_id, "stopped")
        return {"ok": True, "chatId": chat_id, "conversationId": None, "stopped": False, "reason": "no_active_conversation"}
    cid = m["conversation_id"]
    # Bug 4.2: don't POST /stop for a turn that already finished. If the run is
    # in a terminal state (done/stopped/timeout/error) the agent isn't running,
    # so a stop is a no-op that only races the next turn / wastes a round-trip.
    _run = get_run(chat_id)
    if _run and (_run.get("status") or "").lower() in ("done", "stopped", "timeout", "error"):
        return {"ok": True, "chatId": chat_id, "conversationId": cid, "stopped": False, "reason": "already_finished"}
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(
                f"{OPENHANDS_SERVER}/api/conversations/{cid}/stop",
                json={}, timeout=10.0,
            )
            if r.status_code >= 400:
                log.warning("stop_chat: OpenHands returned %s for cid=%s", r.status_code, cid)
                return {"ok": False, "error": f"OpenHands returned {r.status_code}", "conversationId": cid}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    set_run_status(chat_id, "stopped")
    return {"ok": True, "chatId": chat_id, "conversationId": cid, "stopped": True}


# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — interactive agent flow: questions, answers, runs/control-plane,
# history, recipes, self-test, workflows. Backed by core.agent_state (SQLite).
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/agent/questions")
async def agent_questions(request: Request, chatId: Optional[str] = None):
    user = current_user(request)
    items = list_questions(chat_id=chatId, user_id=(user["id"] if user and not chatId else None))
    return {"ok": True, "items": items}


def _format_answer_text(answer: Any, options: List[Dict[str, Any]]) -> str:
    """Turn the UI's answer payload into readable text for the agent (Bug 3.2).

    The frontend sends ``{"selected": [optionId, ...], "custom": "free text"}``
    (see AgentAskUser.jsx). We map selected ids to their labels and append any
    custom text. Falls back gracefully for older/alternate shapes.
    """
    label_by_id = {}
    for opt in options or []:
        if isinstance(opt, dict) and opt.get("id") is not None:
            label_by_id[str(opt["id"])] = opt.get("label") or str(opt["id"])

    parts: List[str] = []
    if isinstance(answer, dict):
        for sid in answer.get("selected") or []:
            parts.append(label_by_id.get(str(sid), str(sid)))
        custom = (answer.get("custom") or "").strip()
        if custom:
            parts.append(custom)
        # legacy/alternate fields, just in case
        if not parts:
            for k in ("customResponse", "answer", "selectedOptionId"):
                v = answer.get(k)
                if v:
                    parts.append(str(v))
                    break
    elif isinstance(answer, str) and answer.strip():
        parts.append(answer.strip())

    return ", ".join(p for p in parts if p) or "ok"


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
    # Bug 3.3: idempotency guard. An already-answered (or cancelled) question
    # must NOT be relayed again — a double-submit (mobile retry, double-tap)
    # would otherwise post a second user message into the conversation and
    # race the turn that the first answer already started. Return the saved
    # state without touching OpenHands.
    if (q.get("status") or "pending") != "pending":
        log.info("agent_answer: question %s already %s — skipping relay", qid, q.get("status"))
        return {"ok": True, "question": q, "alreadyAnswered": True}
    answer = {
        "answer": body.get("answer"),
        "selectedOptionId": body.get("selectedOptionId"),
        "customResponse": body.get("customResponse"),
        "answeredBy": user["id"] if user else None,
    }
    saved = answer_question(qid, answer)
    # Bug 3.2: build the relayed text from the ACTUAL payload the UI sends,
    # which is `answer: { selected: [ids...], custom: "..." }`. The previous
    # code only looked at customResponse/answer/selectedOptionId (none of which
    # the frontend sends), so the relay collapsed to a useless "ok" and the
    # agent never learned what the user picked. Map selected option ids back to
    # their human labels so the agent gets readable text.
    text = _format_answer_text(body.get("answer"), q.get("options") or [])
    cid = q.get("conversation_id")
    chat_id = q.get("chat_id")
    if cid:
        # Sonnet #2: serialize the answer relay through the SAME per-chat lock
        # that _locked_stream_chat uses. Previously this POSTed to the OpenHands
        # conversation with no lock, so an answer could interleave with a
        # concurrent turn for the same chat_id (two unsynchronized user messages
        # into one conversation). Bounded acquire so we never hang the request.
        lock = _stream_lock_for(chat_id) if chat_id else None
        acquired = False
        if lock is not None:
            try:
                await asyncio.wait_for(lock.acquire(), timeout=5.0)
                acquired = True
            except asyncio.TimeoutError:
                log.warning("agent_answer: lock busy for chat_id=%s; relaying without lock", chat_id)
        try:
            async with httpx.AsyncClient() as client:
                try:
                    await client.post(
                        f"{OPENHANDS_SERVER}/api/conversations/{cid}/message",
                        json={"message": f"User answered question '{q.get('question')}': {text}"},
                        timeout=15.0,
                    )
                    # Bug #3: the agent has resumed working on this conversation,
                    # so mark the run "running" again. It was "awaiting_input"
                    # while the question paused the turn; without this the Stop
                    # button would stay a no-op (already_finished) while the agent
                    # is actively running post-answer.
                    if chat_id:
                        try:
                            set_run_status(chat_id, "running")
                        except Exception:
                            pass
                except Exception as e:
                    log.warning("agent answer relay failed: %s", e)
        finally:
            if acquired and lock is not None:
                lock.release()
    return {"ok": True, "question": saved, "resumed": bool(cid)}


@app.post("/api/agent/runs/{chat_id}/stop")
async def agent_run_stop(chat_id: str):
    """Stop the agent's current turn WITHOUT destroying the conversation.

    Sends POST /conversations/{cid}/stop to OpenHands, which aborts the
    in-progress action but keeps the conversation alive so the next user
    message continues in the same context.  Contrast with /reset which
    DELETEs the conversation entirely.

    Resolves chatId -> conversation_id server-side via get_mapping().
    Checks the OpenHands response status before reporting success.
    """
    m = get_mapping(chat_id)
    cid = m["conversation_id"] if m else None
    if not cid:
        set_run_status(chat_id, "stopped")
        return {"ok": True, "chatId": chat_id, "conversationId": None, "stopped": False, "reason": "no_active_conversation"}
    # Bug 4.2: skip the OpenHands /stop round-trip if the run already finished.
    _run = get_run(chat_id)
    if _run and (_run.get("status") or "").lower() in ("done", "stopped", "timeout", "error"):
        return {"ok": True, "chatId": chat_id, "conversationId": cid, "stopped": False, "reason": "already_finished"}
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(
                f"{OPENHANDS_SERVER}/api/conversations/{cid}/stop",
                json={}, timeout=10.0,
            )
            if r.status_code >= 400:
                log.warning("agent_run_stop: OpenHands returned %s for cid=%s", r.status_code, cid)
                return {"ok": False, "error": f"OpenHands returned {r.status_code}", "chatId": chat_id, "conversationId": cid}
        except Exception as e:
            log.warning("agent_run_stop: failed to stop cid=%s: %s", cid, e)
            return {"ok": False, "error": str(e), "chatId": chat_id, "conversationId": cid}
    set_run_status(chat_id, "stopped")
    return {"ok": True, "chatId": chat_id, "conversationId": cid, "stopped": True}


@app.post("/api/agent/runs/{chat_id}/reset")
async def agent_run_reset(chat_id: str):
    """Destroy the OpenHands conversation and drop the mapping.

    WARNING: this deletes the entire conversation, losing all agent context.
    The next message in this chat will create a brand-new conversation with
    no memory of prior work.  This should only be called from an explicit
    "Discard session" UI action, NOT from the Stop button.
    """
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
# Workspace — BrowserAI UI contract backed by the OpenHands shared sandbox
# ─────────────────────────────────────────────────────────────────────────────

# BrowserAI UI has a rich workspace contract (tree, read/save, upload, search,
# diff, download) while OpenHands exposes only a smaller runtime file API
# (list/select/upload/zip/git-diff). In this deployment both containers and the
# OpenHands runtime mount the same host directory as /workspace, so the most
# reliable "full merge" is:
#   * agent chat / events are proxied through OpenHands conversation APIs;
#   * workspace UI reads/writes the same mounted /workspace directly;
#   * when a chatId already has an OpenHands conversation we also expose the
#     conversationId in metadata, but file operations do not require a running
#     conversation.

_WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT") or "/workspace").resolve()
_TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".json", ".js", ".jsx", ".ts", ".tsx",
    ".css", ".scss", ".html", ".htm", ".xml", ".yml", ".yaml", ".csv",
    ".py", ".java", ".c", ".cpp", ".h", ".go", ".rs", ".rb", ".php",
    ".sh", ".sql", ".env", ".ini", ".toml", ".log", ".vue", ".svelte",
}
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
_MAX_PREVIEW_BYTES = int(os.environ.get("BROWSERAI_WORKSPACE_PREVIEW_BYTES", "524288"))
_MAX_TREE_ITEMS = int(os.environ.get("BROWSERAI_WORKSPACE_MAX_TREE_ITEMS", "5000"))


def _bind_chat_to_oh(chat_id: Optional[str]) -> Optional[str]:
    """Return the OpenHands conversation_id mapped to chat_id, or None."""
    if not chat_id:
        return None
    m = get_mapping(chat_id)
    return m["conversation_id"] if m else None


def _request_chat_id(request: Optional[Request] = None, chat_id: Optional[str] = None) -> Optional[str]:
    if chat_id:
        return chat_id
    if request:
        return (
            request.query_params.get("chatId")
            or request.headers.get("X-BrowserAI-Chat-Id")
            or request.headers.get("X-Chat-Id")
        )
    return None


def _safe_rel(raw: Optional[str], allow_empty: bool = True) -> str:
    value = str(raw or "").replace("\\", "/")
    if value.startswith("/workspace/"):
        value = value[len("/workspace/"):]
    elif value == "/workspace":
        value = ""
    value = value.lstrip("/")
    norm = os.path.normpath(value) if value else ""
    if norm in (".", ""):
        if allow_empty:
            return ""
        raise HTTPException(status_code=400, detail="path_required")
    if norm.startswith("../") or norm == ".." or "\x00" in norm:
        raise HTTPException(status_code=400, detail="invalid_path")
    return norm.replace("\\", "/")


def _safe_abs(raw: Optional[str], allow_empty: bool = True, base: Optional[Path] = None) -> Path:
    """Resolve a workspace-relative path safely.
    Phase 1 hardening: reject symlinks that escape the workspace root."""
    rel = _safe_rel(raw, allow_empty=allow_empty)
    root = (base or _WORKSPACE_ROOT).resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="invalid_path")
    # Phase 1: reject symlinks pointing outside workspace
    if target.is_symlink():
        real = target.resolve()
        if real != root and root not in real.parents:
            raise HTTPException(status_code=400, detail="invalid_path")
    return target


def _workspace_base_for_chat(chat_id: Optional[str], create: bool = True) -> Path:
    if chat_id:
        p = _chat_workspace_abs(chat_id)
        if create:
            p.mkdir(parents=True, exist_ok=True)
        return p
    _WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    return _WORKSPACE_ROOT


def _node_for_path(path: Path, rel: str, show_hidden: bool, counter: Dict[str, int]) -> Optional[Dict[str, Any]]:
    name = path.name if rel else "workspace"
    if not show_hidden and name.startswith(".") and rel:
        return None
    if counter["n"] > _MAX_TREE_ITEMS:
        return None
    counter["n"] += 1
    try:
        st = path.stat()
    except OSError:
        return None
    item: Dict[str, Any] = {
        "name": name,
        "path": rel,
        "type": "dir" if path.is_dir() else "file",
        "size": 0 if path.is_dir() else int(st.st_size),
        "mtime": int(st.st_mtime * 1000),
    }
    if path.is_dir():
        children: List[Dict[str, Any]] = []
        try:
            entries = sorted(path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        except OSError:
            entries = []
        for child in entries:
            child_rel = f"{rel}/{child.name}" if rel else child.name
            node = _node_for_path(child, child_rel, show_hidden, counter)
            if node:
                children.append(node)
        item["children"] = children
        item["size"] = sum(int(c.get("size") or 0) for c in children)
    return item


def _read_file_payload(path: Path, rel: str) -> Dict[str, Any]:
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="file_not_found")
    size = path.stat().st_size
    name = path.name
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    ext = path.suffix.lower()
    base = {"path": rel, "name": name, "size": size, "mime": mime, "type": mime}
    raw = path.read_bytes()[:_MAX_PREVIEW_BYTES + 1]
    truncated = len(raw) > _MAX_PREVIEW_BYTES
    raw = raw[:_MAX_PREVIEW_BYTES]
    if ext in _TEXT_EXTS or mime.startswith("text/") or mime in ("application/json", "application/xml"):
        text = raw.decode("utf-8", errors="replace")
        return {**base, "kind": "text", "text": text, "content": text, "truncated": truncated}
    if ext in _IMAGE_EXTS or mime.startswith("image/"):
        data_url = f"{mime};base64,{base64.b64encode(raw).decode('ascii')}"
        return {**base, "kind": "image", "dataUrl": f"data:{data_url}", "truncated": truncated}
    if mime == "application/pdf" or ext == ".pdf":
        data_url = f"{mime};base64,{base64.b64encode(raw).decode('ascii')}"
        return {**base, "kind": "pdf", "dataUrl": f"data:{data_url}", "truncated": truncated}
    return {**base, "kind": "binary", "text": None, "content": "", "truncated": truncated}


def _write_bytes(rel: str, data: bytes, base: Optional[Path] = None) -> Dict[str, Any]:
    path = _safe_abs(rel, allow_empty=False, base=base)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"ok": True, "path": _safe_rel(rel, allow_empty=False), "size": len(data)}


def _decode_upload_content(content: Any) -> bytes:
    if content is None:
        return b""
    if isinstance(content, str):
        # UI sends base64; for convenience accept data URLs and plain text too.
        val = content.split(",", 1)[1] if content.startswith("data:") and "," in content else content
        try:
            return base64.b64decode(val, validate=True)
        except Exception:
            return content.encode("utf-8")
    if isinstance(content, bytes):
        return content
    return json.dumps(content, ensure_ascii=False).encode("utf-8")


def _copy_tree_contents(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(item, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


def _is_private_url(hostname: str) -> bool:
    """Block requests to private/loopback/link-local IPs and cloud metadata."""
    import socket, ipaddress
    try:
        results = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for _fam, _type, _proto, _canonname, sockaddr in results:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return True
            # Cloud metadata endpoints
            if str(ip) in ("169.254.169.254", "fd00:ec2::254"):
                return True
    except socket.gaierror:
        pass
    blocked_hosts = {
        "metadata.google.internal",
        "169.254.169.254",
        "metadata.aws.internal",
        "169.254.169.253",  # GCP
    }
    return hostname.lower() in blocked_hosts


def _assert_url_safe(url: str) -> str:
    """Validate a URL for outbound fetches. Raises HTTPException on SSRF risk."""
    if not url:
        raise HTTPException(status_code=400, detail="url_required")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="unsupported_url")
    host = parsed.hostname or ""
    if not host:
        raise HTTPException(status_code=400, detail="invalid_url")
    if _is_private_url(host):
        raise HTTPException(status_code=400, detail="internal_url_blocked")
    return url


async def _download_url_into(parent: Path, url: str, branch: str = "", strip_top_level: bool = False) -> Dict[str, Any]:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="unsupported_url")
    if _is_private_url(parsed.hostname or ""):
        raise HTTPException(status_code=400, detail="internal_url_blocked")
    parent.mkdir(parents=True, exist_ok=True)

    # GitHub repository URL: clone it. This is the path used by the UI's
    # "Import GitHub" button.
    host = parsed.netloc.lower()
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    is_github_repo = host.endswith("github.com") and len(parts) >= 2 and (len(parts) == 2 or parts[2] in ("tree", "blob"))
    if is_github_repo and (len(parts) == 2 or parts[2] == "tree"):
        repo = f"https://github.com/{parts[0]}/{parts[1].removesuffix('.git')}.git"
        ref = branch or (parts[3] if len(parts) >= 4 and parts[2] == "tree" else "")
        if ref and not re.match(r'^[a-zA-Z0-9._/-]{1,256}$', ref):
            raise HTTPException(status_code=400, detail="invalid_branch_name")
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "repo"
            cmd = ["git", "clone", "--depth", "1"]
            if ref:
                cmd += ["--branch", ref]
            cmd += [repo, str(tmp)]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            if proc.returncode != 0:
                raise HTTPException(status_code=502, detail=(proc.stderr or proc.stdout)[-800:])
            shutil.rmtree(tmp / ".git", ignore_errors=True)
            if strip_top_level:
                _copy_tree_contents(tmp, parent)
                dest = parent
            else:
                dest = parent / parts[1].removesuffix(".git")
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(tmp, dest)
        return {"ok": True, "kind": "git", "path": str(dest.relative_to(parent)).replace("\\", "/") if dest != parent else ""}

    # GitHub blob URL: rewrite to raw URL.
    if host.endswith("github.com") and len(parts) >= 5 and parts[2] == "blob":
        raw_path = "/".join(parts[4:])
        url = f"https://raw.githubusercontent.com/{parts[0]}/{parts[1]}/{parts[3]}/{raw_path}"
        filename = parts[-1]
    else:
        filename = Path(parsed.path).name or "download"

    async with httpx.AsyncClient(follow_redirects=True, timeout=120.0) as client:
        r = await client.get(url)
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"download_failed: HTTP {r.status_code}")
        data = r.content
    dest = parent / filename
    dest.write_bytes(data)

    # Auto-extract common archives into parent/archive-name.
    lower = filename.lower()
    if lower.endswith(".zip"):
        out = parent / Path(filename).stem
        out.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dest) as z:
            for member in z.infolist():
                member_path = (out / member.filename).resolve()
                if not str(member_path).startswith(str(out.resolve())):
                    raise HTTPException(status_code=400, detail="archive_contains_path_traversal")
                z.extract(member, out)
        return {"ok": True, "kind": "zip", "path": str(out.relative_to(parent)).replace("\\", "/")}
    if lower.endswith((".tar", ".tar.gz", ".tgz")):
        out = parent / Path(filename).name.split(".tar")[0]
        out.mkdir(parents=True, exist_ok=True)
        with tarfile.open(dest) as t:
            for member in t.getmembers():
                member_path = (out / member.name).resolve()
                if not str(member_path).startswith(str(out.resolve())):
                    raise HTTPException(status_code=400, detail="archive_contains_path_traversal")
                t.extract(member, out)
        return {"ok": True, "kind": "tar", "path": str(out.relative_to(parent)).replace("\\", "/")}
    return {"ok": True, "kind": "file", "path": str(dest.relative_to(parent)).replace("\\", "/"), "size": len(data)}


@app.post("/api/workspace/chat/init")
async def workspace_chat_init(request: Request):
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    root_label = f"/workspace/{_chat_workspace_rel(chat_id)}" if chat_id else "/workspace"

    cid = _bind_chat_to_oh(chat_id)
    if not cid and chat_id:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await client.post(
                    f"{OPENHANDS_SERVER}/api/conversations",
                    json={},
                    timeout=30.0,
                )
                r.raise_for_status()
                oh_body = r.json()
                cid = oh_body.get("conversation_id") or oh_body.get("id")
                if cid:
                    upsert_mapping(chat_id, cid, None)
                    async def _bg_start():
                        async with httpx.AsyncClient(timeout=30.0) as bg_client:
                            try:
                                await bg_client.post(
                                    f"{OPENHANDS_SERVER}/api/conversations/{cid}/start",
                                    json={}, timeout=600.0,
                                )
                            except Exception as e:
                                log.debug("workspace_chat_init: background start skipped: %s", e)
                    asyncio.create_task(_bg_start())
        except Exception as e:
            log.warning("workspace_chat_init: failed to create OH conversation for chat_id=%s: %s", chat_id, e)

    return {"ok": True, "chatId": chat_id, "conversationId": cid, "root": root_label, "hostPath": str(base)}


@app.delete("/api/workspace/chat")
async def workspace_chat_delete(request: Request):
    # BrowserAI chat deletion must be mirrored to OpenHands; otherwise the next
    # /api/cloud merge imports the same OpenHands conversation again and the
    # user sees a "deleted" chat resurrected. We still do NOT delete the shared
    # /workspace files here, only the OH conversation/mapping.
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    chat_id = _request_chat_id(request, body.get("chatId"))
    cid = _bind_chat_to_oh(chat_id)
    deleted_oh = False
    if cid:
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                r = await client.delete(f"{OPENHANDS_SERVER}/api/conversations/{cid}")
                deleted_oh = r.status_code < 400
            except Exception as e:
                log.warning("workspace chat delete: OpenHands delete failed cid=%s: %s", cid, e)
        try:
            drop_mapping(chat_id)
        except Exception:
            pass
    return {"ok": True, "chatId": chat_id, "conversationId": cid, "deletedOpenHands": deleted_oh, "workspacePreserved": True}


@app.post("/api/workspace/cleanup")
async def workspace_cleanup(request: Request):
    """Remove orphan workspace directories that have no DB mapping.
    Only deletes dirs under /workspace/chats/ with no corresponding chat_conversations row.
    """
    import shutil as _shutil
    chats_root = _WORKSPACE_ROOT / "chats"
    if not chats_root.exists():
        return {"ok": True, "removed": [], "kept": []}
    # Get all mapped chat_ids from DB
    conn = get_conn()
    try:
        rows = conn.execute("SELECT chat_id FROM chat_conversations").fetchall()
        mapped = {r[0] for r in rows}
    finally:
        conn.close()
    removed = []
    kept = []
    for d in sorted(chats_root.iterdir()):
        if not d.is_dir():
            continue
        name = d.name
        # Keep dirs that are mapped in DB or are the _sandbox
        if name in mapped or name == "_sandbox":
            kept.append(name)
            continue
        try:
            _shutil.rmtree(d)
            removed.append(name)
            log.info("workspace cleanup: removed orphan dir %s", name)
        except Exception as e:
            log.warning("workspace cleanup: failed to remove %s: %s", name, e)
            kept.append(name)
    return {"ok": True, "removed": removed, "removedCount": len(removed), "keptCount": len(kept)}


def _workspace_snapshot(root: Path) -> Tuple[str, Dict[str, str]]:
    """Return (tree revision, per-file revisions) for workspace sync.

    File revisions are path-local tokens (`size:mtime_ns`). The tree revision is
    a cheap aggregate that changes when any file changes, appears or disappears.
    """
    count = 0
    total = 0
    newest = 0
    files: Dict[str, str] = {}
    try:
        base = root.resolve()
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules", "__pycache__"}]
            for name in filenames:
                count += 1
                if count > _MAX_TREE_ITEMS:
                    return f"{count}:{total}:{newest}:truncated", files
                p = Path(dirpath) / name
                try:
                    st = p.stat()
                    size = int(st.st_size)
                    mtime_ns = int(st.st_mtime_ns)
                    total += size
                    newest = max(newest, mtime_ns)
                    rel = str(p.relative_to(base)).replace("\\", "/")
                    files[rel] = f"{size}:{mtime_ns}"
                except OSError:
                    continue
    except Exception:
        return "0:0:0:error", files
    return f"{count}:{total}:{newest}", files


def _workspace_revision(root: Path) -> str:
    return _workspace_snapshot(root)[0]


@app.get("/api/workspace")
@app.get("/api/workspace/tree")
async def workspace_tree(request: Request, chatId: Optional[str] = None, path: Optional[str] = None, hidden: Optional[str] = None, ifRevision: Optional[str] = None):
    chat_id = _request_chat_id(request, chatId)
    base = _workspace_base_for_chat(chat_id, create=True)
    show_hidden = str(hidden or request.query_params.get("hidden") or "0").lower() in ("1", "true", "yes")
    root_path = _safe_abs(path or "", allow_empty=True, base=base)
    if not root_path.exists():
        root_path.mkdir(parents=True, exist_ok=True)
    revision, file_revisions = _workspace_snapshot(root_path)
    requested_revision = ifRevision or request.query_params.get("ifRevision") or request.headers.get("X-Workspace-Revision")
    root_label = f"/workspace/{_chat_workspace_rel(chat_id)}" if chat_id else "/workspace"
    if requested_revision and requested_revision == revision:
        return {"ok": True, "unchanged": True, "revision": revision, "fileRevisions": file_revisions, "chatId": chat_id, "path": path or "", "root": root_label}
    counter = {"n": 0}
    tree = _node_for_path(root_path, _safe_rel(path or "", allow_empty=True), show_hidden, counter) or {
        "name": "workspace", "path": "", "type": "dir", "children": []
    }
    # BrowserAI's current Workspace.jsx expects {tree}; older adapters used {items}.
    return {"ok": True, "tree": tree, "items": tree.get("children", []), "chatId": chat_id, "path": path or "", "root": root_label, "revision": revision, "fileRevisions": file_revisions}


@app.get("/api/workspace/metadata")
async def workspace_meta(request: Request, chatId: Optional[str] = None):
    chat_id = _request_chat_id(request, chatId)
    cid = _bind_chat_to_oh(chat_id)
    root_label = f"/workspace/{_chat_workspace_rel(chat_id)}" if chat_id else "/workspace"
    return {"chatId": chat_id, "conversationId": cid, "ready": bool(cid), "root": root_label}


@app.get("/api/workspace/file")
async def workspace_file(request: Request, path: str, chatId: Optional[str] = None):
    chat_id = _request_chat_id(request, chatId)
    base = _workspace_base_for_chat(chat_id, create=True)
    rel = _safe_rel(path, allow_empty=False)
    return _read_file_payload(_safe_abs(rel, allow_empty=False, base=base), rel)


@app.post("/api/workspace/file")
async def workspace_create_file(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    parent = _safe_rel(body.get("parentPath") or "", allow_empty=True)
    name = _safe_rel(body.get("name") or body.get("path"), allow_empty=False)
    # If name already contains a directory, honour it. Otherwise place under parent.
    rel = name if "/" in name or not parent else f"{parent}/{name}"
    return _write_bytes(rel, str(body.get("content") or "").encode("utf-8"), base=base)


@app.put("/api/workspace/file")
async def workspace_save_file(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    rel = _safe_rel(body.get("path"), allow_empty=False)
    return _write_bytes(rel, str(body.get("content") or "").encode("utf-8"), base=base)


@app.post("/api/workspace/folder")
async def workspace_create_folder(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    parent = _safe_rel(body.get("parentPath") or "", allow_empty=True)
    name = _safe_rel(body.get("name") or body.get("path"), allow_empty=False)
    rel = name if "/" in name or not parent else f"{parent}/{name}"
    _safe_abs(rel, allow_empty=False, base=base).mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": rel}


@app.post("/api/workspace/upload")
async def workspace_upload(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    parent = _safe_rel(body.get("parentPath") or "", allow_empty=True)
    files = body.get("files") or []
    saved = []
    for f in files:
        if not isinstance(f, dict):
            continue
        raw_path = f.get("path") or f.get("name") or "upload.bin"
        rel_name = _safe_rel(raw_path, allow_empty=False)
        rel = rel_name if not parent else f"{parent}/{rel_name}"
        data = _decode_upload_content(f.get("content"))
        saved.append(_write_bytes(rel, data, base=base))
    return {"ok": True, "saved": saved, "count": len(saved)}


@app.post("/api/workspace/upload-url")
async def workspace_upload_url(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    parent = _safe_abs(body.get("parentPath") or "", allow_empty=True, base=base)
    result = await _download_url_into(
        parent,
        str(body.get("url") or ""),
        branch=str(body.get("branch") or ""),
        strip_top_level=bool(body.get("stripTopLevel")),
    )
    return result


@app.post("/api/workspace/rename")
async def workspace_rename(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    src = _safe_abs(body.get("path"), allow_empty=False, base=base)
    new_name = _safe_rel(body.get("newName"), allow_empty=False)
    if "/" in new_name:
        raise HTTPException(status_code=400, detail="newName_must_be_name_only")
    dst = src.with_name(new_name)
    src.rename(dst)
    return {"ok": True, "path": str(dst.relative_to(base)).replace("\\", "/")}


@app.post("/api/workspace/move")
async def workspace_move(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    src = _safe_abs(body.get("sourcePath"), allow_empty=False, base=base)
    target_dir = _safe_abs(body.get("targetDirPath") or "", allow_empty=True, base=base)
    target_dir.mkdir(parents=True, exist_ok=True)
    dst = target_dir / src.name
    shutil.move(str(src), str(dst))
    return {"ok": True, "path": str(dst.relative_to(base)).replace("\\", "/")}


@app.delete("/api/workspace/item")
async def workspace_delete_item(request: Request):
    body = await request.json()
    chat_id = _request_chat_id(request, body.get("chatId"))
    base = _workspace_base_for_chat(chat_id, create=True)
    target = _safe_abs(body.get("path"), allow_empty=False, base=base)
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    return {"ok": True}


@app.get("/api/workspace/search")
async def workspace_search(request: Request, q: str = "", hidden: Optional[str] = None):
    chat_id = _request_chat_id(request)
    base = _workspace_base_for_chat(chat_id, create=True)
    query = str(q or "").lower()
    show_hidden = str(hidden or "0").lower() in ("1", "true", "yes")
    results: List[Dict[str, Any]] = []
    if not query:
        return {"ok": True, "results": []}
    for path in base.rglob("*"):
        if len(results) >= 200:
            break
        rel = str(path.relative_to(base)).replace("\\", "/")
        if not show_hidden and any(part.startswith(".") for part in rel.split("/")):
            continue
        if path.is_file() and (path.suffix.lower() in _TEXT_EXTS or query in path.name.lower()):
            try:
                text = path.read_text(errors="replace")[:200_000]
            except Exception:
                text = ""
            idx = text.lower().find(query)
            if query in path.name.lower() or idx >= 0:
                snippet = text[max(0, idx - 80): idx + 180] if idx >= 0 else ""
                results.append({"path": rel, "name": path.name, "snippet": snippet, "size": path.stat().st_size})
    return {"ok": True, "results": results}


@app.get("/api/workspace/history")
async def workspace_history(path: str):
    # Local history is not maintained in the OpenHands-backed workspace yet.
    return {"ok": True, "path": path, "items": []}


@app.post("/api/workspace/history/restore")
async def workspace_history_restore():
    raise HTTPException(status_code=501, detail="workspace_history_not_configured")


@app.get("/api/workspace/events")
async def workspace_events(limit: int = 200, runId: Optional[str] = None, path: Optional[str] = None):
    return {"ok": True, "events": [], "items": []}


@app.get("/api/workspace/diff")
async def workspace_diff(request: Request, path: str = "", limit: int = 500, runId: Optional[str] = None, chatId: Optional[str] = None):
    chat_id = _request_chat_id(request, chatId)
    base = _workspace_base_for_chat(chat_id, create=True)
    # If the chat workspace is a git repo, return a lightweight diff list;
    # otherwise an empty list keeps the BrowserAI diff modal usable.
    try:
        proc = subprocess.run(
            ["git", "-C", str(base), "diff", "--", _safe_rel(path, allow_empty=True)],
            capture_output=True,
            text=True,
            timeout=20,
        )
        text = proc.stdout if proc.returncode == 0 else ""
    except Exception:
        text = ""
    return {"ok": True, "diffs": [{"path": path or ".", "diff": text[:200_000]}] if text else []}


@app.get("/api/workspace/download")
async def workspace_download(chatId: Optional[str] = None, path: Optional[str] = None, inline: Optional[str] = None):
    base = _workspace_base_for_chat(chatId, create=True)
    target = _safe_abs(path or "", allow_empty=True, base=base)
    if not target.exists():
        raise HTTPException(status_code=404, detail="not_found")
    if target.is_file():
        media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        disposition = "inline" if str(inline or "").lower() in ("1", "true", "yes") else "attachment"
        return Response(
            content=target.read_bytes(),
            media_type=media,
            headers={"Content-Disposition": f'{disposition}; filename="{target.name}"'},
        )
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as z:
            for item in target.rglob("*"):
                if item.is_file():
                    z.write(item, item.relative_to(target))
        content = tmp_path.read_bytes()
    finally:
        try:
            tmp_path.unlink()
        except Exception:
            pass
    name = target.name or "workspace"
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.zip"'},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Step 8/9/10 finishing pass — real diagnostic/settings handlers for formerly
# stubbed UI endpoints. These are intentionally conservative: when an external
# integration is not configured, they return configured:false / unsupported
# instead of pretending success with {stub:true}.
# ─────────────────────────────────────────────────────────────────────────────

_DATA_DIR = os.environ.get("BROWSERAI_DATA_DIR", "/data")
_MCP_CONFIG_PATH = os.environ.get("BROWSERAI_MCP_CONFIG", os.path.join(_DATA_DIR, "mcp_config.json"))

def _init_ops_schema() -> None:
    conn = get_conn()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_kv (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS push_subscriptions (
              endpoint TEXT PRIMARY KEY,
              user_id TEXT,
              data_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS checkpoints (
              id TEXT PRIMARY KEY,
              chat_id TEXT NOT NULL,
              step INTEGER NOT NULL,
              label TEXT NOT NULL,
              files_json TEXT NOT NULL DEFAULT '[]',
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_tool_ledger (
              id TEXT PRIMARY KEY,
              chat_id TEXT,
              conversation_id TEXT,
              user_id TEXT,
              event TEXT NOT NULL,
              tool_name TEXT,
              step INTEGER,
              data_json TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def _kv_get(key: str, default: Any = None) -> Any:
    _init_ops_schema()
    conn = get_conn()
    try:
        r = conn.execute("SELECT value_json FROM app_kv WHERE key=?", (key,)).fetchone()
        return json.loads(r["value_json"]) if r else default
    finally:
        conn.close()


def _kv_set(key: str, value: Any) -> Any:
    _init_ops_schema()
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO app_kv (key,value_json,updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (key, json.dumps(value, ensure_ascii=False), int(time.time() * 1000)),
        )
        conn.commit()
        return value
    finally:
        conn.close()


def _ledger_tool_event(chat_id: str, conversation_id: Optional[str], user_id: Optional[str], event: str, data: Dict[str, Any]) -> None:
    """Step 10.6 audit: append tool_start/tool_result to agent_tool_ledger."""
    _init_ops_schema()
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO agent_tool_ledger (id,chat_id,conversation_id,user_id,event,tool_name,step,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                f"tl_{uuid.uuid4().hex[:16]}", chat_id, conversation_id, user_id,
                event, data.get("name") or data.get("tool") or data.get("title"),
                data.get("step"), json.dumps(data, ensure_ascii=False), int(time.time() * 1000),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _mcp_load() -> Dict[str, Any]:
    try:
        if os.path.exists(_MCP_CONFIG_PATH):
            with open(_MCP_CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
                return {"servers": data.get("servers") or {}}
    except Exception as e:
        log.warning("mcp config load failed: %s", e)
    return {"servers": {}}


def _mcp_save(data: Dict[str, Any]) -> Dict[str, Any]:
    os.makedirs(os.path.dirname(_MCP_CONFIG_PATH), exist_ok=True)
    payload = {"servers": data.get("servers") or {}}
    with open(_MCP_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


@app.on_event("startup")
async def _startup_ops_schema() -> None:
    try:
        _init_ops_schema()
    except Exception as e:
        log.warning("ops schema init failed: %s", e)


@app.get("/api/checkpoints/{chat_id}")
async def checkpoints_list(chat_id: str):
    _init_ops_schema()
    conn = get_conn()
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(checkpoints)").fetchall()}
        items = []
        if "files_json" in cols and "created_at" in cols:
            rows = conn.execute(
                "SELECT * FROM checkpoints WHERE chat_id=? ORDER BY step DESC, created_at DESC LIMIT 100",
                (chat_id,),
            ).fetchall()
            for r in rows:
                files = json.loads(r["files_json"] or "[]")
                items.append({
                    "id": r["id"], "chatId": r["chat_id"], "step": r["step"],
                    "label": r["label"], "files": files, "fileCount": len(files),
                    "ts": r["created_at"],
                })
        else:
            # Legacy Node-era schema: one row per file snapshot
            rows = conn.execute(
                "SELECT step, label, ts, file_path FROM checkpoints WHERE chat_id=? ORDER BY step DESC, ts DESC LIMIT 500",
                (chat_id,),
            ).fetchall()
            grouped: Dict[Tuple[int, int, str], List[str]] = {}
            for r in rows:
                key = (int(r["step"]), int(r["ts"]), r["label"] or f"checkpoint #{r['step']}")
                grouped.setdefault(key, []).append(r["file_path"])
            for (step, ts, label), files in grouped.items():
                items.append({"id": f"{chat_id}:{step}:{ts}", "chatId": chat_id, "step": step, "label": label, "files": files, "fileCount": len(files), "ts": ts})
        return {"ok": True, "checkpoints": items}
    finally:
        conn.close()


@app.post("/api/checkpoints")
async def checkpoints_create(request: Request):
    body = await request.json()
    chat_id = body.get("chatId") or body.get("chat_id")
    if not chat_id:
        raise HTTPException(status_code=400, detail="chatId required")
    _init_ops_schema()
    conn = get_conn()
    try:
        last = conn.execute("SELECT max(step) AS s FROM checkpoints WHERE chat_id=?", (chat_id,)).fetchone()
        step = int(body.get("step") or ((last["s"] or 0) + 1))
        files = body.get("files") or []
        label = body.get("label") or f"checkpoint #{step}"
        cid = f"cp_{uuid.uuid4().hex[:12]}"
        now = int(time.time() * 1000)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(checkpoints)").fetchall()}
        if "files_json" in cols and "created_at" in cols:
            conn.execute(
                "INSERT INTO checkpoints (id,chat_id,step,label,files_json,created_at) VALUES (?,?,?,?,?,?)",
                (cid, chat_id, step, label, json.dumps(files, ensure_ascii=False), now),
            )
        else:
            # Legacy schema: one row per file. If no files supplied, store a
            # metadata marker path so the checkpoint still appears in UI.
            for fp in (files or ["(manual checkpoint)"]):
                conn.execute(
                    "INSERT INTO checkpoints (chat_id,step,ts,label,file_path,revision_id) VALUES (?,?,?,?,?,?)",
                    (chat_id, step, now, label, fp, ""),
                )
        conn.commit()
        return {"ok": True, "checkpoint": {"id": cid, "chatId": chat_id, "step": step, "label": label, "files": files, "fileCount": len(files), "ts": now}}
    finally:
        conn.close()


@app.post("/api/checkpoints/{chat_id}/restore")
async def checkpoints_restore(chat_id: str, request: Request):
    body = await request.json()
    step = int(body.get("step") or 0)
    # Real restore requires OpenHands file_history snapshots. The current OH
    # bridge exposes workspace read/write but not per-edit preimages. Return a
    # truthful, non-stub response so the UI can show the limitation cleanly.
    return {"ok": False, "error": "restore_not_available", "chatId": chat_id, "step": step, "restored": [], "failed": [], "message": "Checkpoint metadata is available; file restore needs OpenHands file_history snapshots."}


@app.get("/api/admin/deepseek/status")
async def admin_deepseek_status():
    session_path = os.environ.get("DEEPSEEK_SESSION_PATH", os.path.join(_DATA_DIR, "deepseek_session.json"))
    exists = os.path.exists(session_path)
    return {"ok": True, "configured": exists, "sessionPath": session_path, "managed": exists, "message": "DeepSeek managed session present" if exists else "DeepSeek managed session not configured"}


@app.post("/api/admin/deepseek/refresh")
async def admin_deepseek_refresh():
    st = await admin_deepseek_status()
    return {**st, "refreshed": False, "message": "Interactive DeepSeek refresh is not automated; upload/update session file on server."}


@app.get("/api/admin/deepseek/token")
async def admin_deepseek_token():
    st = await admin_deepseek_status()
    return {"ok": bool(st.get("configured")), "configured": bool(st.get("configured")), "token": None, "message": "Token is never exposed by API; use status for configuration check."}


@app.get("/api/mcp/config")
async def mcp_config_get():
    return _mcp_load()


@app.get("/api/mcp/status")
async def mcp_status_get():
    cfg = _mcp_load().get("servers") or {}
    servers = []
    for name, meta in cfg.items():
        servers.append({"name": name, **(meta or {}), "status": "configured" if (meta or {}).get("enabled", True) else "disabled"})
    return {"ok": True, "servers": servers, "count": len(servers)}


@app.put("/api/mcp/server/{name}")
@app.post("/api/mcp/server/{name}")
async def mcp_server_upsert(name: str, request: Request):
    body = await request.json()
    cfg = _mcp_load()
    servers = cfg.setdefault("servers", {})
    servers[name] = {**(servers.get(name) or {}), **body, "name": name, "updatedAt": int(time.time() * 1000)}
    _mcp_save(cfg)
    return {"ok": True, "server": servers[name], "servers": servers}


@app.patch("/api/mcp/server/{name}")
async def mcp_server_patch(name: str, request: Request):
    return await mcp_server_upsert(name, request)


@app.delete("/api/mcp/server/{name}")
async def mcp_server_delete(name: str):
    cfg = _mcp_load()
    removed = (cfg.get("servers") or {}).pop(name, None)
    _mcp_save(cfg)
    return {"ok": True, "removed": bool(removed), "servers": cfg.get("servers") or {}}


@app.post("/api/mcp/restart")
async def mcp_restart():
    return {"ok": True, "restarted": False, "message": "MCP config saved. OpenHands restart is managed by its container lifecycle."}


@app.get("/api/approval/policy")
async def approval_policy_get():
    default = {"read":"auto", "write":"ask", "net":"ask", "bash":"ask", "git":"ask", "mcp":"ask", "deploy":"ask"}
    return {"ok": True, "policy": _kv_get("approval_policy", default)}


@app.post("/api/approval/policy")
async def approval_policy_set(request: Request):
    body = await request.json()
    return {"ok": True, "policy": _kv_set("approval_policy", body.get("policy") or body)}


@app.get("/api/push/vapid")
async def push_vapid():
    public_key = os.environ.get("VAPID_PUBLIC_KEY", "")
    return {"ok": True, "configured": bool(public_key), "publicKey": public_key}


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    _init_ops_schema()
    user = current_user(request)
    body = await request.json()
    endpoint = body.get("endpoint") or (body.get("subscription") or {}).get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="endpoint required")
    now = int(time.time() * 1000)
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO push_subscriptions (endpoint,user_id,data_json,created_at,updated_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, data_json=excluded.data_json, updated_at=excluded.updated_at",
            (endpoint, (user or {}).get("id"), json.dumps(body, ensure_ascii=False), now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "subscribed": True}


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request):
    body = await request.json()
    endpoint = body.get("endpoint") or (body.get("subscription") or {}).get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="endpoint required")
    conn = get_conn()
    try:
        cur = conn.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
        conn.commit()
        return {"ok": True, "removed": cur.rowcount}
    finally:
        conn.close()


@app.post("/api/push/test")
async def push_test():
    return {"ok": False, "configured": False, "error": "webpush_sender_not_configured", "message": "Subscriptions are stored; VAPID/web-push sender is not configured."}


@app.get("/api/webhooks/github/config")
async def github_webhook_config():
    cfg = _kv_get("github_webhook", {}) or {}
    return {"ok": True, "configured": bool(cfg.get("secret") or os.environ.get("GITHUB_WEBHOOK_SECRET")), "events": cfg.get("events") or ["push", "pull_request"], "hasSecret": bool(cfg.get("secret") or os.environ.get("GITHUB_WEBHOOK_SECRET"))}


@app.post("/api/webhooks/github/config")
async def github_webhook_config_set(request: Request):
    body = await request.json()
    cfg = _kv_get("github_webhook", {}) or {}
    cfg.update({k: v for k, v in body.items() if k != "secret"})
    _kv_set("github_webhook", cfg)
    return await github_webhook_config()


@app.post("/api/webhooks/github/secret")
async def github_webhook_secret_set(request: Request):
    body = await request.json()
    secret = body.get("secret") or ""
    cfg = _kv_get("github_webhook", {}) or {}
    cfg["secret"] = "***" if secret else ""
    cfg["hasSecret"] = bool(secret)
    _kv_set("github_webhook", cfg)
    return {"ok": True, "hasSecret": bool(secret)}


@app.post("/api/webhooks/github")
async def github_webhook_receive(request: Request):
    event = request.headers.get("X-GitHub-Event") or "unknown"
    delivery = request.headers.get("X-GitHub-Delivery") or ""
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    _kv_set("github_webhook_last", {"event": event, "delivery": delivery, "ts": int(time.time() * 1000), "repository": (payload.get("repository") or {}).get("full_name")})
    return {"ok": True, "event": event, "delivery": delivery, "processed": False, "message": "Webhook received and recorded."}


@app.get("/api/ops/services")
async def ops_services():
    return await _gateway_status(OPENHANDS_SERVER)


@app.post("/api/ops/action")
async def ops_action(request: Request):
    body = await request.json()
    action = body.get("action")
    if action in ("health", "status"):
        return await _gateway_status(OPENHANDS_SERVER)
    return {"ok": False, "error": "unsupported_action", "action": action}


@app.get("/api/ops/audit")
async def ops_audit():
    return {"ok": True, "items": [_kv_get("github_webhook_last", {})], "message": "Minimal audit feed; structured logs carry trace_id."}


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
async def memory_semantic_get(request: Request, q: str = "", limit: int = 10, chatId: Optional[str] = None):
    user = _require_user(request)
    return {"ok": True, "items": search_semantic(user["id"], q, limit=max(1, min(limit, 50)), chat_id=chatId)}


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
    "/api/checkpoints", "/api/admin/deepseek/status", "/api/admin/deepseek/refresh",
    "/api/admin/deepseek/token", "/api/mcp/config", "/api/mcp/status", "/api/mcp/restart",
    "/api/ops/services", "/api/ops/action", "/api/ops/audit", "/api/approval/policy",
    "/api/push/vapid", "/api/push/subscribe", "/api/push/unsubscribe", "/api/push/test",
    "/api/webhooks/github", "/api/webhooks/github/config", "/api/webhooks/github/secret",
}

# Compute which paths are still pure stubs (no real handler).
_ACTIVE_STUBS = sorted(p for p in _STUB_ROUTES if p not in _REAL_NOW)

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
# Stub status endpoint — allows the UI to discover which features are backed
# by real logic vs. placeholder stubs, so it can show honest "WIP" badges
# instead of rendering fully-functional-looking panels over empty data.
# ─────────────────────────────────────────────────────────────────────────────

# Some "real" handlers return hardcoded empty data (no DB table, no logic).
# They are technically not stubs but functionally equivalent — the UI
# component has nothing useful to show.  We list them here so the frontend
# can treat them as "semi-stub" (real route, empty behaviour).
_SEMI_STUBS = {
    "/api/agent/workflows": "hardcoded empty items",
    "/api/agent/recipes": "static demo list, not persisted",
    "/api/operator/missions": "empty until manually created",
    "/api/operator/projects": "empty until manually created",
    "/api/operator/status": "minimal status, no real ops data",
    "/api/incidents": "empty until manually created",
}


@app.get("/api/stub-status")
async def stub_status(request: Request):
    """Return the set of stub and semi-stub routes so the UI can show honest
    'in development' indicators instead of silently empty panels."""
    user = current_user(request)
    is_owner = _is_owner(user) if user else False
    return {
        "ok": True,
        "stubs": _ACTIVE_STUBS,
        "semiStubs": list(_SEMI_STUBS.keys()),
        "semiStubReasons": _SEMI_STUBS,
        "realCount": len(_REAL_NOW),
        "stubCount": len(_ACTIVE_STUBS),
        "semiStubCount": len(_SEMI_STUBS),
        "ownerOnly": not is_owner,
    }


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
