# BrowserAI project context for future AI agents

Last updated: 2026-06-02.

## Current production URLs

- GitHub repo: `https://github.com/robesthud/browserAI`
- Railway web/backend: `https://browserai-production.up.railway.app/`
- Android package/applicationId: `ai.browser.app`
- Android project folder: `android-app/`

## Deployment model

BrowserAI is a full-stack app:

- React/Vite/Tailwind frontend is built to `dist/`.
- Express server in `server/index.js` serves both `/api/*` and static `dist/`.
- Railway should run it as a Web Service with Nixpacks:
  - install: `npm ci`
  - build: `npm run build`
  - start: `npm start`
- Persistent Railway volume should be mounted to `/data`:
  - DB: `/data/browserai.db`
  - workspace: `/data/workspace`

## Auth/cloud-sync status

Auth is implemented with SQLite tables in `server/index.js`:

- `users`
- `sessions`
- `password_reset_tokens`
- `user_cloud_data`

Frontend auth gate: `src/components/AuthGate.jsx`.

Important behavior:

- First registered user becomes `owner`.
- After the first user exists, registration is closed unless request includes `registrationSecret` equal to Railway env `REGISTRATION_SECRET`.
- Sessions use HttpOnly cookie `browserai_session`.
- `user_cloud_data.payload` is encrypted with AES-256-GCM using `AUTH_SECRET`.
- Synced data currently includes settings/API keys and chats, not full Workspace files.
- `useSettings` skips legacy global `/api/settings` DB sync when `localStorage['browserai.auth.enabled'] === '1'`; cloud data is saved through `/api/cloud` from `CloudSync` in `App.jsx`.
- Password reset is real but requires SMTP env vars. Without SMTP it returns a configuration error.

Required Railway variables for production auth:

```text
AUTH_SECRET=<long random secret>
APP_URL=https://browserai-production.up.railway.app
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

2. Railway static asset CORS:
   - Do not hard-code `http://localhost:5173` for production.
   - Current code uses wildcard CORS unless `CORS_ORIGIN` is set.

3. Android/WebView blank screen:
   - Vite legacy plugin is installed and configured in `vite.config.js`.
   - Railway HTML should include both modern assets and legacy `nomodule` assets.
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
2. Wait for Railway to deploy the new commit.
3. Verify production HTML:

```bash
curl -fsS https://browserai-production.up.railway.app/ | grep -E 'legacy|nomodule|assets/'
curl -sS -D - https://browserai-production.up.railway.app/ -o /dev/null | grep -i content-security-policy
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

- The app is a WebView wrapper around the Railway web app. Backend still runs on Railway.
- Web UI updates over the air after Railway redeploy; APK updates are needed only when `android-app/` native wrapper code changes.
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
