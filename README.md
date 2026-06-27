# BrowserAI

BrowserAI — русскоязычный web-чат с AI и агентным режимом. Оболочка для OpenHands.

Фронтенд: React + Vite + Tailwind  
Бэкенд: **Python 3.12 + FastAPI + Uvicorn + SQLite**  
Агент-движок: **OpenHands Agent Server** (`ghcr.io/all-hands-ai/openhands:main`)

Production-развёртывание: VPS Timeweb, Docker Compose, GitHub Actions.

---

## Что умеет

- Обычный чат с OpenAI-compatible провайдерами (OpenAI, Anthropic, Gemini, DeepSeek, z.ai / GLM, BigModel и др.)
- Агентный режим через OpenHands: файлы workspace, bash, web-поиск, проверка кода, git
- SSE-стриминг ответа, reasoning/thinking, tool-карточки, финальный `done`
- Workspace: FileTree, редактор, upload/download, поиск, preview, zip-скачивание
  - изоляция: `/workspace/chats/<chatId>` — один чат = один под-workspace
- Пользователи и сессии: email/password, HttpOnly cookie, SQLite
- Vault: шифрование API-ключей per-user (cryptography/Fernet)
- Cloud Sync: настройки + чаты, импорт истории из OpenHands
- Key rotation: проверка нового ключа перед заменой
- DeepSeek managed session: `/api/admin/deepseek/*`
- Health: `/api/health`, `/api/health/deep`

## Структура проекта

```
core/                FastAPI монолит
  server.py          ~3000 строк, все /api/* роуты, OpenHands bridge, SSE
  auth.py            сессии, регистрация, login
  database.py        SQLite, keys/params
  conversations.py   маппинг BrowserAI chatId ↔ OpenHands conversation_id
  providers.py       LLM каталог, validate_key, push_to_openhands
  agent_state.py     runs / questions / answers
  memory_kb.py       факты, project memory, KB RAG
  web_image.py       web_search, generate_image
  vault.py           шифрование ключей
  admin_data.py      jobs / cost / operator / incidents
  obslog.py          JSON logs + trace_id

ui/                  React UI
  src/App.jsx
  src/components/    MessageList, Composer, Sidebar, FileTree, OpenHandsWorkspace, SettingsModal …
  src/lib/           api.js, agentStream.js, settings.js …

docker-compose.yml   browserai + openhands
Dockerfile           2-stage: Node build UI → Python runtime
tests/               pytest
```

## Быстрый запуск локально

Backend:
```bash
pip install fastapi uvicorn httpx websockets pydantic aiosqlite bcrypt itsdangerous python-multipart cryptography
uvicorn core.server:app --reload --port 8080
```

Frontend:
```bash
cd ui
npm ci
npm run dev
# http://localhost:5173
```

Production-like Docker:
```bash
cp .env.example .env
# отредактируй SESSION_SECRET, AUTH_SECRET, APP_URL, DATA_DIR, WORKSPACE_DIR
docker compose up -d --build
# http://localhost:8080
```

## Переменные окружения

Минимум:
```env
APP_URL=http://186.246.14.141
SESSION_SECRET=long-random-string
AUTH_SECRET=another-long-random-string
BROWSERAI_DB=/data/browserai.db
WORKSPACE_ROOT=/workspace
OPENHANDS_AGENT_SERVER=http://openhands:18000
```

Опционально:
- `BROWSERAI_DEFAULT_MODEL=glm-4.5-flash`
- `OPENHANDS_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4`
- `BIGMODEL_API_KEY=...`
- `REGISTRATION_SECRET=...`
- `BROWSERAI_STREAM_RECHUNK=1`
- `BROWSERAI_STREAM_CHUNK_CHARS=24`
- `BROWSERAI_AGENT_MAX_ITERATIONS=50`
- `BROWSERAI_EVENT_POLL_INTERVAL=0.6`

Полный список см. `.env.example`.

## API

Основной endpoint: `POST /api/agent/chat` — SSE

Ключевые файлы:
- `core/server.py` — FastAPI, OpenHands bridge, SSE-трансляция, workspace API
- `core/providers.py` — каталог моделей, `validate_key`, `push_to_openhands`
- `core/conversations.py` — `get_or_create_conversation`
- `ui/src/lib/agentStream.js` — клиент SSE

Инструменты агента выполняются в OpenHands runtime, BrowserAI транслирует события:
`agent_state`, `thinking_delta`, `tool_start`, `tool_result`, `assistant_delta`, `done`

Workspace API:
- `GET /api/workspace/tree?chatId=...`
- `GET /api/workspace/file?path=...`
- `PUT /api/workspace/file`
- `POST /api/workspace/upload`
- `POST /api/workspace/upload-url` — git clone / zip / tar auto-extract
- `GET /api/workspace/download`

Auth / keys:
- `POST /api/auth/register`, `/api/auth/login`, `/api/auth/logout`
- `GET /api/keys`, `POST /api/keys`, `POST /api/keys/rotate`
- `GET /api/vault/status`, `POST /api/vault/unlock`

## Проверки

```bash
pytest -q
python -m py_compile core/server.py
```

UI:
```bash
cd ui
npm test
npm run build
```

## Деплой на Timeweb

`.github/workflows/deploy-timeweb.yml`

Secrets:
- `TIMEWEB_SSH_KEY`
- `TIMEWEB_HOST` — `186.246.14.141`
- `TIMEWEB_USER=root`
- `TIMEWEB_APP_DIR=/opt/browserai`

Ручной деплой:
```bash
cd /opt/browserai
git fetch origin main
git reset --hard origin/main
docker compose up -d --build --force-recreate browserai
docker image prune -f
curl -fsS http://localhost:8080/api/health
```

Автодеплой: push в `main` → GitHub Actions → SSH → `docker compose up -d --build` → healthcheck.

Данные на сервере:
- `/opt/browserai` — git checkout
- `/opt/browserai-data` — `browserai.db`, backups, workspace
- `/opt/browserai-data/workspace/chats/<chatId>` — изолированные workspace'ы

## Лицензия

MIT
