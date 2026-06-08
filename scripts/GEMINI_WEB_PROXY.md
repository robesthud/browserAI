# Gemini Web Proxy integration

BrowserAI uses [`00bx/gemini-web-proxy`](https://github.com/00bx/gemini-web-proxy)
as a local OpenAI-compatible bridge to Gemini Web.

## What BrowserAI patches add

`gemini-web-proxy.patch` adds:

- `GEMINI_SERVICE_DIR` env support, so the browser profile can live in `/opt/browserai-data/gemini-service`.
- Playwright Chromium flags for VPS/root execution.
- Real BrowserAI-facing model ids:
  - `gemini-2.5-pro`
  - `gemini-2.5-flash`
  - `gemini-2.0-flash`
- OpenAI-compatible `image_url` input support:
  - accepts `content: [{type:'text'}, {type:'image_url'}]`
  - decodes `data:image/...` to a temp file
  - attaches it to Gemini Web via the upload/tools menu
- Generated image/video output support:
  - inline extraction: `<img>`/`<video>` and `generated_video_content` results
    are converted to `data:image|video/...` via in-page authenticated fetch
  - **original-file download**: if no inline data URL is found, the proxy clicks
    Gemini's native download control (`accept_downloads=True` +
    `page.expect_download()`) and returns the REAL generated file (full quality,
    correct format/MIME) as a data URL — not a screenshot
  - screenshot is only a last resort, and captures just the largest
    img/canvas/video element, never the surrounding Gemini UI
  - video generation is async; BrowserAI's job runner (`server/jobs.js`)
    polls the same Gemini session until the finished file appears, then saves
    it to the workspace

## Apply patch on VPS

```bash
cd /opt/browserai
scripts/apply-gemini-web-proxy-patch.sh /opt/gemini-web-proxy
systemctl restart gemini-web-proxy.service
```

## Service expectations

`gemini-web-proxy.service` should run with:

```ini
WorkingDirectory=/opt/gemini-web-proxy
Environment=GEMINI_SERVICE_DIR=/opt/browserai-data/gemini-service
ExecStart=/opt/gemini-web-proxy/.venv/bin/python run.py
Restart=always
```

The proxy should listen on the Docker bridge address, for example:

```text
http://172.17.0.1:8080
```

BrowserAI reaches it from the container via:

```text
http://host.docker.internal:8080/v1
```

## Login / relogin

When Google/Gemini session expires, temporarily start a visible Chromium via noVNC,
log in, then restart `gemini-web-proxy.service` in headless mode.
