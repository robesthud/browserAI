# BrowserAI Rollback Plan

**Created:** 2026-06-28  
**Scope:** Hybrid merge Phase 0–1.2 stabilization

## Preconditions

Before each production deploy:

1. Ensure the current production commit is known:
   ```bash
   cd /opt/browserai
   git rev-parse --short HEAD
   ```
2. Ensure Docker image/container are healthy:
   ```bash
   docker compose ps
   curl -fsS http://127.0.0.1:8080/api/health
   ```
3. Keep `/opt/browserai/.env` and `/opt/browserai-data` untouched by code deploys.

## One-command rollback

Replace `<GOOD_COMMIT_OR_TAG>` with the last healthy commit/tag:

```bash
cd /opt/browserai
git fetch origin
git reset --hard <GOOD_COMMIT_OR_TAG>
docker compose up -d --build browserai
curl -fsS http://127.0.0.1:8080/api/health
```

## Database rollback notes

Phase 0–1.2 changes are backward-compatible:

- SQLite WAL/busy_timeout are PRAGMA-level settings.
- `/api/chats/list` and `/api/chats/{id}/messages` are additive endpoints.
- BrowserAI cloud chat persistence remains non-canonical; OpenHands remains source of truth.

If a DB restore is required, use the latest Timeweb backup under `/root/browserai.db.bak-*` or the configured backup location, then restart:

```bash
docker compose stop browserai
cp <backup.db> /opt/browserai-data/browserai.db
docker compose up -d browserai
```

## Verification after rollback

```bash
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/chats/list
```

Then open the public UI and perform a hard refresh.
