# BrowserAI project context for future AI agents

Last updated: 2026-06-07.

## TL;DR what BrowserAI does now

A self-hosted chat UI for any OpenAI-compatible LLM (plus a special
managed adapter for `chat.deepseek.com`). It bundles:
- multi-chat history with auto-summary
- a workspace file manager
- web search context injection
- a **tool-using agent mode** (see `AGENT_GUIDE.md`)
- a mobile-first UI with edge swipes, haptics, theme toggle, font scale,
  pull-to-refresh, inline tool cards (see `MOBILE_UX_GUIDE.md`)
- an Android WebView wrapper (see `android-app/README.md`)
- a Cloudflare Workers proxy for fetching anti-bot pages
  (see `cf-proxy/README.md`)

## Doc index for AI agents

| File | Read when |
|---|---|
| `README.md` | Asked about how to install / set up / configure |
| `DEVELOPER_GUIDE.md` | Asked about authentication, chat storage, Vault, sync, workspace |
| `AGENT_GUIDE.md` | Asked about tools / agent loop / sandbox / how to add a new tool |
| `OPS_GUIDE.md` | Asked about deploy/logs/GitHub/Telegram/service connectors |
| `MOBILE_UX_GUIDE.md` | Asked about gestures, haptics, theme, mobile-only behaviour |
| `server/DEEPSEEK_SESSION.md` | Asked about the managed DeepSeek session / Telegram bot / refresher |
| `android-app/README.md` | Asked about APK build / Android wrapper |
| `cf-proxy/README.md` | Asked about the Cloudflare Worker |
| `WEB_AI_EVOLUTION_PLAN.md` | Historical roadmap, not authoritative for current state |

## Managed DeepSeek session

Native `chat.deepseek.com` session manager:

- Stores `userToken` (Bearer JWT) + cookies in `/data/deepseek_session.json`
  (volume-mounted, survives restarts).
- Pings `GET https://chat.deepseek.com/api/v0/users/current` every 10
  minutes. The response is used as a heartbeat; any `Set-Cookie` rotated
  by DeepSeek is merged back into the persisted state.
- Refreshes the cached model list every hour (falls back to the
  hard-coded pair `deepseek_chat` / `deepseek_reasoner` if discovery
  fails).
- Notifies Telegram (`TG_BOT_TOKEN` + `TG_ADMIN_CHAT_ID`) on session
  updates, rotations, and 401/403 failures.
- Auto-injects the managed bearer + cookies into `/api/chat` and
  `/api/validate` when the client sends `apiKey: '__managed__'` (or
  omits it entirely) for a `chat.deepseek.com` URL — so users select the
  preset **«✨ DeepSeek (managed)»** and never see a token.

### Files

| File | Purpose |
|------|---------|
| `server/deepseekTokenRefresher.js` | Session state + heartbeat + models cache |
| `server/deepseekBot.js`            | Telegram control surface (long polling) |
| `server/deepseekWeb.js`            | Lower-level DeepSeek HTTP client + WASM POW |
| `src/components/DeepSeekAdmin.jsx` | `/admin/deepseek` dashboard |
| `server/DEEPSEEK_SESSION.md`       | Full operator guide (env, endpoints, bot) |

### Public API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET    | `/api/deepseek/managed`            | none | Probe availability for the UI |
| GET    | `/api/admin/deepseek/status`       | required | Session state (no secrets) |
| POST   | `/api/admin/deepseek/refresh`      | required | Force heartbeat + models refresh |
| POST   | `/api/admin/deepseek/token`        | required | Set `userToken` and/or cookies |
| GET    | `/api/admin/deepseek/models`       | required | Cached model list |

### Telegram commands (admin chat only)

`/status` · `/refresh` · `/settoken <jwt>` · `/setcookie <name=val;…>` ·
`/models` · `/help`. Messages containing the raw token are deleted by the
bot after saving.

### Env vars

```text
DEEPSEEK_USER_TOKEN     # optional bootstrap Bearer (otherwise UI/bot supplies it)
DEEPSEEK_COOKIES        # optional bootstrap cookies "name=value; name2=value2"
DEEPSEEK_HEARTBEAT_MS   # default 600000 (10 min)
DEEPSEEK_MODELS_REFRESH_MS  # default 3600000 (1 h)
DEEPSEEK_BOT            # "off" disables the Telegram bot
TG_BOT_TOKEN            # bot token from @BotFather
TG_ADMIN_CHAT_ID        # numeric chat_id allowed to issue commands
```

## Current production URLs

- GitHub repo: `https://github.com/robesthud/browserAI`
- Primary deployment: Timeweb Cloud VPS `browserai`
  (Ubuntu 22.04 + Docker, single-node), reachable via the `APP_URL` env.
- Android package/applicationId: `ai.browser.app`
- Android project folder: `android-app/`

## Deployment model

BrowserAI is a full-stack app:

- React/Vite/Tailwind frontend is built to `dist/`.
- Express server in `server/index.js` serves both `/api/*` and static `dist/`.

The canonical deployment is via Docker:

- `Dockerfile` — multi-stage `node:22-alpine` build that runs `vite build`,
  prunes devDeps, and includes `python3/make/g++` so `better-sqlite3` can
  compile its native binding.
- `docker-compose.yml` — exposes port 8080 inside the container (mapped to
  host 80 by default) and mounts two named volumes:
  - `browserai_data` → `/data` (sqlite db, `deepseek_session.json`, sessions)
  - `browserai_workspace` → `/workspace` (user files)
- `.env.example` documents all environment variables; copy to `.env`
  next to `docker-compose.yml` on the deploy host.

The same `Dockerfile` works on any Docker host as-is; just
point the platform at the repo and mount a persistent volume at `/data`.

## Auth/cloud-sync status

Auth is implemented with SQLite tables in `server/index.js`:

- `users`
- `sessions`
- `password_reset_tokens`
- `user_cloud_data`

Frontend auth gate: `src/components/AuthGate.jsx`.

Important behavior:

- First registered user becomes `owner`.
- After the first user exists, registration is closed unless request includes `registrationSecret` equal to env `REGISTRATION_SECRET`.
- Sessions use HttpOnly cookie `browserai_session`.
- `user_cloud_data.payload` is encrypted with AES-256-GCM using `AUTH_SECRET`.
- Synced data currently includes settings/API keys and chats, not full Workspace files.
- `useSettings` skips legacy global `/api/settings` DB sync when `localStorage['browserai.auth.enabled'] === '1'`; cloud data is saved through `/api/cloud` from `CloudSync` in `App.jsx`.
- Password reset is real but requires SMTP env vars. Without SMTP it returns a configuration error.

Required environment variables for production auth:

```text
AUTH_SECRET=<long random secret>
APP_URL=https://your.domain.example
```

Optional for more registrations/password reset:

```text
REGISTRATION_SECRET=<secret for adding more users>
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=BrowserAI <noreply@example.com>
```

## Important fixes already made

1. Express 5 wildcard SPA route:
   - Do not use `app.get('*')`; Express 5/path-to-regexp crashes.
   - Current code uses regex route for non-API paths.

2. Static asset CORS:
   - Do not hard-code `http://localhost:5173` for production.
   - Current code uses wildcard CORS unless `CORS_ORIGIN` is set.

3. Android/WebView blank screen:
   - Vite legacy plugin is installed and configured in `vite.config.js`.
   - Production HTML should include both modern assets and legacy `nomodule` assets.
   - Helmet CSP must allow Vite legacy inline loader scripts:
     - `script-src 'self' 'unsafe-inline'`
   - Without this, older Android System WebView may show only a grey screen.

4. Startup without an API key:
   - `normalizeKey(null)` used to crash with `Cannot read properties of null (reading 'availableModels')`.
   - Fixed in `src/lib/settings.js` by normalizing `key = key || {}`.

5. Android layout:
   - The Android WebView must not force desktop viewport.
   - `MainActivity.java` uses `setUseWideViewPort(false)` and `setLoadWithOverviewMode(false)`.
   - React UI has mobile fixes: sidebar starts collapsed on `<768px`, opens as drawer, and topbar/model picker is compressed/hidden on small screens.
   - Mobile topbar has extra top padding (`pt-10`) and the hamburger button uses `top-10` to avoid Android status-bar overlap in WebView screenshots.
   - Workspace opens as a full-screen fixed overlay on mobile (`w-screen`, `fixed inset-0`, top padding), but remains a 300px side panel on desktop (`md:w-[300px]`).

## Android build and release

Two GitHub Actions workflows exist:

- `.github/workflows/build-android-apk.yml`
  - manual/test APK build
  - uploads artifact `BrowserAI-debug-apk`

- `.github/workflows/release-android-apk.yml`
  - manual release APK build
  - creates GitHub Release tagged `android-v<run_number>`
  - uploads `BrowserAI-<run_number>.apk`

The Android app checks GitHub Releases on startup:

- API: `https://api.github.com/repos/robesthud/browserAI/releases/latest`
- It expects tags like `android-v123`.
- If latest release number is greater than installed `versionCode`, it prompts the user to download the APK.

## When changing web code

1. Commit and push to `main`.
2. Push to `main`; deploy via GitHub Actions `deploy-timeweb.yml` (or run docker compose on the VPS).
3. Verify production HTML:

```bash
curl -fsS http://72.56.116.15/ | grep -E 'legacy|nomodule|assets/'
curl -sS -D - http://72.56.116.15/ -o /dev/null | grep -i content-security-policy
```

Expected:

- HTML contains `polyfills-legacy...js` and `index-legacy...js`.
- CSP contains `script-src 'self' 'unsafe-inline'`.

## When changing Android native wrapper

1. Commit and push to `main`.
2. Run GitHub Action `Release Android APK`.
3. Install the generated APK from GitHub Releases.
4. If testing on the same phone, uninstall old app or clear app data/cache first.

## Known Android/UI caveats

- The app is a WebView wrapper around the production web app. Backend runs on the Timeweb VPS.
- Web UI updates over the air after server redeploy; APK updates are needed only when `android-app/` native wrapper code changes.
- Android cannot silently install APK updates outside Google Play. Current native updater checks GitHub Releases, downloads the APK inside the app, then opens the Android package installer. User still must approve installation.
- Direct in-app APK update requires the new APK to be signed with the same key as the installed APK. Workflows now create/cache `android-app/app/debug.keystore` with key `browserai-android-debug-keystore-v1`. After this change the user should install one APK manually from `Release Android APK`; future releases can be updated from the in-app dialog.

## Recent debugging notes

The user reported:

- grey screen in Chrome and Android app;
- then an error screen in Android app: "Интерфейс не запустился";
- then, after startup fix, UI loaded but desktop layout was squeezed on phone: sidebar took most of the screen and composer was too narrow.

Fixes applied for that sequence:

- Vite legacy build + CSP inline scripts allowed.
- `normalizeKey(null)` crash fixed.
- Mobile layout fixes in `App.jsx`, `Sidebar.jsx`, `Topbar.jsx`, `Composer.jsx`.
- Android WebView viewport fixed in `MainActivity.java`.

## Agent mode

Universal LLM agent (`server/agentLoop.js`) — works with any
OpenAI-compatible provider plus the managed DeepSeek transport. Streams
SSE events to the client (`thinking`, `tool_start`, `tool_result`,
`thought`, `assistant`, `done`, `error`). Tools live in
`server/agentTools.js`; bash runs in the `agent-sandbox` docker service
via `docker exec`. Full architecture / event grammar / "how to add a
new tool" — see `AGENT_GUIDE.md`.

Wire-up summary:
- Front: toggle 🤖 Агент in Sidebar -> `useChats.sendAgentMessage`
  -> `lib/agentStream.streamAgent(provider, history)` -> SSE.
- Back: `POST /api/agent/chat` (requireAuth) -> `runAgent({provider,
  history, res})` -> `callLLM(provider, messages)` per step.
- Persistence: tool calls + thoughts live on the assistant message
  itself (`m.toolCalls[]`, `m.thoughts[]`), which `lib/storage.js`
  saves with `trimChatsForStorage()` (clips read_file/bash/web_fetch
  payloads to 4 KB so localStorage doesn't overflow).

## Mobile UX

Every gesture / hook is gated to `< md` (768 px). Desktop layout is
intentionally untouched.

Hooks (`src/lib/`):
- `usePullToRefresh` — drag-from-top on the chat scroll
- `useEdgeSwipe` — left-edge swipe opens the Sidebar
- `useSwipeActions` — swipe-left on a message reveals copy/regen/edit
- `haptics` — `tap`/`success`/`error` patterns, toggleable
- `syntaxHighlight` — 150-line tokenizer used in `AgentToolBlock`

Components:
- `MobileHeaderModelPicker` — compact ✱ model name ▾ in the top bar
- `AgentToolBlock` — Arena-style single-row tool card with duration
- `SidebarUserPrefs` — theme / font / haptics toggles in Sidebar bottom
- `ErrorBoundary` — wraps `<App />` in `src/main.jsx`, beacons crashes
  to `/api/debug/client-error`

For visual catalogue + which hook owns what — see `MOBILE_UX_GUIDE.md`.

## Important fixes after the agent-mode rollout

- `useChats` was missing `updateChat` in the destructure in `App.jsx`,
  which crashed the Regenerate button. Fixed by adding it back.
- DeepSeek's new minified stream `{p,o,v}` format was misread by
  `extractDeltaText`, returning `''` for every content chunk and
  spuriously emitting `Greeting response` from the trailing `event:
  title` frame. Parser rewritten to recognise `v` as the primary
  delta carrier and to ignore non-`response/content` paths.
- `runSandboxCommand` failed with `spawn docker ENOENT` because the
  runtime image lacked `docker-cli`. Added to `Dockerfile`.
- `heartbeat()` in `deepseekTokenRefresher.js` saved to disk only when
  Set-Cookie rotated, so `alive: true` was lost across restarts.
  Now persists after every successful heartbeat.
- `refreshNow()` unconditionally saved, including on the
  `no-credentials` early return — a `docker compose exec` could wipe
  the live session. Now skips persistence on that path.

## Build / deploy / smoke-test cheatsheet

```bash
# Local dev
npm i
npm run dev:all                   # vite + node server with concurrent reload

# Production build
npm run build                     # outputs dist/

# Deploy on the Timeweb VPS (managed by .github/workflows/deploy-timeweb.yml,
# or run manually):
ssh root@72.56.116.15 \
  'cd /opt/browserai && git pull && docker compose up -d --build'

# Quick smoke tests
curl -s http://72.56.116.15/api/health
curl -s http://72.56.116.15/api/deepseek/managed | jq
# Sandbox liveness (requires auth cookie):
curl -s -H "Cookie: browserai_session=…" http://72.56.116.15/api/agent/health | jq
```


## Ops Gateway

Agent Mode has server-side service connectors documented in `OPS_GUIDE.md`. Built-ins: `browserai` (health, docker logs, deploy, repair_deploy), `github` (repo status, actions runs/logs, file get/put), and `telegram` (admin notifications). Extra REST services can be registered in `/data/ops/services.json`. Dangerous actions require confirmation via `ask_user`.
