# BrowserAI Project Context

## Стек
- Runtime: Node.js 22, ESM (`import`/`export`), никакого CommonJS (`require`).
- Frontend: React 18 + Vite (production build в `dist/`).
- Backend: Express-like HTTP сервер, файлы в `/server/`.
- База: SQLite (`better-sqlite3`), файл `/data/browserai.db`.
- Стили: Tailwind CSS + inline styles. Никаких внешних CSS-файлов для компонентов.
- Сборка: `npm run build` (Vite), Docker-образ `browserai:latest`.

## Критичные файлы (не трогать без разрешения)
- `docker-compose.yml` — структура деплоя, порты, лимиты ресурсов.
- `Dockerfile` — multi-stage build, Alpine-рунтайм.
- `deploy.sh` — скрипт деплоя. Должен работать из `/opt/browserai`.
- `.env` — секреты. Не коммитить в git.
- `/opt/browserai-data/` — живые данные (БД, сессии, бэкапы). Не удалять.

## Деплой и инфраструктура
- Сервер: TimeWeb Cloud VPS, IP указан в `.env` (APP_URL), root-пароль в `.env`.
- Директория проекта: `/opt/browserai`.
- Data dir: `/opt/browserai-data` (bind-mount `./data` в compose).
- Workspace dir: `/opt/browserai-workspace` (bind-mount `./workspace` в compose).
- Деплой: `docker compose build --no-cache browserai && docker compose up -d --force-recreate browserai`.
- Проверка: `docker ps | grep browserai` и `curl -s http://localhost/health`.
- Пересборка: обязательно `--no-cache` если меняли `server/` или `package.json`.

## Провайдеры и API-ключи (резолвятся через БД или env)
- DeepSeek: managed-сессия через cookies. Сессия в `/opt/browserai-data/deepseek_session.json`.
- BigModel (Zhipu): API-ключ в `.env`. База `https://open.bigmodel.cn/api/paas/v4`. Модели: `glm-5`, `glm-5.1`, `glm-4.5`.
- Telegram: бот `@brawserAI_bot`, токен в `.env`.
- Cloudflare Proxy: `browserai-proxy.robesthud.workers.dev`, секрет в `.env`.
- GitHub: `robesthud/browserAI`, токен в `.env`.

## Агент мод (критично)
- Endpoint `/api/agent/chat` должен всегда запускать полный agent loop с инструментами (`forceAgent: true` на сервере).
- Если `agentLoop.js` импортирует `LITE_TOOL_NAMES` — этот экспорт обязан существовать в `agentTools.js`.
- System prompt должен содержать `TOOLS` и `renderToolsForPrompt()` в XML-формате для DeepSeek.
- Инструменты: `write_file`, `edit_file`, `bash`, `read_file`, `list_files`, `web_search`, `web_fetch`, `ask_user`, `npm_install`, `npm_test`, `git_status`, `git_commit`, `docker_logs`, `docker_ps`, `verify_code`, `read_project_rules`.
- Не использовать `docker-compose` команду внутри контейнера (нет в PATH). Использовать `docker compose`.

## Безопасность
- `AUTH_SECRET` и `SESSION_SECRET` — обязательно заданы в `.env`.
- Не хранить токены в коде — только в `.env` и через `process.env`.
- `CF_PROXY_SECRET` и API-ключи не логировать в чат-debug.

## Типичные проблемы
- Ошибка: `LITE_TOOL_NAMES is not exported` → добавить `export const LITE_TOOL_NAMES = [...]` в `agentTools.js`.
- Ошибка: `docker-compose: command not found` → использовать `docker compose` (v2 plugin).
- Ошибка: `Unauthorized` в Telegram → токен отозван, запросить новый у @BotFather.
- Ошибка: `.env` не подхватывается → файл должен быть в `/opt/browserai/.env`, не в подпапках.
- Ошибка: пустая база после деплоя → проверить `DATA_DIR=/opt/browserai-data` в `.env`.
