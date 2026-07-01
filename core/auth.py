"""
BrowserAI auth — users, sessions, cookies.

Design:
  * Passwords hashed with bcrypt (cost 12). Always stored as bytes-as-text.
  * Session cookie 'browserai_session' = signed token issued by itsdangerous
    URLSafeTimedSerializer. Payload is just the session id; the actual
    session row (user_id, created_at, ip, ua) lives in SQLite. This way we
    can revoke individual sessions on /logout or by admin.
  * Cookies are HttpOnly + SameSite=Lax. Secure flag is set when APP_URL is
    https (or env BROWSERAI_FORCE_SECURE_COOKIE=1).
  * First successful registration becomes the owner. If REGISTRATION_SECRET
    is set in env, subsequent registrations require it as a header
    `X-Registration-Secret`. If unset, anyone can register (single-tenant
    friendly).
  * Session lifetime: 30 days idle. Each /me touch extends it.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import time
from typing import Any, Dict, Optional, Tuple

import bcrypt
from fastapi import HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from core.database import get_conn

SESSION_COOKIE_NAME = "browserai_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days
_SERIALIZER_SALT = "browserai.session.v1"

AUTH_SECRET = os.environ.get("AUTH_SECRET") or os.environ.get("SESSION_SECRET") or ""
REGISTRATION_SECRET = os.environ.get("REGISTRATION_SECRET") or ""
FORCE_SECURE_COOKIE = os.environ.get("BROWSERAI_FORCE_SECURE_COOKIE") == "1"
APP_URL = os.environ.get("APP_URL", "http://localhost")
COOKIE_SECURE = FORCE_SECURE_COOKIE or APP_URL.lower().startswith("https://")


def _serializer() -> URLSafeTimedSerializer:
    if not AUTH_SECRET:
        # Better to crash loudly than silently mint forgeable cookies.
        raise RuntimeError(
            "AUTH_SECRET (or SESSION_SECRET) env var is required for auth to work"
        )
    return URLSafeTimedSerializer(AUTH_SECRET, salt=_SERIALIZER_SALT)


# ─────────────────────────────────────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────────────────────────────────────


def init_auth_schema() -> None:
    conn = get_conn()
    try:
        # ── Migration: an older Node-era `sessions` table used a different
        #    schema (had a `token_hash` column, no `expires_at`). If we detect
        #    it, drop & recreate so deploys onto legacy DBs are idempotent and
        #    don't crash on INSERT with the new columns.
        try:
            cols = {
                r[1] for r in conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            if cols and ("token_hash" in cols or "expires_at" not in cols):
                conn.execute("DROP TABLE IF EXISTS sessions")
                conn.commit()
        except Exception:
            # table doesn't exist yet — nothing to migrate
            pass

        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id              TEXT PRIMARY KEY,
                email           TEXT NOT NULL UNIQUE,
                password_hash   TEXT NOT NULL,
                role            TEXT NOT NULL DEFAULT 'user',
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS users_email ON users(email);

            CREATE TABLE IF NOT EXISTS sessions (
                id              TEXT PRIMARY KEY,
                user_id         TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                last_seen_at    INTEGER NOT NULL,
                expires_at      INTEGER NOT NULL,
                ip              TEXT,
                user_agent      TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

            CREATE TABLE IF NOT EXISTS cloud_state (
                user_id         TEXT PRIMARY KEY,
                settings        TEXT NOT NULL DEFAULT '{}',
                chats           TEXT NOT NULL DEFAULT '[]',
                updated_at      INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )
        # Self-healing migration: add any columns missing from older DBs
        # (users / sessions / cloud_state). See core/migrations.py.
        try:
            from core.migrations import ensure_columns
            ensure_columns(conn, "users")
            ensure_columns(conn, "sessions")
            ensure_columns(conn, "cloud_state")
        except Exception:
            pass
        conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Password helpers
# ─────────────────────────────────────────────────────────────────────────────


def _hash_password(plain: str) -> str:
    if not plain or len(plain) < 6:
        raise HTTPException(status_code=400, detail="Пароль слишком короткий (минимум 6 символов).")
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(12)).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# User CRUD
# ─────────────────────────────────────────────────────────────────────────────


def _norm_email(email: str) -> str:
    return (email or "").strip().lower()


def _user_count() -> int:
    init_auth_schema()
    conn = get_conn()
    try:
        return conn.execute("SELECT count(*) AS c FROM users").fetchone()["c"]
    finally:
        conn.close()


def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    init_auth_schema()
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    init_auth_schema()
    email = _norm_email(email)
    if not email:
        return None
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_user(email: str, password: str, role: str = "user") -> Dict[str, Any]:
    email = _norm_email(email)
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Некорректный email.")
    if get_user_by_email(email):
        raise HTTPException(status_code=409, detail="Пользователь с таким email уже существует.")
    user_id = secrets.token_urlsafe(12)
    now = int(time.time() * 1000)
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (user_id, email, _hash_password(password), role, now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": user_id, "email": email, "role": role}


# ─────────────────────────────────────────────────────────────────────────────
# Sessions
# ─────────────────────────────────────────────────────────────────────────────


def _now() -> int:
    return int(time.time())


def create_session(user_id: str, request: Optional[Request] = None) -> str:
    init_auth_schema()
    sid = secrets.token_urlsafe(24)
    now = _now()
    ip = ""
    ua = ""
    if request is not None:
        ip = (request.client.host if request.client else "") or ""
        ua = request.headers.get("user-agent", "")[:512]
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent) "
            "VALUES (?,?,?,?,?,?,?)",
            (sid, user_id, now, now, now + SESSION_MAX_AGE, ip, ua),
        )
        # GC old sessions cheaply
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.commit()
    finally:
        conn.close()
    return sid


def revoke_session(sid: str) -> None:
    init_auth_schema()
    conn = get_conn()
    try:
        conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        conn.commit()
    finally:
        conn.close()


def touch_session(sid: str) -> Optional[Dict[str, Any]]:
    init_auth_schema()
    now = _now()
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id = ? AND expires_at > ?", (sid, now)
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
            (now, now + SESSION_MAX_AGE, sid),
        )
        conn.commit()
        return dict(row)
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Cookie helpers
# ─────────────────────────────────────────────────────────────────────────────


def _sign(sid: str) -> str:
    return _serializer().dumps({"sid": sid})


def _unsign(token: str) -> Optional[str]:
    try:
        payload = _serializer().loads(token, max_age=SESSION_MAX_AGE)
        return (payload or {}).get("sid")
    except (SignatureExpired, BadSignature, Exception):
        return None


def set_session_cookie(response: Response, sid: str) -> None:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        _sign(sid),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")


def current_user(request: Request) -> Optional[Dict[str, Any]]:
    """Return the user dict bound to the request's session cookie, or None."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    sid = _unsign(token)
    if not sid:
        return None
    sess = touch_session(sid)
    if not sess:
        return None
    user = get_user_by_id(sess["user_id"])
    if user:
        # Attach session id for downstream (e.g. logout)
        user["_session_id"] = sid
    return user


# ─────────────────────────────────────────────────────────────────────────────
# Registration policy
# ─────────────────────────────────────────────────────────────────────────────


def check_registration_allowed(request: Request) -> Tuple[bool, str]:
    """
    Rules:
      * If users table is empty → ALWAYS allow (bootstrap owner).
      * Else if REGISTRATION_SECRET env not set → allow open registration.
      * Else require header X-Registration-Secret to match.
    """
    if _user_count() == 0:
        return True, "owner"
    if not REGISTRATION_SECRET:
        return True, "user"
    provided = request.headers.get("X-Registration-Secret", "")
    if provided and secrets.compare_digest(provided, REGISTRATION_SECRET):
        return True, "user"
    return False, ""


# ─────────────────────────────────────────────────────────────────────────────
# Cloud state (settings + chats per user)
# ─────────────────────────────────────────────────────────────────────────────


def cloud_load(user_id: str) -> Dict[str, Any]:
    init_auth_schema()
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT settings, chats, updated_at FROM cloud_state WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if not row:
            return {"settings": None, "chats": None, "updatedAt": 0}
        import json

        return {
            "settings": json.loads(row["settings"] or "{}"),
            "chats": json.loads(row["chats"] or "[]"),
            "updatedAt": row["updated_at"],
        }
    finally:
        conn.close()


def cloud_save(user_id: str, settings: Any, chats: Any) -> Dict[str, Any]:
    init_auth_schema()
    import json

    now = int(time.time() * 1000)
    conn = get_conn()
    try:
        conn.execute(
            """
            INSERT INTO cloud_state (user_id, settings, chats, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                settings = excluded.settings,
                chats    = excluded.chats,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                json.dumps(settings or {}, ensure_ascii=False),
                json.dumps(chats or [], ensure_ascii=False),
                now,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "updatedAt": now}
