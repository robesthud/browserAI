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


# ─────────────────────────────────────────────────────────────────────────────
# SQL identifiers whitelist — table names and ORDER BY clauses that are
# allowed in f-string SQL fragments.  This prevents SQL injection even if
# a future refactor accidentally passes user-controlled input as `table`
# or `order`.  Adding a new table requires an explicit entry here.
# ─────────────────────────────────────────────────────────────────────────────

ALLOWED_TABLES = frozenset({
    "jobs",
    "llm_spend",
    "notifications",
    "operator_missions",
    "operator_mission_events",
    "operator_projects",
    "incidents",
})

ALLOWED_ORDER_CLAUSES = frozenset({
    "created_at DESC",
    "created_at ASC",
    "updated_at DESC",
    "updated_at ASC",
    "id DESC",
    "id ASC",
})


def _validate_table(name: str) -> str:
    """Raise ValueError if *name* is not in the whitelist."""
    if name not in ALLOWED_TABLES:
        raise ValueError(
            f"Table name '{name}' is not in ALLOWED_TABLES. "
            f"Allowed: {sorted(ALLOWED_TABLES)}"
        )
    return name


def _validate_order(clause: str) -> str:
    """Raise ValueError if *clause* is not in the whitelist."""
    if clause not in ALLOWED_ORDER_CLAUSES:
        raise ValueError(
            f"ORDER BY clause '{clause}' is not in ALLOWED_ORDER_CLAUSES. "
            f"Allowed: {sorted(ALLOWED_ORDER_CLAUSES)}"
        )
    return clause


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


# ─────────────────────────────────────────────────────────────────────────────
# Step 9 — Operator (missions / projects / events / incidents)
# ─────────────────────────────────────────────────────────────────────────────


def _scoped_rows(table: str, user_id: str, is_owner: bool, limit: int, order: str = "created_at DESC") -> List[Dict[str, Any]]:
    _validate_table(table)
    _validate_order(order)
    conn = get_conn()
    try:
        if not _table_exists(conn, table):
            return []
        scope = "" if is_owner else " WHERE user_id = ?"
        args: List[Any] = [] if is_owner else [user_id]
        rows = conn.execute(
            f"SELECT * FROM {table}{scope} ORDER BY {order} LIMIT ?",
            args + [max(1, min(limit, 200))],
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def list_operator_missions(user_id: str, is_owner: bool, limit: int = 50) -> List[Dict[str, Any]]:
    out = []
    for d in _scoped_rows("operator_missions", user_id, is_owner, limit):
        out.append({
            "id": d.get("id"), "projectId": d.get("project_id"), "type": d.get("type"),
            "title": d.get("title"), "status": d.get("status"), "goal": d.get("goal"),
            "jobId": d.get("job_id") or None, "error": d.get("error") or "",
            "result": _jload(d.get("result_json"), {}),
            "createdAt": d.get("created_at"), "updatedAt": d.get("updated_at"),
            "finishedAt": d.get("finished_at"),
        })
    return out


def get_operator_mission(user_id: str, is_owner: bool, mission_id: str) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    try:
        if not _table_exists(conn, "operator_missions"):
            return None
        row = conn.execute("SELECT * FROM operator_missions WHERE id = ?", (mission_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        if not is_owner and d.get("user_id") != user_id:
            return None
        events = []
        if _table_exists(conn, "operator_mission_events"):
            evs = conn.execute(
                "SELECT * FROM operator_mission_events WHERE mission_id = ? ORDER BY created_at ASC",
                (mission_id,),
            ).fetchall()
            events = [{
                "id": e["id"], "type": e["type"], "title": e["title"],
                "message": e["message"], "data": _jload(e["data_json"], {}),
                "createdAt": e["created_at"],
            } for e in evs]
        return {
            "id": d.get("id"), "projectId": d.get("project_id"), "type": d.get("type"),
            "title": d.get("title"), "status": d.get("status"), "goal": d.get("goal"),
            "result": _jload(d.get("result_json"), {}), "events": events,
            "createdAt": d.get("created_at"), "updatedAt": d.get("updated_at"),
        }
    finally:
        conn.close()


def list_operator_projects(user_id: str, is_owner: bool, limit: int = 50) -> List[Dict[str, Any]]:
    conn = get_conn()
    try:
        if not _table_exists(conn, "operator_projects"):
            return []
        rows = conn.execute(
            "SELECT * FROM operator_projects ORDER BY updated_at DESC LIMIT ?",
            (max(1, min(limit, 200)),),
        ).fetchall()
        return [{
            "id": r["id"], "name": r["name"], "repo": r["repo"],
            "localPath": r["local_path"], "productionPath": r["production_path"],
            "defaultBranch": r["default_branch"], "meta": _jload(r["meta_json"], {}),
            "createdAt": r["created_at"], "updatedAt": r["updated_at"],
        } for r in rows]
    finally:
        conn.close()


def list_incidents(user_id: str, is_owner: bool, limit: int = 50) -> List[Dict[str, Any]]:
    out = []
    for d in _scoped_rows("incidents", user_id, is_owner, limit):
        out.append({
            "id": d.get("id"), "source": d.get("source"), "severity": d.get("severity"),
            "status": d.get("status"), "title": d.get("title"),
            "fingerprint": d.get("fingerprint"), "details": _jload(d.get("details_json"), {}),
            "createdAt": d.get("created_at"), "updatedAt": d.get("updated_at"),
            "resolvedAt": d.get("resolved_at"),
        })
    return out


def operator_status(user_id: str, is_owner: bool) -> Dict[str, Any]:
    """Aggregate counts for the operator dashboard."""
    conn = get_conn()
    try:
        def cnt(table: str, where: str = "", args: Optional[List[Any]] = None) -> int:
            _validate_table(table)
            if not _table_exists(conn, table):
                return 0
            scope = "" if is_owner else (" WHERE user_id = ?" if not where else " AND user_id = ?")
            base = [] if is_owner else [user_id]
            sql = f"SELECT COUNT(*) c FROM {table}"
            if where:
                sql += " WHERE " + where + (scope if not is_owner else "")
                return conn.execute(sql, (args or []) + base).fetchone()["c"]
            sql += scope
            return conn.execute(sql, base).fetchone()["c"]

        return {
            "ok": True,
            "missions": cnt("operator_missions"),
            "missionsRunning": cnt("operator_missions", "status='running'"),
            "projects": cnt("operator_projects"),
            "incidents": cnt("incidents"),
            "incidentsOpen": cnt("incidents", "status='open'"),
        }
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Gateway / health status (no docker socket; checks reachability)
# ─────────────────────────────────────────────────────────────────────────────


async def gateway_status(openhands_url: str) -> Dict[str, Any]:
    import shutil
    import httpx as _httpx

    services: List[Dict[str, Any]] = []

    # browserai self
    services.append({"name": "browserai", "status": "up", "detail": "self"})

    # openhands reachability
    oh = {"name": "openhands", "status": "down", "detail": ""}
    try:
        async with _httpx.AsyncClient() as c:
            r = await c.get(f"{openhands_url}/api/options/models", timeout=5.0)
            oh["status"] = "up" if r.status_code < 500 else "degraded"
            oh["detail"] = f"HTTP {r.status_code}"
    except Exception as e:
        oh["detail"] = str(e)[:80]
    services.append(oh)

    # db reachability
    db = {"name": "database", "status": "down", "detail": "sqlite"}
    try:
        conn = get_conn()
        conn.execute("SELECT 1").fetchone()
        conn.close()
        db["status"] = "up"
    except Exception as e:
        db["detail"] = str(e)[:80]
    services.append(db)

    # disk
    disk_ok = True
    disk_detail = ""
    try:
        total, used, free = shutil.disk_usage("/")
        free_gb = free / (1024 ** 3)
        disk_ok = free_gb > 2.0
        disk_detail = f"{free_gb:.1f} GB free"
    except Exception as e:
        disk_detail = str(e)[:80]
    services.append({"name": "disk", "status": "up" if disk_ok else "degraded", "detail": disk_detail})

    overall = "up" if all(s["status"] == "up" for s in services) else "degraded"
    return {"ok": True, "overall": overall, "services": services}


async def deep_health(openhands_url: str) -> Dict[str, Any]:
    """Step 10.5 — deep readiness probe.

    Checks: db reachable, OpenHands reachable, an active LLM key is configured,
    free disk > 5 GB. Returns {ok, status: ready|degraded, checks:[...]}.
    The shallow /api/health stays as the UI online/offline signal; this is for
    ops dashboards and load-balancer readiness.
    """
    import shutil
    import httpx as _httpx
    from core.database import get_active_key

    checks: List[Dict[str, Any]] = []

    # 1) database
    db = {"name": "database", "ok": False, "detail": "sqlite"}
    try:
        conn = get_conn()
        conn.execute("SELECT 1").fetchone()
        conn.close()
        db["ok"] = True
    except Exception as e:
        db["detail"] = str(e)[:120]
    checks.append(db)

    # 2) openhands reachability
    oh = {"name": "openhands", "ok": False, "detail": ""}
    try:
        async with _httpx.AsyncClient() as c:
            r = await c.get(f"{openhands_url}/api/options/models", timeout=5.0)
            oh["ok"] = r.status_code < 500
            oh["detail"] = f"HTTP {r.status_code}"
    except Exception as e:
        oh["detail"] = str(e)[:120]
    checks.append(oh)

    # 3) active LLM key configured
    key = {"name": "llm_key", "ok": False, "detail": "no active key"}
    try:
        ak = get_active_key(include_secret=True)
        if ak and (ak.get("apiKey") or ak.get("secret")):
            key["ok"] = True
            key["detail"] = f"provider={ak.get('provider') or ak.get('type') or 'unknown'}"
        elif ak:
            key["detail"] = "active key present but no secret"
    except Exception as e:
        key["detail"] = str(e)[:120]
    checks.append(key)

    # 4) free disk > 5 GB
    disk = {"name": "disk", "ok": False, "detail": ""}
    try:
        total, used, free = shutil.disk_usage("/")
        free_gb = free / (1024 ** 3)
        disk["ok"] = free_gb > 5.0
        disk["detail"] = f"{free_gb:.1f} GB free"
    except Exception as e:
        disk["detail"] = str(e)[:120]
    checks.append(disk)

    all_ok = all(c["ok"] for c in checks)
    return {
        "ok": all_ok,
        "status": "ready" if all_ok else "degraded",
        "checks": checks,
    }
