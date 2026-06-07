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
- Generated image output support:
  - converts Gemini `blob:` image results to `data:image/png;base64,...`
  - falls back to screenshotting the generated image block when necessary

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
