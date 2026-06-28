"""Shared utilities for BrowserAI core modules."""

import os


def safe_chat_id(chat_id: str) -> str:
    """Sanitize chat_id for use in filesystem paths and Docker labels.
    
    Same logic used across isolation.py, conversations.py, and server.py.
    Centralized here to avoid duplication and drift.
    """
    raw = str(chat_id or "").strip()
    safe = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in raw)
    return safe[:96] or "default"


# Standard paths used by isolation and conversations modules
DATA_DIR = os.environ.get("DATA_DIR", "/opt/browserai-data")
CHAT_WORKSPACE_ROOT = os.path.join(DATA_DIR, "workspace", "chats")
SANDBOX_DIR = os.path.join(DATA_DIR, "workspace", "_sandbox")
