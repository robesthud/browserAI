"""
SQLite-backed key store + global params.

Supports the full UI shape:
  id, name, baseUrl, apiKey, model, availableModels[], isActive,
  authType ('bearer'|'cookie'|'custom'), authHeader, responsePath,
  extraHeaders{}, onlyFree, createdAt, updatedAt, hasSecret,
  useStoredSecret, maskedApiKey, encrypted

`maskedApiKey` is what we send to the UI when the secret is encrypted
or the caller did not opt into useStoredSecret.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional

DB_PATH = os.environ.get("BROWSERAI_DB", "/data/browserai.db")


def get_conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # Production-grade pragmas (Hybrid Merge Plan - Phase 1.1)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA cache_size=-32000")  # ~32MB cache
    return conn


# ── Schema ──────────────────────────────────────────────────────────────────


def init_db() -> None:
    conn = get_conn()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS keys (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL DEFAULT '',
                base_url         TEXT NOT NULL DEFAULT '',
                api_key          TEXT NOT NULL DEFAULT '',
                model            TEXT NOT NULL DEFAULT '',
                available_models TEXT NOT NULL DEFAULT '[]',
                is_active        INTEGER NOT NULL DEFAULT 0,
                enc              INTEGER NOT NULL DEFAULT 0,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL,
                auth_type        TEXT NOT NULL DEFAULT 'bearer',
                auth_header      TEXT NOT NULL DEFAULT '',
                response_path    TEXT NOT NULL DEFAULT '',
                extra_headers    TEXT NOT NULL DEFAULT '{}',
                only_free        INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS params (
                id              TEXT PRIMARY KEY DEFAULT 'global',
                system_prompt   TEXT NOT NULL DEFAULT '',
                temperature     REAL NOT NULL DEFAULT 0.7,
                stream          INTEGER NOT NULL DEFAULT 1,
                use_web_ai      INTEGER NOT NULL DEFAULT 0,
                max_steps       INTEGER NOT NULL DEFAULT 50
            );

            CREATE TABLE IF NOT EXISTS vault_state (
                user_id          TEXT PRIMARY KEY,
                enabled          INTEGER NOT NULL DEFAULT 0,
                locked           INTEGER NOT NULL DEFAULT 0,
                kdf_salt         BLOB,
                verifier_hash    BLOB,
                autolock_minutes INTEGER NOT NULL DEFAULT 30,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL
            );
            """
        )

        # Add columns to existing keys table if upgrading from older schema
        existing = {r[1] for r in conn.execute("PRAGMA table_info(keys)").fetchall()}
        for col, ddl in [
            ("auth_type",     "TEXT NOT NULL DEFAULT 'bearer'"),
            ("auth_header",   "TEXT NOT NULL DEFAULT ''"),
            ("response_path", "TEXT NOT NULL DEFAULT ''"),
            ("extra_headers", "TEXT NOT NULL DEFAULT '{}'"),
            ("only_free",     "INTEGER NOT NULL DEFAULT 0"),
        ]:
            if col not in existing:
                try:
                    conn.execute(f"ALTER TABLE keys ADD COLUMN {col} {ddl}")
                except sqlite3.OperationalError:
                    pass
        conn.commit()

        # Seed default keys ONLY if table is empty (first ever boot)
        cnt = conn.execute("SELECT count(*) AS c FROM keys").fetchone()["c"]
        if cnt == 0:
            now = int(time.time() * 1000)
            bigmodel_key = os.environ.get("BIGMODEL_API_KEY", "")
            glm_models = json.dumps([
                "glm-4.5-flash", "glm-4.7-flash", "glm-4-flash",
                "glm-z1-flash", "glm-4v-flash", "glm-4.1v-thinking-flash",
                "glm-4.6", "glm-4.7", "glm-5",
            ])
            conn.execute(
                "INSERT INTO keys (id,name,base_url,api_key,model,available_models,is_active,enc,created_at,updated_at,auth_type,extra_headers) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "glm-default", "Zhipu AI (GLM)",
                    "https://open.bigmodel.cn/api/paas/v4", bigmodel_key,
                    "glm-4.5-flash", glm_models, 1, 0, now, now,
                    "bearer", "{}",
                ),
            )
            conn.commit()

        # Seed global params row if missing
        if not conn.execute("SELECT 1 FROM params WHERE id='global'").fetchone():
            conn.execute(
                "INSERT INTO params (id, system_prompt, temperature, stream, use_web_ai, max_steps) "
                "VALUES ('global', 'Ты — точный и прямой ассистент.', 0.7, 1, 0, 50)"
            )
            conn.commit()
    finally:
        conn.close()


# ── Helpers ─────────────────────────────────────────────────────────────────


def _mask(secret: str) -> str:
    if not secret:
        return ""
    if secret == "__managed__":
        return secret
    if secret.startswith("enc:"):
        # Encrypted blob — never expose any plaintext bytes
        return "🔒 encrypted"
    if len(secret) <= 8:
        return "•" * len(secret)
    return f"{secret[:4]}•••{secret[-3:]}"


def _row_to_key(r: sqlite3.Row, include_secret: bool = False) -> Dict[str, Any]:
    api_key = r["api_key"] or ""
    try:
        extra_headers = json.loads(r["extra_headers"] or "{}")
    except Exception:
        extra_headers = {}
    try:
        available_models = json.loads(r["available_models"] or "[]")
    except Exception:
        available_models = []
    return {
        "id": r["id"],
        "name": r["name"] or "",
        "baseUrl": r["base_url"] or "",
        "apiKey": api_key if include_secret else "",
        "maskedApiKey": _mask(api_key),
        "hasSecret": bool(api_key),
        "useStoredSecret": bool(api_key),
        "model": r["model"] or "",
        "availableModels": available_models,
        "isActive": bool(r["is_active"]),
        "encrypted": bool(r["enc"]),
        "authType": (r["auth_type"] if "auth_type" in r.keys() else None) or "bearer",
        "authHeader": (r["auth_header"] if "auth_header" in r.keys() else None) or "",
        "responsePath": (r["response_path"] if "response_path" in r.keys() else None) or "",
        "extraHeaders": extra_headers,
        "onlyFree": bool(r["only_free"] if "only_free" in r.keys() else False),
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


# ── Public API ──────────────────────────────────────────────────────────────


def list_keys(include_secrets: bool = False) -> List[Dict[str, Any]]:
    init_db()
    conn = get_conn()
    try:
        rows = conn.execute("SELECT * FROM keys ORDER BY created_at").fetchall()
        return [_row_to_key(r, include_secret=include_secrets) for r in rows]
    finally:
        conn.close()


def get_key(key_id: str, include_secret: bool = True) -> Optional[Dict[str, Any]]:
    init_db()
    conn = get_conn()
    try:
        r = conn.execute("SELECT * FROM keys WHERE id = ?", (key_id,)).fetchone()
        return _row_to_key(r, include_secret=include_secret) if r else None
    finally:
        conn.close()


def get_active_key(include_secret: bool = True) -> Optional[Dict[str, Any]]:
    init_db()
    conn = get_conn()
    try:
        r = conn.execute("SELECT * FROM keys WHERE is_active = 1").fetchone()
        if not r:
            r = conn.execute("SELECT * FROM keys LIMIT 1").fetchone()
        return _row_to_key(r, include_secret=include_secret) if r else None
    finally:
        conn.close()


def upsert_key(k: Dict[str, Any]) -> List[Dict[str, Any]]:
    init_db()
    now = int(time.time() * 1000)
    conn = get_conn()
    try:
        k_id = k.get("id")
        # When useStoredSecret=true and apiKey is empty/placeholder/masked,
        # preserve the existing secret on disk.
        incoming_secret = (k.get("apiKey") or "").strip()
        existing_row = conn.execute(
            "SELECT api_key, available_models FROM keys WHERE id = ?", (k_id,)
        ).fetchone()

        if k.get("useStoredSecret") and (
            not incoming_secret
            or incoming_secret.startswith("•")
            or "•" in incoming_secret
            or incoming_secret == "🔒 encrypted"
        ):
            if existing_row:
                incoming_secret = existing_row["api_key"] or ""

        # Don't clobber availableModels with a smaller/empty list. The UI
        # sometimes sends only the currently-selected model after edits or
        # after a 'Validate' button click, which would silently shrink the
        # model dropdown. Merge old + new instead.
        incoming_models = k.get("availableModels") or []
        if existing_row:
            try:
                old_models = json.loads(existing_row["available_models"] or "[]")
            except Exception:
                old_models = []
            if old_models:
                merged = list(incoming_models)
                seen = set(merged)
                for m in old_models:
                    if m not in seen:
                        merged.append(m); seen.add(m)
                # Only replace if new list is strictly bigger or strictly different;
                # never let it shrink below the existing size.
                if len(incoming_models) < len(old_models):
                    incoming_models = merged
                else:
                    incoming_models = merged

        name             = k.get("name", "")
        base_url         = k.get("baseUrl", "")
        model            = k.get("model", "")
        available_models = json.dumps(incoming_models)
        auth_type        = k.get("authType") or "bearer"
        auth_header      = k.get("authHeader") or ""
        response_path    = k.get("responsePath") or ""
        extra_headers    = json.dumps(k.get("extraHeaders") or {})
        only_free        = 1 if k.get("onlyFree") else 0

        conn.execute(
            """
            INSERT INTO keys (id, name, base_url, api_key, model, available_models,
                              is_active, enc, created_at, updated_at,
                              auth_type, auth_header, response_path, extra_headers, only_free)
            VALUES (?,?,?,?,?,?,0,0,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, base_url=excluded.base_url, api_key=excluded.api_key,
                model=excluded.model, available_models=excluded.available_models,
                updated_at=excluded.updated_at,
                auth_type=excluded.auth_type, auth_header=excluded.auth_header,
                response_path=excluded.response_path, extra_headers=excluded.extra_headers,
                only_free=excluded.only_free
            """,
            (k_id, name, base_url, incoming_secret, model, available_models,
             now, now, auth_type, auth_header, response_path, extra_headers, only_free),
        )
        conn.commit()
    finally:
        conn.close()
    return list_keys()


def delete_key(k_id: str) -> List[Dict[str, Any]]:
    init_db()
    conn = get_conn()
    try:
        conn.execute("DELETE FROM keys WHERE id = ?", (k_id,))
        conn.commit()
    finally:
        conn.close()
    return list_keys()


def set_active_key(k_id: str) -> List[Dict[str, Any]]:
    init_db()
    conn = get_conn()
    try:
        conn.execute("UPDATE keys SET is_active = 0")
        conn.execute("UPDATE keys SET is_active = 1 WHERE id = ?", (k_id,))
        conn.commit()
    finally:
        conn.close()
    return list_keys()


def import_keys(keys: List[Dict[str, Any]], active_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Replace all keys with the supplied list (CloudSync import path)."""
    init_db()
    conn = get_conn()
    try:
        conn.execute("DELETE FROM keys")
        conn.commit()
    finally:
        conn.close()
    for k in keys or []:
        upsert_key(k)
    if active_id:
        set_active_key(active_id)
    return list_keys()


# ── Global params ──────────────────────────────────────────────────────────


def get_params() -> Dict[str, Any]:
    init_db()
    conn = get_conn()
    try:
        r = conn.execute("SELECT * FROM params WHERE id='global'").fetchone()
        if not r:
            return {
                "systemPrompt": "Ты — точный и прямой ассистент.",
                "temperature": 0.7,
                "stream": True,
                "useWebAI": False,
                "maxSteps": 50,
            }
        return {
            "systemPrompt": r["system_prompt"] or "",
            "temperature": r["temperature"],
            "stream": bool(r["stream"]),
            "useWebAI": bool(r["use_web_ai"]),
            "maxSteps": r["max_steps"] or 50,
        }
    finally:
        conn.close()


def set_params(p: Dict[str, Any]) -> Dict[str, Any]:
    init_db()
    cur = get_params()
    merged = {**cur, **{k: v for k, v in (p or {}).items() if v is not None}}
    conn = get_conn()
    try:
        conn.execute(
            """
            INSERT INTO params (id, system_prompt, temperature, stream, use_web_ai, max_steps)
            VALUES ('global', ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                system_prompt = excluded.system_prompt,
                temperature   = excluded.temperature,
                stream        = excluded.stream,
                use_web_ai    = excluded.use_web_ai,
                max_steps     = excluded.max_steps
            """,
            (
                merged.get("systemPrompt") or "",
                float(merged.get("temperature") or 0.7),
                1 if merged.get("stream", True) else 0,
                1 if merged.get("useWebAI", False) else 0,
                int(merged.get("maxSteps") or 50),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return get_params()
