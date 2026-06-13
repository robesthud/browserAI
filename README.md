# BrowserAI

BrowserAI — русскоязычный web-чат с AI и агентным режимом. Фронтенд: React + Vite + Tailwind. Бэкенд: Express + SQLite. Production-развёртывание рассчитано на VPS Timeweb через Docker Compose и GitHub Actions.

## Что умеет

- Обычный чат с OpenAI-compatible провайдерами.
- Агентный режим: модель может читать/редактировать файлы workspace, запускать sandboxed bash, искать по web, проверять код, работать с Git и ops-действиями.
- SSE-стриминг ответа, reasoning/thinking, прогресс инструментов и финальный `done`-ивент.
- Workspace: файлы, редактор, upload/download, поиск по содержимому, preview.
- Пользователи и сессии: email/password, HttpOnly cookie, SQLite.
- Vault/Cloud Sync для пользовательских ключей и настроек.
- DeepSeek managed session: сервер может хранить Bearer/cookies и подставлять их в preset.
- Timeweb deploy: push в `main` запускает GitHub Actions и обновляет контейнер на VPS.

## Структура проекта

```text
src/                 React UI
src/lib/             клиентские API, чаты, agent stream
src/components/      UI-компоненты
server/              Express API, agent loop, tools, providers, workspace
tests/               Vitest-регрессии
docker-compose.yml   production compose
deploy.sh            ручной deploy helper
.github/workflows/   CI, Timeweb deploy, Android build/release
```

## Быстрый запуск локально

```bash
npm ci
npm run dev:all
```

Web UI: `http://localhost:5173`.

Только backend:

```bash
npm run server
```

Production-like Docker:

```bash
cp .env.example .env
# отредактируй SESSION_SECRET, AUTH_SECRET, APP_URL, DATA_DIR, WORKSPACE_DIR
docker compose up -d --build
```

## Переменные окружения

Минимум для production:

```env
NODE_ENV=production
PORT=8080
APP_URL=https://your-domain.example
SESSION_SECRET=long-random-string
AUTH_SECRET=another-long-random-string
DATA_DIR=/opt/browserai-data
WORKSPACE_DIR=/opt/browserai-workspace
WORKSPACE_ROOT=/workspace
```

Опционально:

- `REGISTRATION_SECRET` — если нужны новые регистрации после первого owner.
- `CORS_ORIGIN` — дополнительный origin.
- `DEEPSEEK_USER_TOKEN`, `DEEPSEEK_COOKIES` — bootstrap для DeepSeek managed session.
- `TG_BOT_TOKEN`, `TG_ADMIN_CHAT_ID` — Telegram-уведомления и админ-команды.
- `BROWSERAI_DISABLE_STREAMING=1` — отключить provider-side SSE, если конкретный провайдер ломает стрим.
- `BROWSERAI_MAX_OUTPUT_TOKENS=4096` — лимит ответа для Anthropic/Gemini official API.

Полный список см. в `.env.example`.

## Агентный режим

Основной endpoint: `POST /api/agent/chat`.

Ключевые файлы:

- `server/agentLoop.js` — цикл LLM ↔ tools, SSE, watchdog, tool routing.
- `server/agentTools.js` — реальный реестр инструментов.
- `server/clinePrompt.js` — системный prompt агента.
- `server/llmClient.js` — OpenAI-compatible, Anthropic, Gemini, DeepSeek managed transports.
- `src/lib/agentStream.js` — клиент SSE.
- `src/lib/useChats.js` — обновление сообщений, tool cards, pending/done state.

### Deterministic action router

Простые команды не должны идти в LLM. `server/deterministicActionRouter.js` распознаёт безопасные одношаговые действия и сразу запускает нужный tool:

- `repo_download` → `git_clone` для «скачай/клонируй GitHub repo»;
- `archive_zip` → `zip_files` для «запакуй/заархивируй/zip».

Новые простые операции добавляются декларативно в этот router: matcher + tool + args + success/error text. Сложные задачи продолжают идти в обычный agent loop.

### Зарегистрированные базовые инструменты

- План/вопросы: `plan_set`, `plan_check`, `ask_user`.
- Память/RAG: `recall_facts`, `remember_fact`, `forget_fact`, `kb_search`, `kb_list`, `kb_add`, `kb_delete`.
- Workspace: `read_project_rules`, `list_files`, `read_file`, `search_files`, `write_file`, `edit_file`, `delete_file`.
- Команды/проверки: `bash`, `npm_install`, `npm_test`, `verify_code`.
- Git: `git_status`, `git_commit` (`git_commit` также push-ит в `main`).
- Web: `web_search`, `web_fetch`.
- Media/browser/ops: `generate_image`, `edit_image`, `generate_video`, `analyze_image`, `text_to_speech`, `transcribe_audio`, `browser_*`, `computer_*`, `docker_ps`, `docker_logs`, `ops_list_services`, `ops_run_action`.

Важно: prompt и tool profiles должны ссылаться только на реально зарегистрированные инструменты. Для этого есть регрессия `tests/agent-tool-registry.test.js`.

## Исправление зависания агента на «раздумье»

В агенте были три причины, из-за которых модель могла думать и не переходить к действиям:

1. Prompt и tool profiles ссылались на удалённые/несуществующие инструменты (`build_repo_map`, `run_tests`, `git_diff`, `git_push`, `replace_across_files` и т.п.).
2. Каталог инструментов в prompt не фильтровался по активному профилю задачи.
3. Native tool-call preview не отдавался в UI во время SSE-стрима, поэтому пользователь видел только thinking до конца ответа модели.

Текущее поведение:

- prompt строится только из реального registry;
- planning/memory/question tools реально зарегистрированы;
- native tool-call delta показывает `tool_preview` до запуска инструмента;
- LLM idle watchdog сокращён до 2 минут;
- Anthropic/Gemini tool calls корректно возвращаются и в fallback/non-stream путях.

## Проверки перед коммитом

```bash
node --check server/agentLoop.js
node --check server/agentTools.js
node --check server/clinePrompt.js
node --check server/llmClient.js
npm test
npm run build
```

`npm run lint` сейчас проверяет весь исторический код и может падать на старые eslint-ошибки, не связанные с текущими изменениями. CI отдельно lint-ит критические agent-модули.

## Деплой на Timeweb

Production workflow: `.github/workflows/deploy-timeweb.yml`.

Нужные GitHub Secrets:

- `TIMEWEB_SSH_KEY`
- `TIMEWEB_HOST`
- `TIMEWEB_USER`
- `TIMEWEB_APP_DIR`

На сервере в `TIMEWEB_APP_DIR` должен быть checkout репозитория и `.env`.

Ручной деплой на VPS:

```bash
cd /opt/browserai
git fetch --quiet origin main
git reset --hard origin/main
docker compose up -d --build --force-recreate --remove-orphans browserai
docker image prune -f
curl -fsS http://localhost/api/health
```

Автодеплой: push в `main` → GitHub Actions → SSH на Timeweb → `git reset --hard origin/main` → `docker compose up -d --build` → healthcheck.

## DeepSeek managed session

Если задана managed-сессия, фронт выбирает preset `DeepSeek managed`, а сервер сам подставляет Bearer/cookies.

Admin endpoints:

- `GET /api/admin/deepseek/status`
- `POST /api/admin/deepseek/refresh`
- `POST /api/admin/deepseek/token`
- `GET /api/admin/deepseek/models`
- `GET /api/deepseek/managed`

Состояние хранится в `/data/deepseek_session.json`, то есть в `DATA_DIR` на хосте, и переживает пересборку контейнера.

## CI

```bash
npm ci
npm test
npm run build
```

Live provider smoke tests в `tests/provider-smoke.test.js` автоматически skip-аются без API keys.
