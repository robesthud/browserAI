"""
Step 8 — read-side for jobs / cost / notifications.

These tables already contain real data from the previous Node-era stack
(jobs, llm_spend, notifications). This module exposes them through the
BrowserAI API contract the UI expects, replacing the stub responses.

Access model: an `owner` user sees ALL rows (single-tenant admin view);
a normal user sees only their own (user_id scoped). This keeps legacy data
(owned by an old user_id) visible to the owner while staying safe for
multi-user setups.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from core.database import get_conn


def _now() -> int:
    return int(time.time() * 1000)


def _table_exists(conn, name: str) -> bool:
    r = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return r is not None


def _jload(s: Any, default: Any) -> Any:
    try:
        return json.loads(s) if s else default
    except Exception:
        return default


# ─────────────────────────────────────────────────────────────────────────────
# Jobs
# ─────────────────────────────────────────────────────────────────────────────


def list_jobs(
    user_id: str, is_owner: bool, status: Optional[str] = None, limit: int = 100
) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        if not _table_exists(conn, "jobs"):
            return []
        where = []
        args: List[Any] = []
        if not is_owner:
            where.append("user_id = ?")
            args.append(user_id)
        if status:
            where.append("status = ?")
            args.append(status)
        sql = "SELECT * FROM jobs"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(max(1, min(limit, 500)))
        rows = conn.execute(sql, args).fetchall()
        return [_job_public(dict(r)) for r in rows]
    finally:
        conn.close()


def get_job(user_id: str, is_owner: bool, job_id: str) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    try:
        if not _table_exists(conn, "jobs"):
            return None
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        if not is_owner and d.get("user_id") != user_id:
            return None
        return _job_public(d, full=True)
    finally:
        conn.close()


def _job_public(d: Dict[str, Any], full: bool = False) -> Dict[str, Any]:
    out = {
        "id": d.get("id"),
        "chatId": d.get("chat_id"),
        "type": d.get("type"),
        "status": d.get("status"),
        "title": d.get("title"),
        "progress": d.get("progress") or 0,
        "error": d.get("error") or "",
        "createdAt": d.get("created_at"),
        "updatedAt": d.get("updated_at"),
        "finishedAt": d.get("finished_at"),
        "parentJobId": d.get("parent_job_id") or None,
    }
    if full:
        out["input"] = _jload(d.get("input_json"), {})
        out["result"] = _jload(d.get("result_json"), {})
        out["logs"] = _jload(d.get("logs"), [])
        out["trace"] = _jload(d.get("trace_json"), [])
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Cost (llm_spend)
# ─────────────────────────────────────────────────────────────────────────────


def cost_today(user_id: str, is_owner: bool) -> Dict[str, Any]:
    """Aggregate llm_spend for the current UTC day (+ all-time totals)."""
    conn = get_conn()
    try:
        if not _table_exists(conn, "llm_spend"):
            return {"today": _empty_cost(), "allTime": _empty_cost(), "byModel": []}
        # start of today (UTC), ms
        day_start = int(time.time()) // 86400 * 86400 * 1000
        scope = "" if is_owner else " AND user_id = ?"
        base_args: List[Any] = [] if is_owner else [user_id]

        def agg(extra_where: str, extra_args: List[Any]) -> Dict[str, Any]:
            sql = (
                "SELECT COUNT(*) c, "
                "COALESCE(SUM(prompt_tokens),0) pt, "
                "COALESCE(SUM(completion_tokens),0) ct, "
                "COALESCE(SUM(cost_usd),0.0) cost "
                "FROM llm_spend WHERE 1=1" + scope + extra_where
            )
            r = conn.execute(sql, base_args + extra_args).fetchone()
            return {
                "calls": r["c"],
                "promptTokens": r["pt"],
                "completionTokens": r["ct"],
                "costUsd": round(r["cost"] or 0.0, 6),
            }

        today = agg(" AND ts >= ?", [day_start])
        all_time = agg("", [])

        # top models by cost
        msql = (
            "SELECT model, COUNT(*) c, COALESCE(SUM(cost_usd),0.0) cost "
            "FROM llm_spend WHERE 1=1" + scope +
            " GROUP BY model ORDER BY cost DESC, c DESC LIMIT 10"
        )
        by_model = [
            {"model": r["model"], "calls": r["c"], "costUsd": round(r["cost"] or 0.0, 6)}
            for r in conn.execute(msql, base_args).fetchall()
        ]
        return {"ok": True, "today": today, "allTime": all_time, "byModel": by_model}
    finally:
        conn.close()


def _empty_cost() -> Dict[str, Any]:
    return {"calls": 0, "promptTokens": 0, "completionTokens": 0, "costUsd": 0.0}


def record_spend(
    user_id: str,
    chat_id: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cost_usd: float = 0.0,
) -> None:
    """Append a spend row (called from the chat path when llm_metrics seen)."""
    conn = get_conn()
    try:
        if not _table_exists(conn, "llm_spend"):
            return
        conn.execute(
            "INSERT INTO llm_spend (user_id, chat_id, ts, model, prompt_tokens, completion_tokens, cost_usd) "
            "VALUES (?,?,?,?,?,?,?)",
            (user_id or "", chat_id or "", _now(), model or "", int(prompt_tokens or 0),
             int(completion_tokens or 0), float(cost_usd or 0.0)),
        )
        conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Notifications
# ─────────────────────────────────────────────────────────────────────────────


def list_notifications(
    user_id: str, is_owner: bool, limit: int = 50
) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        if not _table_exists(conn, "notifications"):
            return []
        scope = "" if is_owner else " WHERE user_id = ?"
        args: List[Any] = [] if is_owner else [user_id]
        rows = conn.execute(
            "SELECT * FROM notifications" + scope + " ORDER BY created_at DESC LIMIT ?",
            args + [max(1, min(limit, 200))],
        ).fetchall()
        return [_notif_public(dict(r)) for r in rows]
    finally:
        conn.close()


def notifications_summary(user_id: str, is_owner: bool) -> Dict[str, Any]:
    conn = get_conn()
    try:
        if not _table_exists(conn, "notifications"):
            return {"unread": 0, "total": 0}
        scope = "" if is_owner else " WHERE user_id = ?"
        args: List[Any] = [] if is_owner else [user_id]
        total = conn.execute(
            "SELECT COUNT(*) c FROM notifications" + scope, args
        ).fetchone()["c"]
        unread_scope = scope + (" AND" if scope else " WHERE") + " (status='unread' OR read_at IS NULL)"
        unread = conn.execute(
            "SELECT COUNT(*) c FROM notifications" + unread_scope, args
        ).fetchone()["c"]
        return {"ok": True, "unread": unread, "total": total}
    finally:
        conn.close()


def mark_all_read(user_id: str, is_owner: bool) -> Dict[str, Any]:
    conn = get_conn()
    try:
        if not _table_exists(conn, "notifications"):
            return {"ok": True, "updated": 0}
        scope = "" if is_owner else " AND user_id = ?"
        args: List[Any] = [] if is_owner else [user_id]
        cur = conn.execute(
            "UPDATE notifications SET status='read', read_at=? "
            "WHERE (status='unread' OR read_at IS NULL)" + scope,
            [_now()] + args,
        )
        conn.commit()
        return {"ok": True, "updated": cur.rowcount}
    finally:
        conn.close()


def _notif_public(d: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": d.get("id"),
        "kind": d.get("kind"),
        "severity": d.get("severity"),
        "status": d.get("status") or ("read" if d.get("read_at") else "unread"),
        "title": d.get("title"),
        "message": d.get("message"),
        "entityType": d.get("entity_type"),
        "entityId": d.get("entity_id"),
        "data": _jload(d.get("data_json"), {}),
        "createdAt": d.get("created_at"),
        "readAt": d.get("read_at"),
    }
