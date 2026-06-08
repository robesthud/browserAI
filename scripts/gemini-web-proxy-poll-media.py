"""
BrowserAI add-on for 00bx/gemini-web-proxy: a non-destructive endpoint that
re-reads the LAST already-existing Gemini reply and yanks out media that has
appeared since the original /v1/chat/completions call returned.

Background
----------
Gemini's Veo video generation is asynchronous. When you ask "сгенерируй
видео ..." the first response is a placeholder ("создание видео…").
The actual <video> appears INSIDE THAT SAME response block, possibly
8-15 minutes later. Sending a new chat message ("готово?") creates a
new reply and Gemini just answers "уже работаю", never returning the
finished file.

This endpoint does NOT send a new message. It simply reattaches to the
existing session page, scrolls to the last assistant reply, and re-runs
the same extraction + native-download-button flow already used by
/v1/chat/completions. If the file is now present it is returned as a
markdown link with a data: URL (mp4/png/jpg etc.).

Wiring
------
This file is appended to server.py by
scripts/apply-gemini-web-proxy-patch.sh on `deploy`. It expects the
following globals already defined in server.py:

    app, session_pages, page_locks, download_media_via_buttons, md

If any of those is missing the import-time guard returns 503 instead of
crashing the service.
"""

# ── Injected by BrowserAI: poll-media endpoint ──────────────────────────────
from fastapi import HTTPException  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
import asyncio  # noqa: E402
import re  # noqa: E402


def _has_runtime():
    globs = globals()
    for n in ("app", "session_pages", "page_locks", "download_media_via_buttons"):
        if n not in globs:
            return False, f"missing {n}"
    return True, ""


_BA_RUNTIME_OK, _BA_RUNTIME_ERR = _has_runtime()
if _BA_RUNTIME_OK:

    async def _ba_extract_existing_media(page):
        """
        Re-extract media from the LAST assistant reply already on the page.
        Mirrors the in-page extraction block in send_to_gemini, but does not
        touch the input box and does not push a new message.
        """
        try:
            response_divs = await page.query_selector_all(
                'div[id^="model-response-message-content"]'
            )
            if not response_divs:
                return {"text": "", "images": [], "videos": [], "links": []}
            last_response = response_divs[-1]
        except Exception as e:  # pragma: no cover
            return {"error": f"DOM query failed: {e}"}

        try:
            extraction = await page.evaluate(
                '''
                async () => {
                  const last = [...document.querySelectorAll('div[id^="model-response-message-content"]')].pop();
                  if (!last) return { text: '', images: [], videos: [], links: [] };

                  async function srcToVideoDataUrl(src) {
                    if (!src) return '';
                    if (src.startsWith('data:video/')) return src;
                    try {
                      const blob = await fetch(src).then(r => r.blob());
                      return await new Promise((resolve) => {
                        const r = new FileReader();
                        r.onload = () => resolve(String(r.result || ''));
                        r.onerror = () => resolve('');
                        r.readAsDataURL(blob);
                      });
                    } catch (e) { return ''; }
                  }
                  async function srcToImageDataUrl(src) {
                    if (!src) return '';
                    if (src.startsWith('data:image/')) return src;
                    try {
                      const blob = await fetch(src).then(r => r.blob());
                      return await new Promise((resolve) => {
                        const r = new FileReader();
                        r.onload = () => resolve(String(r.result || ''));
                        r.onerror = () => resolve('');
                        r.readAsDataURL(blob);
                      });
                    } catch (e) { return ''; }
                  }

                  const videos = [];
                  for (const v of last.querySelectorAll('video, video source')) {
                    const src = v.getAttribute('src') || v.currentSrc || v.src || '';
                    if (!src) continue;
                    const du = await srcToVideoDataUrl(src);
                    if (du && du.startsWith('data:video/')) videos.push({ src, dataUrl: du });
                  }
                  for (const a of last.querySelectorAll('a[href*="generated_video_content"], a[href*="/video"]')) {
                    const src = a.getAttribute('href') || '';
                    if (!src) continue;
                    const du = await srcToVideoDataUrl(src);
                    if (du && du.startsWith('data:video/')) videos.push({ src, dataUrl: du });
                  }

                  const images = [];
                  for (const i of last.querySelectorAll('img')) {
                    const src = i.getAttribute('src') || i.currentSrc || i.src || '';
                    if (!src) continue;
                    const du = await srcToImageDataUrl(src);
                    if (du && du.startsWith('data:image/')) images.push({ src, dataUrl: du, alt: i.getAttribute('alt') || '' });
                  }

                  // Surface any remote media href so the caller can decide to
                  // trigger a fresh download-button poll on the next cycle.
                  const links = [];
                  for (const a of last.querySelectorAll('a[href]')) {
                    const h = a.getAttribute('href') || '';
                    if (/googleusercontent\\.com|generated_video_content|veo|\\.mp4($|\\?)|\\.webm($|\\?)/i.test(h)) links.push(h);
                  }

                  return { text: last.innerText || '', images, videos, links };
                }
                '''
            )
        except Exception as e:  # pragma: no cover
            return {"error": f"page.evaluate failed: {e}"}

        # Try the native download button (yields ORIGINAL file, not preview).
        try:
            downloaded = await download_media_via_buttons(page, last_response)  # noqa: F821
        except Exception:
            downloaded = []

        out = {
            "text": extraction.get("text", "") if isinstance(extraction, dict) else "",
            "images": [],
            "videos": [],
            "links": extraction.get("links", []) if isinstance(extraction, dict) else [],
            "via_download_button": [],
        }

        for v in (extraction.get("videos", []) if isinstance(extraction, dict) else []) or []:
            du = v.get("dataUrl") or ""
            if du.startswith("data:video/"):
                out["videos"].append(du)
        for i in (extraction.get("images", []) if isinstance(extraction, dict) else []) or []:
            du = i.get("dataUrl") or ""
            if du.startswith("data:image/"):
                out["images"].append(du)

        for item in downloaded or []:
            du = item.get("data_url") or ""
            mime = item.get("mime") or ""
            if not du:
                continue
            if mime.startswith("video/") and du not in out["videos"]:
                out["videos"].append(du)
                out["via_download_button"].append({"kind": "video", "mime": mime})
            elif mime.startswith("image/") and du not in out["images"]:
                out["images"].append(du)
                out["via_download_button"].append({"kind": "image", "mime": mime})
            elif du.startswith("data:"):
                # Keep audio/pdf/etc. under videos field too — callers (BrowserAI
                # job runner) only care about a "ready media" signal here.
                out["videos"].append(du)
                out["via_download_button"].append({"kind": "other", "mime": mime})

        return out

    @app.post("/v1/sessions/{session_id}/poll-media")  # noqa: F821
    async def ba_poll_media(session_id: str):
        """
        Re-read the existing chat page for `session_id` and return any media
        currently attached to the LAST assistant reply. NO new message is
        sent to Gemini. Designed for video-generation polling.
        """
        if session_id not in session_pages:  # noqa: F821
            raise HTTPException(404, f"session {session_id} not found")
        page = session_pages[session_id]  # noqa: F821
        # Lock the session so we don't race with an in-flight chat call.
        lock = page_locks.get(session_id) or asyncio.Lock()  # noqa: F821
        async with lock:
            try:
                # Make sure the live URL is still in a chat tab (poll could
                # arrive during a navigation). Wait briefly if needed.
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=2000)
                except Exception:
                    pass
                data = await _ba_extract_existing_media(page)
            except Exception as e:
                raise HTTPException(500, f"poll-media failed: {e}")
        ready = bool(data.get("videos") or data.get("images"))
        return JSONResponse({
            "session_id": session_id,
            "ready": ready,
            "videos": data.get("videos", []),
            "images": data.get("images", []),
            "remote_links": data.get("links", []),
            "via_download_button": data.get("via_download_button", []),
        })

    @app.get("/v1/sessions/{session_id}/last-reply-meta")  # noqa: F821
    async def ba_last_reply_meta(session_id: str):
        """Lightweight liveness check for a session: returns whether there
        is at least one assistant reply and a snippet of its inner text."""
        if session_id not in session_pages:  # noqa: F821
            raise HTTPException(404, f"session {session_id} not found")
        page = session_pages[session_id]  # noqa: F821
        try:
            txt = await page.evaluate(
                '''() => {
                  const last = [...document.querySelectorAll('div[id^="model-response-message-content"]')].pop();
                  return last ? (last.innerText || '').slice(0, 400) : '';
                }'''
            )
        except Exception as e:
            raise HTTPException(500, f"last-reply-meta failed: {e}")
        return {"session_id": session_id, "exists": bool(txt), "snippet": txt}

else:
    @app.get("/v1/sessions/{session_id}/poll-media")  # type: ignore[name-defined]  # noqa: F821
    async def ba_poll_media_unavailable(session_id: str):  # noqa: ARG001
        raise HTTPException(503, f"poll-media unavailable: {_BA_RUNTIME_ERR}")
