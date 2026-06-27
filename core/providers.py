"""
Provider-aware helpers:
  * model_catalog(base_url, auth_header)        — fetch & cache /models
  * validate_key(provider_dict)                  — issue a tiny chat completion
  * qualify_model(base_url, model)               — add openai/ etc prefix
  * push_to_openhands(client, oh_url, provider, params) — sync OH settings
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional

import httpx

log = logging.getLogger("browserai.providers")

_MODELS_CACHE: Dict[str, Dict[str, Any]] = {}
_MODELS_TTL = int(os.environ.get("BROWSERAI_MODELS_TTL", "3600"))


# Hardcoded fallbacks for providers that don't expose /models or whose
# catalog endpoint is closed.
_FALLBACK_MODELS: Dict[str, List[str]] = {
    "bigmodel.cn": [
        "glm-4.5-flash", "glm-4.7-flash", "glm-4-flash", "glm-z1-flash",
        "glm-4v-flash", "glm-4.1v-thinking-flash", "glm-4.6", "glm-4.7", "glm-5",
    ],
    "api.z.ai": ["glm-4.5-flash", "glm-4.6", "glm-4.7"],
    "deepseek.com": ["deepseek-chat", "deepseek-reasoner", "DeepThink"],
    "anthropic.com": [
        "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229", "claude-sonnet-4-20250514",
    ],
    "googleapis.com": [
        "gemini-2.0-flash-exp", "gemini-2.0-flash", "gemini-1.5-pro",
        "gemini-1.5-flash",
    ],
    "openrouter.ai": [
        "openrouter/anthropic/claude-3.5-sonnet",
        "openrouter/google/gemini-2.0-flash-exp",
        "openrouter/openai/gpt-4o",
    ],
    "openai.com": [
        "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1-preview", "o1-mini",
    ],
}


def qualify_model(base_url: str, model: str) -> str:
    """LiteLLM (inside OpenHands) needs `openai/<model>` for OpenAI-
    compatible endpoints that aren't OpenAI proper. Native Anthropic /
    Gemini / Bedrock keep their own prefixes."""
    if not model:
        return "openai/glm-4.5-flash"
    if "/" in model:
        return model  # already qualified

    bu = (base_url or "").lower()
    if "anthropic" in bu:
        return f"anthropic/{model}"
    if "generativelanguage.googleapis.com" in bu or "/gemini" in bu:
        return f"gemini/{model}"
    if any(h in bu for h in ("bigmodel.cn", "api.z.ai", "deepseek.com")):
        return f"openai/{model}"
    if "openrouter" in bu:
        return f"openrouter/{model}" if not model.startswith("openrouter/") else model
    # Default: treat as openai-compatible
    return f"openai/{model}"


def _build_headers(provider: Dict[str, Any]) -> Dict[str, str]:
    api_key = provider.get("apiKey") or ""
    auth_type = (provider.get("authType") or "bearer").lower()
    auth_header = provider.get("authHeader") or ""
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    if auth_type == "bearer" and api_key and api_key != "__managed__":
        headers["Authorization"] = f"Bearer {api_key}"
    elif auth_type == "custom" and auth_header and api_key:
        headers[auth_header] = api_key
    elif auth_type == "cookie":
        # cookies are passed via extraHeaders.Cookie typically
        pass
    extra = provider.get("extraHeaders") or {}
    if isinstance(extra, dict):
        for k, v in extra.items():
            if k and v:
                headers[str(k)] = str(v)
    return headers


async def fetch_models(base_url: str, provider: Dict[str, Any]) -> List[str]:
    """Try to GET /models or /v1/models from the provider, fall back to
    hardcoded catalog if it 401s or 404s. Cached for _MODELS_TTL seconds."""
    bu = (base_url or "").rstrip("/")
    if not bu:
        return []
    cache = _MODELS_CACHE.get(bu)
    if cache and (time.time() - cache["ts"]) < _MODELS_TTL:
        return cache["models"]

    headers = _build_headers(provider)
    paths = ["/models", "/v1/models"]
    # If base already ends with /v1 try sibling /models first
    if bu.endswith("/v1") or bu.endswith("/paas/v4"):
        paths = ["/models"]

    models: List[str] = []
    async with httpx.AsyncClient(timeout=10.0) as c:
        for p in paths:
            try:
                r = await c.get(bu + p, headers=headers)
                if r.status_code == 200:
                    data = r.json()
                    raw = (
                        data.get("data")
                        or data.get("models")
                        or (data if isinstance(data, list) else [])
                    )
                    for item in raw or []:
                        if isinstance(item, dict):
                            mid = item.get("id") or item.get("name") or item.get("model")
                            if mid:
                                models.append(str(mid))
                        elif isinstance(item, str):
                            models.append(item)
                    if models:
                        break
            except Exception as e:
                log.debug("models fetch failed for %s%s: %s", bu, p, e)
                continue

    if not models:
        for host_key, fallback in _FALLBACK_MODELS.items():
            if host_key in bu.lower():
                models = list(fallback)
                break

    # dedup, keep order
    seen = set()
    uniq = []
    for m in models:
        if m and m not in seen:
            uniq.append(m); seen.add(m)

    _MODELS_CACHE[bu] = {"ts": time.time(), "models": uniq}
    return uniq


async def validate_key(provider: Dict[str, Any], timeout: float = 8.0) -> Dict[str, Any]:
    """Cheap probe: one-token chat completion. Returns
    {ok, latencyMs, error?, model?}."""
    base_url = (provider.get("baseUrl") or "").rstrip("/")
    model = provider.get("model") or ""
    api_key = provider.get("apiKey") or ""
    if not base_url:
        return {"ok": False, "error": "no_base_url"}
    if not api_key or api_key == "__managed__":
        # Managed keys are validated on the actual /chat path; report inconclusive.
        return {"ok": True, "managed": True}

    # Strip openai/ prefix when calling provider directly
    plain_model = model.split("/", 1)[1] if "/" in model else model
    # Native Anthropic uses /messages not /chat/completions
    is_anthropic = "anthropic.com" in base_url.lower()
    is_gemini = "generativelanguage.googleapis.com" in base_url.lower()
    headers = _build_headers(provider)

    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            if is_anthropic:
                headers["anthropic-version"] = headers.get("anthropic-version", "2023-06-01")
                # Anthropic uses x-api-key not Bearer
                if api_key and "x-api-key" not in {k.lower() for k in headers}:
                    headers.pop("Authorization", None)
                    headers["x-api-key"] = api_key
                payload = {
                    "model": plain_model or "claude-3-5-haiku-20241022",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "hi"}],
                }
                r = await c.post(base_url + "/messages", json=payload, headers=headers)
            elif is_gemini:
                # Gemini REST: ?key=... query param
                mid = plain_model or "gemini-1.5-flash"
                url = f"{base_url}/models/{mid}:generateContent?key={api_key}"
                payload = {"contents": [{"parts": [{"text": "hi"}]}]}
                r = await c.post(url, json=payload, headers={"Content-Type": "application/json"})
            else:
                payload = {
                    "model": plain_model or "gpt-4o-mini",
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                }
                r = await c.post(base_url + "/chat/completions", json=payload, headers=headers)
        ms = int((time.time() - t0) * 1000)
        if r.status_code == 200:
            return {"ok": True, "latencyMs": ms, "model": model}
        snippet = r.text[:200].replace("\n", " ")
        return {"ok": False, "latencyMs": ms, "status": r.status_code, "error": snippet}
    except httpx.TimeoutException:
        return {"ok": False, "error": "timeout"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def push_to_openhands(
    client: httpx.AsyncClient,
    oh_url: str,
    provider: Dict[str, Any],
    params: Optional[Dict[str, Any]] = None,
) -> bool:
    """Push the chosen LLM + params into OpenHands global settings.
    Returns True on 2xx response."""
    base_url = provider.get("baseUrl") or "https://open.bigmodel.cn/api/paas/v4"
    raw_model = provider.get("model") or "glm-4.5-flash"
    api_key = provider.get("apiKey") or os.environ.get("BIGMODEL_API_KEY", "")
    payload: Dict[str, Any] = {
        "agent": "CodeActAgent",
        "llm_model": qualify_model(base_url, raw_model),
        "llm_api_key": api_key,
        "llm_base_url": base_url,
        "max_iterations": int((params or {}).get("maxSteps") or 50),
        "confirmation_mode": False,
        "enable_default_condenser": True,
    }
    # temperature is supported via LLM kwargs; OpenHands /settings accepts
    # `llm_*` passthrough fields.
    if params and params.get("temperature") is not None:
        payload["llm_temperature"] = float(params["temperature"])
    if params and params.get("systemPrompt"):
        payload["custom_secrets_description"] = params["systemPrompt"][:500]
    try:
        r = await client.post(f"{oh_url}/api/settings", json=payload, timeout=10.0)
        return r.status_code < 400
    except Exception as e:
        log.warning("push_to_openhands failed: %s", e)
        return False
