from __future__ import annotations

import asyncio
import base64
import os
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx


def _now() -> int:
    return int(time.time() * 1000)


def _save_generated_image(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)


async def web_search(query: str, limit: int = 8) -> List[Dict[str, Any]]:
    q = (query or '').strip()
    if not q:
        return []
    # Brave Search API if available
    brave_key = os.environ.get('BRAVE_API_KEY', '').strip()
    if brave_key:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                'https://api.search.brave.com/res/v1/web/search',
                params={'q': q, 'count': max(1, min(limit, 20))},
                headers={'Accept': 'application/json', 'X-Subscription-Token': brave_key},
                timeout=20.0,
            )
            r.raise_for_status()
            body = r.json() or {}
            out = []
            for item in ((body.get('web') or {}).get('results') or []):
                out.append({
                    'title': item.get('title') or item.get('url') or '',
                    'url': item.get('url') or '',
                    'snippet': item.get('description') or '',
                    'source': 'brave',
                })
            return out
    # Fallback: DuckDuckGo instant answer lite
    async with httpx.AsyncClient() as client:
        r = await client.get(
            'https://api.duckduckgo.com/',
            params={'q': q, 'format': 'json', 'no_html': '1', 'skip_disambig': '1'},
            timeout=20.0,
        )
        r.raise_for_status()
        body = r.json() or {}
        out: List[Dict[str, Any]] = []
        abs_url = body.get('AbstractURL') or ''
        abs_text = body.get('AbstractText') or ''
        heading = body.get('Heading') or q
        if abs_url or abs_text:
            out.append({'title': heading, 'url': abs_url, 'snippet': abs_text, 'source': 'duckduckgo'})
        for item in body.get('RelatedTopics') or []:
            if isinstance(item, dict) and item.get('FirstURL'):
                out.append({
                    'title': item.get('Text') or item.get('FirstURL'),
                    'url': item.get('FirstURL'),
                    'snippet': item.get('Text') or '',
                    'source': 'duckduckgo',
                })
        return out[: max(1, min(limit, 20))]


def _detect_image_endpoint(base_url: str) -> Optional[str]:
    """Return the images/generations URL for a known OpenAI-compatible base."""
    bu = (base_url or '').rstrip('/')
    if not bu:
        return None
    # Zhipu/GLM (CogView), z.ai, DeepSeek, OpenAI, OpenRouter all expose
    # POST {base}/images/generations (OpenAI-compatible).
    return bu + '/images/generations'


def _pick_image_model(base_url: str, requested: str = '') -> str:
    if requested:
        return requested
    bu = (base_url or '').lower()
    if 'bigmodel.cn' in bu or 'z.ai' in bu:
        return 'cogview-3'
    if 'openai.com' in bu:
        return 'dall-e-3'
    if 'openrouter' in bu:
        return 'openai/dall-e-3'
    return 'cogview-3'


async def generate_image(
    prompt: str,
    size: str = '1024x1024',
    workspace_dir: str = '/workspace/.downloads',
    provider: Optional[Dict[str, Any]] = None,
    model: str = '',
) -> Dict[str, Any]:
    """Generate a real image via an OpenAI-compatible images API.

    `provider` = {baseUrl, apiKey, ...} (resolved active key). If no usable
    provider/key is available, returns a clear error result instead of a fake
    image, so the UI can show an actionable message.
    """
    prompt = (prompt or '').strip()
    if not prompt:
        raise ValueError('prompt required')
    await asyncio.to_thread(os.makedirs, workspace_dir, exist_ok=True)

    base_url = (provider or {}).get('baseUrl') or ''
    api_key = (provider or {}).get('apiKey') or ''
    endpoint = _detect_image_endpoint(base_url)

    if not endpoint or not api_key:
        return {
            'ok': False,
            'error': 'no_image_provider',
            'message': 'Генерация изображений недоступна: не настроен API-ключ с поддержкой images API. Откройте Настройки и активируйте ключ (например GLM/Zhipu с cogview-3).',
            'prompt': prompt,
            'provider': 'none',
            'createdAt': _now(),
        }

    use_model = _pick_image_model(base_url, model)
    payload = {'model': use_model, 'prompt': prompt, 'size': size, 'n': 1}
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'}

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(endpoint, json=payload, headers=headers)
            if r.status_code >= 400:
                return {
                    'ok': False,
                    'error': f'provider_{r.status_code}',
                    'message': f'Провайдер вернул ошибку {r.status_code}: {r.text[:200]}',
                    'prompt': prompt, 'provider': use_model, 'createdAt': _now(),
                }
            body = r.json() or {}
            data = (body.get('data') or [{}])[0]
            img_url = data.get('url') or ''
            b64 = data.get('b64_json') or ''

            file_id = uuid.uuid4().hex[:12]
            saved_path = ''
            if b64:
                saved_path = os.path.join(workspace_dir, f'generated-{file_id}.png')
                await asyncio.to_thread(_save_generated_image, saved_path, base64.b64decode(b64))
            elif img_url:
                # download to workspace
                try:
                    async with httpx.AsyncClient(timeout=120.0) as dl:
                        ir = await dl.get(img_url)
                        if ir.status_code < 400:
                            saved_path = os.path.join(workspace_dir, f'generated-{file_id}.png')
                            await asyncio.to_thread(_save_generated_image, saved_path, ir.content)
                except Exception:
                    saved_path = ''

            return {
                'ok': True,
                'id': file_id,
                'prompt': prompt,
                'size': size,
                'model': use_model,
                'url': img_url or (saved_path or ''),
                'path': saved_path or None,
                'createdAt': _now(),
                'provider': use_model,
            }
    except httpx.TimeoutException:
        return {'ok': False, 'error': 'timeout', 'message': 'Таймаут генерации изображения.', 'prompt': prompt, 'createdAt': _now()}
    except Exception as e:
        return {'ok': False, 'error': 'exception', 'message': str(e)[:200], 'prompt': prompt, 'createdAt': _now()}
