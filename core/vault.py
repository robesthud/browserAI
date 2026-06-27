"""
Per-user vault for encrypted API keys.

Design:
  * User sets a master passphrase. We derive a 32-byte AES key with
    PBKDF2-HMAC-SHA256 (200k iterations, 16-byte random salt).
  * We DON'T store the derived key on disk. We only store:
      - kdf_salt
      - verifier_hash = HMAC-SHA256(derived_key, b"browserai-vault-verifier-v1")
        which lets us check a passphrase is correct without keeping the key.
  * On `unlock` we recompute the derived key, verify, then cache it in
    process memory for autolock-minutes (default 30).
  * `keys.api_key` rows can be either plaintext (legacy) or
    `enc:<b64-nonce>:<b64-ciphertext>` (AES-GCM). New keys are encrypted
    when the user's vault is enabled & unlocked.

Note: this is single-process state. Restarting `browserai` clears the
in-memory cache → user must unlock again. That is the expected UX of a
client-side vault.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets as _secrets
import time
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from core.database import get_conn, init_db

try:
    # cryptography is the de-facto choice; install in Dockerfile.
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _AVAILABLE = True
except Exception:  # pragma: no cover
    AESGCM = None  # type: ignore
    _AVAILABLE = False

PBKDF2_ITERS = 200_000
SALT_BYTES = 16
NONCE_BYTES = 12
VERIFIER_TAG = b"browserai-vault-verifier-v1"
ENC_PREFIX = "enc:v1:"


def is_available() -> bool:
    return _AVAILABLE


@dataclass
class CachedKey:
    user_id: str
    key: bytes
    unlocked_at: float
    autolock_minutes: int


_cache: Dict[str, CachedKey] = {}


# ── DB helpers ─────────────────────────────────────────────────────────────


def _now() -> int:
    return int(time.time() * 1000)


def _row(user_id: str) -> Optional[Dict]:
    init_db()
    conn = get_conn()
    try:
        r = conn.execute(
            "SELECT * FROM vault_state WHERE user_id = ?", (user_id,)
        ).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def _save_state(user_id: str, **fields) -> None:
    init_db()
    cur = _row(user_id) or {
        "user_id": user_id,
        "enabled": 0,
        "locked": 1,
        "kdf_salt": None,
        "verifier_hash": None,
        "autolock_minutes": 30,
        "created_at": _now(),
    }
    cur.update(fields)
    cur["updated_at"] = _now()
    conn = get_conn()
    try:
        conn.execute(
            """
            INSERT INTO vault_state (user_id, enabled, locked, kdf_salt, verifier_hash,
                                     autolock_minutes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
                enabled=excluded.enabled, locked=excluded.locked,
                kdf_salt=excluded.kdf_salt, verifier_hash=excluded.verifier_hash,
                autolock_minutes=excluded.autolock_minutes,
                updated_at=excluded.updated_at
            """,
            (
                user_id,
                int(cur["enabled"]),
                int(cur["locked"]),
                cur["kdf_salt"],
                cur["verifier_hash"],
                int(cur["autolock_minutes"]),
                cur["created_at"],
                cur["updated_at"],
            ),
        )
        conn.commit()
    finally:
        conn.close()


# ── KDF / crypto ───────────────────────────────────────────────────────────


def _derive(passphrase: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode("utf-8"), salt, PBKDF2_ITERS, dklen=32
    )


def _verifier(derived_key: bytes) -> bytes:
    return hmac.new(derived_key, VERIFIER_TAG, hashlib.sha256).digest()


def _cache_key(user_id: str, key: bytes, autolock_minutes: int) -> None:
    _cache[user_id] = CachedKey(user_id, key, time.time(), autolock_minutes)


def _cached_key(user_id: str) -> Optional[bytes]:
    c = _cache.get(user_id)
    if not c:
        return None
    if c.autolock_minutes > 0 and (time.time() - c.unlocked_at) > c.autolock_minutes * 60:
        _cache.pop(user_id, None)
        return None
    return c.key


def encrypt(user_id: str, plaintext: str) -> Optional[str]:
    if not _AVAILABLE or not plaintext:
        return None
    key = _cached_key(user_id)
    if not key:
        return None
    aes = AESGCM(key)
    nonce = os.urandom(NONCE_BYTES)
    ct = aes.encrypt(nonce, plaintext.encode("utf-8"), None)
    return ENC_PREFIX + base64.b64encode(nonce).decode() + ":" + base64.b64encode(ct).decode()


def decrypt(user_id: str, blob: str) -> Optional[str]:
    if not blob or not blob.startswith(ENC_PREFIX) or not _AVAILABLE:
        return blob if blob and not blob.startswith(ENC_PREFIX) else None
    key = _cached_key(user_id)
    if not key:
        return None
    try:
        _, b64_nonce, b64_ct = blob.split(":", 2)
        nonce = base64.b64decode(b64_nonce)
        ct = base64.b64decode(b64_ct)
        pt = AESGCM(key).decrypt(nonce, ct, None)
        return pt.decode("utf-8")
    except Exception:
        return None


# ── Public API ─────────────────────────────────────────────────────────────


def status(user_id: str) -> Dict:
    r = _row(user_id)
    if not r:
        return {"enabled": False, "locked": False, "available": _AVAILABLE}
    cached = _cached_key(user_id) is not None
    return {
        "available": _AVAILABLE,
        "enabled": bool(r["enabled"]),
        "locked": not cached,
        "autolockMinutes": r["autolock_minutes"],
    }


def setup(user_id: str, passphrase: str, autolock_minutes: int = 30) -> Dict:
    if not _AVAILABLE:
        raise RuntimeError("vault_unavailable: cryptography module missing")
    if not passphrase or len(passphrase) < 6:
        raise ValueError("Passphrase too short (min 6 chars)")
    salt = os.urandom(SALT_BYTES)
    key = _derive(passphrase, salt)
    _save_state(
        user_id,
        enabled=1,
        locked=0,
        kdf_salt=salt,
        verifier_hash=_verifier(key),
        autolock_minutes=autolock_minutes,
    )
    _cache_key(user_id, key, autolock_minutes)
    return status(user_id)


def unlock(user_id: str, passphrase: str) -> Dict:
    r = _row(user_id)
    if not r or not r["enabled"]:
        raise ValueError("vault_not_setup")
    key = _derive(passphrase, r["kdf_salt"])
    if not hmac.compare_digest(_verifier(key), r["verifier_hash"]):
        raise ValueError("bad_passphrase")
    _cache_key(user_id, key, r["autolock_minutes"])
    _save_state(user_id, locked=0)
    return status(user_id)


def lock(user_id: str) -> Dict:
    _cache.pop(user_id, None)
    if _row(user_id):
        _save_state(user_id, locked=1)
    return status(user_id)


def change(user_id: str, new_passphrase: str) -> Dict:
    # Caller must be unlocked already
    if _cached_key(user_id) is None:
        raise ValueError("vault_locked")
    return setup(user_id, new_passphrase, _row(user_id)["autolock_minutes"])


def disable(user_id: str) -> Dict:
    _cache.pop(user_id, None)
    init_db()
    conn = get_conn()
    try:
        conn.execute("DELETE FROM vault_state WHERE user_id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()
    return {"available": _AVAILABLE, "enabled": False, "locked": False}


def autolock(user_id: str, minutes: int) -> Dict:
    if minutes < 0:
        minutes = 0
    _save_state(user_id, autolock_minutes=minutes)
    c = _cache.get(user_id)
    if c:
        c.autolock_minutes = minutes
    return status(user_id)


def backup(user_id: str) -> Dict:
    r = _row(user_id)
    if not r or not r["enabled"]:
        raise ValueError("vault_not_setup")
    return {
        "version": 1,
        "userId": user_id,
        "kdfSalt": base64.b64encode(r["kdf_salt"]).decode(),
        "verifierHash": base64.b64encode(r["verifier_hash"]).decode(),
        "autolockMinutes": r["autolock_minutes"],
    }


def restore(user_id: str, payload: Dict) -> Dict:
    if not payload or payload.get("version") != 1:
        raise ValueError("unsupported_backup")
    _save_state(
        user_id,
        enabled=1,
        locked=1,
        kdf_salt=base64.b64decode(payload["kdfSalt"]),
        verifier_hash=base64.b64decode(payload["verifierHash"]),
        autolock_minutes=int(payload.get("autolockMinutes", 30)),
    )
    _cache.pop(user_id, None)
    return status(user_id)


# ── Helpers for callers (server.py) ────────────────────────────────────────


def resolve_secret(user_id: str, stored_value: str) -> str:
    """If stored_value is encrypted, try to decrypt with cached key.
    If user has no vault or cache, returns stored_value as-is (plaintext)
    or empty string when encrypted but vault is locked."""
    if not stored_value:
        return ""
    if not stored_value.startswith(ENC_PREFIX):
        return stored_value
    plain = decrypt(user_id, stored_value)
    return plain or ""
