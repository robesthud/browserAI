from __future__ import annotations

import base64
import os
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx


def _now() -> int:
    return int(time.time() * 1000)


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


async def generate_image(prompt: str, size: str = '1024x1024', workspace_dir: str = '/workspace/.downloads') -> Dict[str, Any]:
    prompt = (prompt or '').strip()
    if not prompt:
        raise ValueError('prompt required')
    os.makedirs(workspace_dir, exist_ok=True)
    # Placeholder image artifact if no provider key available.
    # This keeps the UI flow unblocked; real provider integration can replace it.
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <rect width="100%" height="100%" fill="#111827"/>
    <text x="50%" y="46%" text-anchor="middle" fill="#ffffff" font-size="28" font-family="Arial">BrowserAI image placeholder</text>
    <text x="50%" y="53%" text-anchor="middle" fill="#9ca3af" font-size="20" font-family="Arial">{prompt[:120].replace('&','and').replace('<','').replace('>','')}</text>
    </svg>'''
    file_id = uuid.uuid4().hex[:12]
    path = os.path.join(workspace_dir, f'generated-{file_id}.svg')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(svg)
    return {
        'id': file_id,
        'prompt': prompt,
        'size': size,
        'path': path,
        'url': path,
        'createdAt': _now(),
        'provider': 'placeholder',
    }
