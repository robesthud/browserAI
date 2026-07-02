from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from core.database import get_conn


def _now() -> int:
    return int(time.time() * 1000)


# Schema self-healing lives in core.migrations now (shared across subsystems).
# _migrate_missing_columns is kept as a thin alias for backward compatibility.
from core.migrations import ensure_columns as _migrate_missing_columns  # noqa: E402


_schema_ready = False


def init_agent_state_schema(force: bool = False) -> None:
    # Sonnet #5: this used to run CREATE TABLE + ensure_columns (a full
    # PRAGMA table_info scan) + commit on a freshly opened connection on EVERY
    # call — and it's called at the top of every hot-path function (upsert_run,
    # get_run, get_mapping, ...). Under SSE polling that multiplies file-open +
    # write-transaction overhead. Guard with a module flag so the expensive work
    # runs once per process (startup or first call); later calls are a no-op.
    # `force=True` re-runs it (used by tests that reset the DB).
    if _schema_ready and not force:
        return
    conn = get_conn()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS agent_questions (
                id              TEXT PRIMARY KEY,
                chat_id         TEXT NOT NULL,
                conversation_id TEXT,
                user_id         TEXT,
                question        TEXT NOT NULL,
                options_json    TEXT NOT NULL DEFAULT '[]',
                status          TEXT NOT NULL DEFAULT 'pending',
                answer_json     TEXT,
                created_at      INTEGER NOT NULL,
                answered_at     INTEGER,
                updated_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_questions_chat_idx ON agent_questions(chat_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS agent_runs (
                chat_id          TEXT PRIMARY KEY,
                conversation_id  TEXT,
                user_id          TEXT,
                status           TEXT NOT NULL DEFAULT 'idle',
                last_prompt      TEXT NOT NULL DEFAULT '',
                last_error       TEXT NOT NULL DEFAULT '',
                last_event_id    INTEGER NOT NULL DEFAULT -1,
                last_turn_id     TEXT NOT NULL DEFAULT '',
                updated_at       INTEGER NOT NULL,
                created_at       INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs(user_id, updated_at DESC);
            """
        )
        # Self-healing migration: add any columns missing from older DBs.
        _migrate_missing_columns(conn)
        conn.commit()
        globals()["_schema_ready"] = True
    finally:
        conn.close()


def upsert_run(chat_id: str, conversation_id: Optional[str], user_id: Optional[str], status: str, last_prompt: str = '', last_error: str = '', last_event_id: Optional[int] = None, last_turn_id: str = '') -> None:
    # Sonnet #6: no Python read-then-write. Previously we SELECTed the current
    # row, computed last_event_id / last_turn_id / created_at in Python, then
    # INSERT..ON CONFLICT — two concurrent upserts could both read the same row
    # and clobber each other with stale derived values. Now the "preserve if not
    # provided" logic lives in SQL via COALESCE against the existing row, inside
    # a single atomic statement. Sentinels: last_event_id=NULL means "keep",
    # last_turn_id='' means "keep".
    init_agent_state_schema()
    now = _now()
    lev_param = last_event_id  # None → keep existing (COALESCE)
    ltid_param = last_turn_id or None  # '' → keep existing (COALESCE)
    conn = get_conn()
    try:
        conn.execute(
            """
            INSERT INTO agent_runs (chat_id, conversation_id, user_id, status, last_prompt, last_error, last_event_id, last_turn_id, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, -1), COALESCE(?, ''), ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
              conversation_id=excluded.conversation_id,
              user_id=excluded.user_id,
              status=excluded.status,
              last_prompt=excluded.last_prompt,
              last_error=excluded.last_error,
              last_event_id=COALESCE(?, agent_runs.last_event_id),
              last_turn_id=COALESCE(NULLIF(?, ''), agent_runs.last_turn_id),
              updated_at=excluded.updated_at
            """,
            (
                chat_id, conversation_id or '', user_id or '', status,
                last_prompt or '', last_error or '', lev_param, ltid_param, now, now,
                lev_param, last_turn_id or '',
            ),
        )
        conn.commit()
    finally:
        conn.close()


def set_run_status(chat_id: str, status: str, last_error: str = '') -> None:
    init_agent_state_schema()
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE agent_runs SET status = ?, last_error = ?, updated_at = ? WHERE chat_id = ?",
            (status, last_error or '', _now(), chat_id),
        )
        conn.commit()
    finally:
        conn.close()


def list_runs(user_id: Optional[str] = None) -> List[Dict[str, Any]]:
    init_agent_state_schema()
    conn = get_conn()
    try:
        if user_id:
            rows = conn.execute("SELECT * FROM agent_runs WHERE user_id = ? ORDER BY updated_at DESC", (user_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM agent_runs ORDER BY updated_at DESC").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_run(chat_id: str) -> Optional[Dict[str, Any]]:
    init_agent_state_schema()
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM agent_runs WHERE chat_id = ?", (chat_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_question(question_id: str, chat_id: str, conversation_id: Optional[str], user_id: Optional[str], question: str, options: List[Dict[str, Any]]) -> Dict[str, Any]:
    init_agent_state_schema()
    now = _now()
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO agent_questions (id, chat_id, conversation_id, user_id, question, options_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            (question_id, chat_id, conversation_id or '', user_id or '', question, json.dumps(options or [], ensure_ascii=False), now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return get_question(question_id) or {}


def get_question(question_id: str) -> Optional[Dict[str, Any]]:
    init_agent_state_schema()
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM agent_questions WHERE id = ?", (question_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d['options'] = json.loads(d.pop('options_json') or '[]')
        d['answer'] = json.loads(d.pop('answer_json') or 'null')
        return d
    finally:
        conn.close()


def list_questions(chat_id: Optional[str] = None, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
    init_agent_state_schema()
    conn = get_conn()
    try:
        if chat_id:
            rows = conn.execute("SELECT * FROM agent_questions WHERE chat_id = ? ORDER BY created_at DESC", (chat_id,)).fetchall()
        elif user_id:
            rows = conn.execute("SELECT * FROM agent_questions WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM agent_questions ORDER BY created_at DESC").fetchall()
        out = []
        for row in rows:
            d = dict(row)
            d['options'] = json.loads(d.pop('options_json') or '[]')
            d['answer'] = json.loads(d.pop('answer_json') or 'null')
            out.append(d)
        return out
    finally:
        conn.close()


def answer_question(question_id: str, answer: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    init_agent_state_schema()
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE agent_questions SET status = 'answered', answer_json = ?, answered_at = ?, updated_at = ? WHERE id = ?",
            (json.dumps(answer or {}, ensure_ascii=False), _now(), _now(), question_id),
        )
        conn.commit()
    finally:
        conn.close()
    return get_question(question_id)
