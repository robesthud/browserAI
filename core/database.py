import sqlite3
import json
import os
import time

DB_PATH = os.environ.get("BROWSERAI_DB", "/data/browserai.db")

def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_conn()
    conn.execute("""
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
            updated_at       INTEGER NOT NULL
        );
    """)
    conn.commit()

    # Миграция стартовых ключей из .env ровно один раз, если таблица пуста
    cursor = conn.execute("SELECT count(*) as c FROM keys")
    count = cursor.fetchone()["c"]
    if count == 0:
        now = int(time.time() * 1000)
        glm_models = json.dumps(["glm-4.5-flash", "GLM-4.7-Flash", "glm-4-flash", "glm-z1-flash", "glm-4v-flash", "glm-4.1v-thinking-flash", "glm-4.6v-flash", "glm-4.7", "glm-5.1", "glm-5.2"])
        ds_models = json.dumps(["deepseek_chat", "deepseek-reasoner", "DeepThink"])
        
        bigmodel_key = os.environ.get("BIGMODEL_API_KEY", "")
        
        conn.execute("""
            INSERT INTO keys (id, name, base_url, api_key, model, available_models, is_active, enc, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("glm-default", "Zhipu AI (GLM)", "https://open.bigmodel.cn/api/paas/v4", bigmodel_key, "glm-4.5-flash", glm_models, 1, 0, now, now))
        
        conn.execute("""
            INSERT INTO keys (id, name, base_url, api_key, model, available_models, is_active, enc, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("deepseek-default", "DeepSeek Managed", "https://chat.deepseek.com/api/v0", "__managed__", "deepseek_chat", ds_models, 0, 0, now, now))
        conn.commit()
    conn.close()

def list_keys():
    init_db()
    conn = get_conn()
    rows = conn.execute("SELECT * FROM keys").fetchall()
    conn.close()
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "name": r["name"],
            "baseUrl": r["base_url"],
            "apiKey": r["api_key"],
            "model": r["model"],
            "availableModels": json.loads(r["available_models"] or "[]"),
            "isActive": bool(r["is_active"]),
            "hasSecret": bool(r["api_key"]),
            "useStoredSecret": bool(r["api_key"])
        })
    return result

def get_active_key():
    init_db()
    conn = get_conn()
    row = conn.execute("SELECT * FROM keys WHERE is_active = 1").fetchone()
    if not row:
        row = conn.execute("SELECT * FROM keys").fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "baseUrl": row["base_url"],
        "apiKey": row["api_key"],
        "model": row["model"],
        "availableModels": json.loads(row["available_models"] or "[]")
    }

def upsert_key(k):
    init_db()
    now = int(time.time() * 1000)
    conn = get_conn()
    k_id = k.get("id")
    name = k.get("name", "")
    base_url = k.get("baseUrl", "")
    api_key = k.get("apiKey", "")
    model = k.get("model", "")
    available_models = json.dumps(k.get("availableModels", []))
    
    conn.execute("""
        INSERT INTO keys (id, name, base_url, api_key, model, available_models, is_active, enc, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, base_url=excluded.base_url, api_key=excluded.api_key,
            model=excluded.model, available_models=excluded.available_models, updated_at=excluded.updated_at
    """, (k_id, name, base_url, api_key, model, available_models, now, now))
    conn.commit()
    conn.close()
    return list_keys()

def delete_key(k_id):
    init_db()
    conn = get_conn()
    conn.execute("DELETE FROM keys WHERE id = ?", (k_id,))
    conn.commit()
    conn.close()
    return list_keys()

def set_active_key(k_id):
    init_db()
    conn = get_conn()
    conn.execute("UPDATE keys SET is_active = 0")
    conn.execute("UPDATE keys SET is_active = 1 WHERE id = ?", (k_id,))
    conn.commit()
    conn.close()
    return list_keys()
