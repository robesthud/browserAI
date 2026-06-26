# Timeweb deploy notes for BrowserAI

Дата: 2026-06-22

## Server

- Host: `186.246.31.78`
- SSH user: `root`
- App dir: `/opt/browserai`
- Branch: `main`
- Remote: `git@github.com:robesthud/browserAI.git`

> Секреты/пароли не хранить в репозитории. Доступ был передан отдельно пользователем.

## Проверенное состояние

На момент проверки:

- SSH подключение работает.
- `/opt/browserai` существует.
- `git status --short` чистый.
- `git ls-remote origin main` работает.
- Docker containers активны:
  - `browserai` healthy;
  - `agent-sandbox` running;
  - `browserai-db` running;
  - `computer-sandbox` healthy.

## Ручной deploy на сервере

```bash
ssh root@186.246.31.78
cd /opt/browserai
git fetch --quiet origin main
git reset --hard origin/main
docker compose up -d --build --force-recreate --remove-orphans browserai
docker image prune -f
curl -fsS http://localhost/api/health
```

## Безопасный порядок для агента

1. Локально внести изменения.
2. Запустить проверки:

```bash
npm test
npm run build
```

3. Проверить секреты перед коммитом.
4. Commit + push в `main`.
5. На Timeweb:

```bash
cd /opt/browserai
git fetch --quiet origin main
git reset --hard origin/main
docker compose up -d --build --force-recreate --remove-orphans browserai
curl -fsS http://localhost/api/health
```

6. Проверить логи при ошибке:

```bash
docker compose logs --tail=120 browserai
docker compose ps
```
