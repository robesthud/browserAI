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
import uuid as _uuid  # noqa: E402


def _has_runtime():
    globs = globals()
    for n in ("app", "session_pages", "page_locks", "download_media_via_buttons"):
        if n not in globs:
            return False, f"missing {n}"
    return True, ""


_BA_RUNTIME_OK, _BA_RUNTIME_ERR = _has_runtime()
if _BA_RUNTIME_OK:

    async def _ba_wait_for_attach_button(page, timeout_ms: int = 15000) -> bool:
        """
        After opening a NEW Gemini chat, the upload UI takes 1-3 s to render.
        If we try to set_input_files before it's there, attach_images_to_gemini
        silently falls back to drag-drop (which Gemini ignores), so the user
        ends up with a chat that has only the text and no image — and Gemini
        replies 'please upload a photo'.

        This helper waits until either the file <input> or the visible upload
        button is present and not disabled. Returns True on success.
        """
        try:
            await page.wait_for_function(
                """() => {
                  const inp = document.querySelector('input[type=\"file\"]');
                  if (inp) return true;
                  const sels = [
                    'button[aria-label=\"Загрузка и инструменты\"]',
                    'button[aria-label=\"Upload and tools\"]',
                    'button[aria-label*=\"Upload\" i]',
                    'button[aria-label*=\"Attach\" i]',
                    'button[aria-label*=\"Загруз\" i]',
                    'button[aria-label*=\"Прикреп\" i]',
                    '[data-test-id*=\"upload\" i]',
                    'button[xapfileselectortrigger]',
                  ];
                  for (const s of sels) {
                    const el = document.querySelector(s);
                    if (!el) continue;
                    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
                    if (disabled) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width > 6 && r.height > 6) return true;
                  }
                  return false;
                }""",
                timeout=timeout_ms,
            )
            # Extra half-second so the click handler is wired up.
            await asyncio.sleep(0.5)
            return True
        except Exception:
            return False

    @app.post("/v1/sessions/new")  # noqa: F821
    async def ba_new_session():
        """
        Open a brand-new Gemini chat tab and return its session id, ready to
        accept the first /v1/sessions/{sid}/send call.

        This endpoint:
          1. allocates a stable session id BEFORE any chat work,
          2. uses the upstream get_or_create_session_page() to open the page
             and click "new chat",
          3. blocks until the upload control is actually in the DOM, so the
             follow-up /send call's attach_images can find it.
        """
        try:
            get_page = globals().get("get_or_create_session_page")
            if not get_page:
                raise HTTPException(503, "get_or_create_session_page not available")
            sid = f"ba-{_uuid.uuid4().hex[:8]}"
            page = await get_page(sid, start_new_chat=True)
            ok = await _ba_wait_for_attach_button(page, timeout_ms=15000)
            return JSONResponse({
                "session_id": sid,
                "ready": True,
                "attach_button_present": bool(ok),
            })
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(500, f"new-session failed: {e}")

    @app.post("/v1/sessions/{session_id}/send")  # noqa: F821
    async def ba_send_in_session(session_id: str, payload: dict):
        """
        Send a single prompt (+ optional base64 images) into the given
        pre-allocated session, and return the first assistant reply text.
        Bypasses /v1/chat/completions' session-id derivation entirely, so
        the call is guaranteed to land in the headless tab we just created
        via /v1/sessions/new — not in some other user's "default" chat.

        Body:
          { "prompt": "Оживи фото ...",
            "images": [ "data:image/png;base64,...." ]   # optional
          }
        Returns:
          { "session_id": "...", "reply": "...", "image_count": N }
        """
        if session_id not in session_pages:  # noqa: F821
            raise HTTPException(404, f"session {session_id} not found")
        page = session_pages[session_id]  # noqa: F821
        lock = page_locks.get(session_id) or asyncio.Lock()  # noqa: F821
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(400, "prompt is required")
        images = payload.get("images") or []
        # Materialise data: URLs to temp files for set_input_files.
        data_url_to_temp_file = globals().get("data_url_to_temp_file")
        if not data_url_to_temp_file:
            raise HTTPException(503, "data_url_to_temp_file not available")
        image_paths = []
        for u in images:
            try:
                if not u or not str(u).startswith("data:image/"):
                    continue
                fp = data_url_to_temp_file(u)
                if fp:
                    image_paths.append(fp)
            except Exception:
                continue

        # Make sure the attach UI is actually there (defensive — /sessions/new
        # already waited, but the user could have triggered /send minutes
        # later, after the page re-rendered).
        await _ba_wait_for_attach_button(page, timeout_ms=8000)

        send_fn = globals().get("send_to_gemini")
        if not send_fn:
            raise HTTPException(503, "send_to_gemini not available")
        async with lock:
            try:
                reply = await send_fn(page, prompt, None, image_paths=image_paths or None)
            except Exception as e:
                raise HTTPException(500, f"send failed: {e}")
        return JSONResponse({
            "session_id": session_id,
            "reply": reply,
            "image_count": len(image_paths),
        })

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

                  // Strategy: Gemini's Veo player isn't always inside the
                  // model-response-message-content div — sometimes it lives
                  // in a sibling 'video-player' / 'aiplatform-video' /
                  // 'sources' wrapper rendered later. So we search the
                  // WHOLE document for <video>/<source> and trust whatever
                  // we find AFTER the last assistant reply boundary.
                  // We also still scan the reply div first (for inline
                  // images and any in-bubble video).
                  function* collectVideos(root) {
                    for (const v of root.querySelectorAll('video, video source')) {
                      const src = v.getAttribute('src') || v.currentSrc || v.src || '';
                      if (src) yield { src, node: v };
                    }
                  }

                  const videos = [];
                  const seen = new Set();
                  for (const root of [last, document]) {
                    for (const { src } of collectVideos(root)) {
                      if (seen.has(src)) continue;
                      seen.add(src);
                      const du = await srcToVideoDataUrl(src);
                      if (du && du.startsWith('data:video/')) videos.push({ src, dataUrl: du });
                    }
                  }
                  // Also: <a href="...generated_video_content..."> and Veo's
                  // <download-button> + <a download="..."> links that point
                  // to the finished mp4 (visible in Gemini's player overlay).
                  for (const a of document.querySelectorAll('a[href*="generated_video_content"], a[href*="/video"], a[download][href]')) {
                    const src = a.getAttribute('href') || '';
                    if (!src || seen.has(src)) continue;
                    seen.add(src);
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
                  for (const a of document.querySelectorAll('a[href]')) {
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

    @app.get("/v1/sessions/{session_id}/debug-dom")  # noqa: F821
    async def ba_debug_dom(session_id: str):
        """
        Dump a snapshot of the current Gemini page DOM relevant to media
        extraction. Helps figure out where Veo's <video>/<source>/<a> ended
        up when poll-media returns 0 videos but the user clearly sees a
        finished video on screen.
        """
        if session_id not in session_pages:  # noqa: F821
            raise HTTPException(404, f"session {session_id} not found")
        page = session_pages[session_id]  # noqa: F821
        try:
            info = await page.evaluate(
                '''() => {
                  function dump(el) {
                    const r = el.getBoundingClientRect();
                    const a = el.attributes || [];
                    const attrs = {};
                    for (const x of a) attrs[x.name] = (x.value || '').slice(0, 200);
                    return {
                      tag: el.tagName,
                      visible: !!(r.width && r.height),
                      rect: { w: Math.round(r.width), h: Math.round(r.height) },
                      class: String(el.className || '').slice(0, 200),
                      id: el.id || '',
                      attrs,
                      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
                    };
                  }
                  const videos = [...document.querySelectorAll('video, source')].map(dump);
                  const dlAnchors = [...document.querySelectorAll('a[download], a[href*="video"], a[href*="googleusercontent"], a[href*="generated_video"]')].slice(0, 30).map(dump);
                  const dlButtons = [...document.querySelectorAll('button[aria-label*="скачать" i], button[aria-label*="download" i], [data-test-id*="download" i]')].slice(0, 30).map(dump);
                  const wrappers = [
                    'video-player', 'video-player-wrapper', 'aiplatform-video',
                    'video-attachment', 'media-attachment', 'gemini-video-player',
                    '[class*="video" i]'
                  ];
                  const wrSnapshot = [];
                  for (const sel of wrappers) {
                    for (const el of document.querySelectorAll(sel)) {
                      wrSnapshot.push({ selector: sel, ...dump(el) });
                      if (wrSnapshot.length > 30) break;
                    }
                    if (wrSnapshot.length > 30) break;
                  }
                  const lastReply = [...document.querySelectorAll('div[id^="model-response-message-content"]')].pop();
                  const lastReplyHtml = lastReply ? lastReply.outerHTML.slice(0, 4000) : '';
                  return {
                    url: location.href,
                    title: document.title,
                    videos, dlAnchors, dlButtons, wrappers: wrSnapshot,
                    lastReplyHtml,
                  };
                }'''
            )
        except Exception as e:
            raise HTTPException(500, f"debug-dom failed: {e}")
        return JSONResponse(info)

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

    @app.post("/v1/sessions/{session_id}/delete-chat")  # noqa: F821
    async def ba_delete_chat(session_id: str):
        """
        Trash the underlying Gemini chat shown on gemini.google.com so the
        user's left sidebar doesn't fill up with "BrowserAI Veo job …"
        entries after every video generation. Best-effort: returns
        {deleted: true|false} and never throws on UI mismatch (Gemini A/B
        tests these menus frequently).
        """
        if session_id not in session_pages:  # noqa: F821
            raise HTTPException(404, f"session {session_id} not found")
        page = session_pages[session_id]  # noqa: F821
        lock = page_locks.get(session_id) or asyncio.Lock()  # noqa: F821
        deleted = False
        async with lock:
            try:
                # Open the kebab menu of the CURRENT conversation in the
                # sidebar and pick "Delete". Conversation context menus live
                # under a Material overlay, so we trigger them via JS.
                deleted = await page.evaluate(
                    '''async () => {
                      function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
                      // 1. Find the currently-selected sidebar item.
                      let item = document.querySelector('[data-test-id="conversation"][aria-current="page"]')
                                || document.querySelector('div.conversation.selected')
                                || document.querySelector('[role="treeitem"][aria-selected="true"]');
                      // 2. Hover so the trailing kebab button reveals itself.
                      if (item) {
                        item.dispatchEvent(new MouseEvent('mouseover', {bubbles:true}));
                        item.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
                        await sleep(150);
                      }
                      // 3. Click "More options" / "Дополнительные действия".
                      const moreBtn = (item && (item.querySelector('button[aria-label*="More" i]')
                                                || item.querySelector('button[aria-label*="Дополн" i]')
                                                || item.querySelector('button[mat-icon-button]')))
                                    || document.querySelector('[data-test-id="actions-menu-button"]');
                      if (!moreBtn) return false;
                      moreBtn.click();
                      await sleep(300);
                      // 4. Click the "Delete" menu item by visible label.
                      const labels = ['Удалить', 'Delete'];
                      const items = [...document.querySelectorAll('[role="menuitem"], button')];
                      const del = items.find(b => labels.some(l => (b.textContent || '').trim().startsWith(l)));
                      if (!del) return false;
                      del.click();
                      await sleep(400);
                      // 5. Confirm in the modal.
                      const confirmBtn = [...document.querySelectorAll('button')].find(b => {
                        const t = (b.textContent || '').trim();
                        return t === 'Удалить' || t === 'Delete' || t.startsWith('Yes') || t.startsWith('Да');
                      });
                      if (confirmBtn) {
                        confirmBtn.click();
                        await sleep(400);
                      }
                      return true;
                    }'''
                )
            except Exception:
                deleted = False
            # Free the headless tab regardless.
            try:
                await page.close()
            except Exception:
                pass
            session_pages.pop(session_id, None)  # noqa: F821
            page_locks.pop(session_id, None)  # noqa: F821
        return JSONResponse({"session_id": session_id, "deleted": bool(deleted)})

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
