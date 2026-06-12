# BrowserAI — Проектные правила для агента

## Общие принципы
- Пиши код как старший разработчик. Минимум комментариев, максимум самодокументирующихся имён.
- Никогда не выдавай код в текстовом ответе. Всегда используй `write_file` или `edit_file`.
- После создания/изменения файлов обязательно запускай `npm test` или проверяй синтаксис через `node --check`.
- Если что-то ломается — смотри логи (`docker logs browserai`) и чини корень проблемы, а не симптом.

## Стек и архитектура
- **Runtime**: Node.js 22, ESM-модули (`import`/`export`), никакого CommonJS (`require`).
- **Frontend**: React 18 + Vite (production build в `dist/`).
- **Backend**: Fastify-like Express на чистом Node.js, файлы в `/server/`.
- **База**: SQLite (`better-sqlite3`), файл `/data/browserai.db` (bind-mount с хоста).
- **Стили**: Tailwind CSS + inline styles. Никаких внешних CSS-файлов для компонентов.
- **Сборка**: `npm run build` (Vite), образ `browserai:latest`.

## Критичные файлы — не трогать без разрешения
- `docker-compose.yml` — деплой структура, порты, лимиты ресурсов.
- `Dockerfile` — multi-stage build, Alpine-рунтайм.
- `deploy.sh` — скрипт деплоя. Должен работать из `/opt/browserai` (не `/home/user/browserai`).
- `.env` — секреты на сервере. Путь: `/opt/browserai/.env`. Никогда не коммить в git.
- `/opt/browserai-data/` — живые данные (БД, сессии, бэкапы). Не удалять.

## Деплой и инфраструктура
- **Сервер**: TimeWeb Cloud VPS, IP `$SERVER_IP`, root-пароль в `.env` (если нужен SSH).
- **Директория проекта**: `/opt/browserai` (symlink или git clone сюда).
- **Data dir**: `/opt/browserai-data` (bind-mount `./data` в compose → здесь).
- **Workspace dir**: `/opt/browserai-workspace` (bind-mount `./workspace` в compose → здесь).
- **Деплой**: `docker compose build --no-cache browserai && docker compose up -d --force-recreate browserai`.
- **Проверка**: `docker ps | grep browserai` и `curl -s http://localhost/health`.
- **Пересборка**: обязательно `--no-cache` если меняли `server/` или `package.json`.

## Провайдеры и API-ключи
- **DeepSeek**: managed-сессия через cookies. Сессия хранится в `/opt/browserai-data/deepseek_session.json`. Не требует API-ключа.
- **BigModel (Zhipu)**: API-ключ `$BIGMODEL_API_KEY`. База `https://open.bigmodel.cn/api/paas/v4`. Модели: `glm-5`, `glm-5.1`, `glm-4.5`.
- **Telegram**: бот `@brawserAI_bot`, токен в `.env`. Поддерживает команды и админ-чат.
- **Cloudflare Proxy**: `browserai-proxy.robesthud.workers.dev`, секрет `browserai-secret-2026`.
- **GitHub**: `robesthud/browserAI`, токен `$GITHUB_TOKEN`.

## Агент мод (критично)
- Endpoint `/api/agent/chat` должен **всегда** запускать полный agent loop с инструментами (`forceAgent: true` на сервере).
- Если `agentLoop.js` импортирует `LITE_TOOL_NAMES` — этот экспорт **обязан** существовать в `agentTools.js`.
- System prompt должен содержать `TOOLS` и `renderToolsForPrompt()` в XML-формате для DeepSeek.
- Инструменты: `write_file`, `edit_file`, `bash`, `read_file`, `list_files`, `web_search`, `web_fetch`, `ask_user`.
- **Не использовать** `docker-compose` команду внутри контейнера (нет в PATH). Использовать `docker compose`.

## Безопасность и секреты
- `AUTH_SECRET` и `SESSION_SECRET` — обязательно заданы в `.env` (генерировать через `openssl rand -base64 48` или `secrets.token_urlsafe`).
- Не хранить токены в коде — только в `.env` и через `process.env`.
- `CF_PROXY_SECRET` и API-ключи не логировать в чат-debug.

## Работа с БД
- SQLite-файл: `/opt/browserai-data/browserai.db` (62 МБ на хосте).
- Таблицы: `keys`, `params`, `users`, `sessions`, `semantic_memory`, `llm_spend`, `checkpoints` и др.
- Бэкапы: ежедневно в `/opt/browserai-data/backups/browserai-YYYYMMDD.tar.gz`.
- Перед миграциями: `cp /opt/browserai-data/browserai.db /opt/browserai-data/browserai.db.backup`.

## Типичные проблемы и решения
- **Ошибка**: `LITE_TOOL_NAMES is not exported` → добавить `export const LITE_TOOL_NAMES = [...]` в `agentTools.js`.
- **Ошибка**: `docker-compose: command not found` → использовать `docker compose` (v2 plugin).
- **Ошибка**: `Unauthorized` в Telegram → токен отозван, запросить новый у @BotFather.
- **Ошибка**: `.env` не подхватывается → файл должен быть в `/opt/browserai/.env`, не в подпапках.
- **Ошибка**: пустая база после деплоя → проверить `DATA_DIR=/opt/browserai-data` в `.env`.

## Процесс разработки
1. Правишь код локально через `write_file`/`edit_file`.
2. Проверяешь синтаксис: `node --check file.js`.
3. Если нужно — пересобираешь образ: `docker compose build --no-cache browserai`.
4. Пересоздаёшь контейнер: `docker compose up -d --force-recreate browserai`.
5. Проверяешь логи: `docker logs --tail=50 browserai`.
6. Проверяешь health: `curl -s http://localhost/health`.

## Контакты и доступы
- **Сервер**: `root@$SERVER_IP`, пароль `$ROOT_PASSWORD` (TimeWeb VPS).
- **GitHub**: `robesthud`, репозиторий `robesthud/browserAI`.
- **Telegram бот**: `@brawserAI_bot`.
