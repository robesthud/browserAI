# BrowserAI touch + secret follow-up — 2026-06-20

## Deployed head
- `1394fb1` — `fix(ui): keep native mobile touch scroll responsive`

## What changed in this follow-up
### Mobile touch
- disabled edge-swipe navigation listeners on coarse/mobile devices
- kept native vertical touch scroll as the top priority
- reduced aggressive mobile viewport locking/fixed-position behavior
- mobile scroll containers explicitly keep `touch-action: pan-y`

### Secret exposure hardening
- stored provider keys are no longer returned to the client in plain form from `/api/settings`
- client now receives safe DTO fields such as:
  - `hasSecret`
  - `maskedApiKey`
  - `useStoredSecret`
- chat and agent runtime can now use saved server-side secrets via:
  - `keyId`
  - `useStoredSecret`
- owner UI can still validate and use saved providers without needing the full secret sent back to the browser each time

### Log hygiene
- Gemini debug URL logging now redacts the `?key=` query secret

## Current alignment
- GitHub main: `1394fb1`
- Timeweb `/opt/browserai`: `1394fb1`
- local canonical repo `/home/user/browserai_fresh`: `1394fb1`

## Health
`/api/health`:
```json
{"deepseekManaged":true,"sandbox":"ok","browser":{"ok":true,"sessions":0}}
```
