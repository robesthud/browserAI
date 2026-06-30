from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from core.database import get_conn


def _now() -> int:
    return int(time.time() * 1000)


def init_agent_state_schema() -> None:
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
        conn.commit()
    finally:
        conn.close()


def upsert_run(chat_id: str, conversation_id: Optional[str], user_id: Optional[str], status: str, last_prompt: str = '', last_error: str = '', last_event_id: Optional[int] = None, last_turn_id: str = '') -> None:
    init_agent_state_schema()
    now = _now()
    conn = get_conn()
    try:
        current = conn.execute("SELECT * FROM agent_runs WHERE chat_id = ?", (chat_id,)).fetchone()
        created_at = current['created_at'] if current else now
        lev = last_event_id if last_event_id is not None else (current['last_event_id'] if current else -1)
        ltid = last_turn_id or (current['last_turn_id'] if current else '')
        conn.execute(
            """
            INSERT INTO agent_runs (chat_id, conversation_id, user_id, status, last_prompt, last_error, last_event_id, last_turn_id, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
              conversation_id=excluded.conversation_id,
              user_id=excluded.user_id,
              status=excluded.status,
              last_prompt=excluded.last_prompt,
              last_error=excluded.last_error,
              last_event_id=excluded.last_event_id,
              last_turn_id=excluded.last_turn_id,
              updated_at=excluded.updated_at
            """,
            (chat_id, conversation_id or '', user_id or '', status, last_prompt or '', last_error or '', lev, ltid, now, created_at),
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
