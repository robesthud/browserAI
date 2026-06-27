from __future__ import annotations

import json
import math
import re
import time
import uuid
from collections import Counter
from typing import Any, Dict, List, Optional

from core.database import get_conn


def _now() -> int:
    return int(time.time() * 1000)


def _tokenize(text: str) -> List[str]:
    return re.findall(r"[\wа-яА-ЯёЁ]{2,}", (text or '').lower())


def _tf(text: str) -> Dict[str, float]:
    toks = _tokenize(text)
    if not toks:
        return {}
    c = Counter(toks)
    total = float(sum(c.values()))
    return {k: v / total for k, v in c.items()}


def _dot(a: Dict[str, float], b: Dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(k, 0.0) for k, v in a.items())


def list_facts(user_id: str) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT user_id, key, value, updated_at FROM user_facts WHERE user_id = ? ORDER BY updated_at DESC, key ASC",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def upsert_fact(user_id: str, key: str, value: str) -> Dict[str, Any]:
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO user_facts (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (user_id, key, value, _now()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"user_id": user_id, "key": key, "value": value, "updated_at": _now()}


def delete_fact(user_id: str, key: str) -> bool:
    conn = get_conn()
    try:
        cur = conn.execute("DELETE FROM user_facts WHERE user_id = ? AND key = ?", (user_id, key))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def search_semantic(user_id: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        try:
            rows = conn.execute(
                "SELECT sm.* FROM semantic_memory_fts f JOIN semantic_memory sm ON sm.id = f.mem_id WHERE semantic_memory_fts MATCH ? AND sm.user_id = ? LIMIT ?",
                (query, user_id, limit),
            ).fetchall()
            if rows:
                return [dict(r) for r in rows]
        except Exception:
            pass
        qtf = _tf(query)
        rows = conn.execute("SELECT * FROM semantic_memory WHERE user_id = ?", (user_id,)).fetchall()
        scored = []
        for r in rows:
            text = r['text'] or ''
            score = _dot(qtf, _tf(text))
            if score > 0:
                d = dict(r)
                d['score'] = score
                scored.append(d)
        scored.sort(key=lambda x: x.get('score', 0), reverse=True)
        return scored[:limit]
    finally:
        conn.close()


def list_project_memory(user_id: str, chat_id: Optional[str] = None) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        if chat_id:
            rows = conn.execute(
                "SELECT * FROM project_memory WHERE user_id = ? AND chat_id = ? ORDER BY updated_at DESC, key ASC",
                (user_id, chat_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM project_memory WHERE user_id = ? ORDER BY updated_at DESC, key ASC",
                (user_id,),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def upsert_project_memory(user_id: str, chat_id: str, key: str, value: str) -> Dict[str, Any]:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id FROM project_memory WHERE user_id = ? AND chat_id = ? AND key = ?",
            (user_id, chat_id, key),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE project_memory SET value = ?, updated_at = ? WHERE id = ?",
                (value, _now(), row['id']),
            )
            pm_id = row['id']
        else:
            cur = conn.execute(
                "INSERT INTO project_memory (user_id, chat_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, chat_id, key, value, _now()),
            )
            pm_id = cur.lastrowid
        conn.commit()
        return {"id": pm_id, "user_id": user_id, "chat_id": chat_id, "key": key, "value": value, "updated_at": _now()}
    finally:
        conn.close()


def delete_project_memory(user_id: str, chat_id: str, key: str) -> bool:
    conn = get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM project_memory WHERE user_id = ? AND chat_id = ? AND key = ?",
            (user_id, chat_id, key),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def kb_list(user_id: str) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        rows = conn.execute("SELECT * FROM kb_documents WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def kb_add(user_id: str, title: str, text: str, source: str = '') -> Dict[str, Any]:
    conn = get_conn()
    try:
        doc_id = f'doc_{uuid.uuid4().hex[:12]}'
        created = _now()
        raw = text or ''
        conn.execute(
            "INSERT INTO kb_documents (id, user_id, title, source, created_at, bytes) VALUES (?, ?, ?, ?, ?, ?)",
            (doc_id, user_id, title or 'Untitled', source or '', created, len(raw.encode('utf-8'))),
        )
        chunks = [c.strip() for c in re.split(r'\n\s*\n+', raw) if c.strip()] or [raw.strip()]
        for i, chunk in enumerate(chunks):
            chunk_id = f'chunk_{uuid.uuid4().hex[:12]}'
            conn.execute(
                "INSERT INTO kb_chunks (id, doc_id, user_id, ord, text, tfidf_json) VALUES (?, ?, ?, ?, ?, ?)",
                (chunk_id, doc_id, user_id, i, chunk, json.dumps(_tf(chunk), ensure_ascii=False)),
            )
        conn.commit()
        return {"id": doc_id, "user_id": user_id, "title": title or 'Untitled', "source": source or '', "created_at": created, "bytes": len(raw.encode('utf-8')), "chunks": len(chunks)}
    finally:
        conn.close()


def kb_delete(user_id: str, doc_id: str) -> bool:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM kb_chunks WHERE user_id = ? AND doc_id = ?", (user_id, doc_id))
        cur = conn.execute("DELETE FROM kb_documents WHERE user_id = ? AND id = ?", (user_id, doc_id))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def kb_search(user_id: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        qtf = _tf(query)
        rows = conn.execute(
            "SELECT c.*, d.title, d.source FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id WHERE c.user_id = ?",
            (user_id,),
        ).fetchall()
        scored = []
        for r in rows:
            try:
                vec = json.loads(r['tfidf_json'] or '{}')
            except Exception:
                vec = _tf(r['text'] or '')
            score = _dot(qtf, vec)
            if score > 0:
                d = dict(r)
                d['score'] = score
                scored.append(d)
        scored.sort(key=lambda x: x.get('score', 0), reverse=True)
        return scored[:limit]
    finally:
        conn.close()
