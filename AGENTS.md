# AGENTS.md — Системный контекст и правила для ИИ-агентов BrowserAI

Добро пожаловать в BrowserAI! Этот файл — главный источник архитектурной истины (Ground Truth) для любых ИИ-агентов, работающих с этим репозиторием.

---

## 🚀 1. Суть проекта

**BrowserAI** — это web-оболочка для **OpenHands Agent Server**, развернутая на Timeweb VPS (`186.246.14.141`), интегрированная с GitHub `robesthud/browserAI`.

Архитектура и UI/UX — в стиле **Arena.ai Agent Mode**: минимализм, автопилот, никакого шума, мгновенный отклик.

Стек:
- **Backend: Python 3.12 + FastAPI + Uvicorn + SQLite**
  `core/server.py` — монолит ~3000 строк, все `/api/*`
- **Frontend: React 19 + Vite + Tailwind**
  `ui/src/`
- **Agent engine: OpenHands** `ghcr.io/all-hands-ai/openhands:main`
  БраузерAI проксирует чат в OpenHands, транслирует события в SSE для UI
- **DB: SQLite** `browserai.db` — users, keys, conversations, agent_state, memory/kb
- **Deploy: Docker Compose**, Timeweb, GitHub Actions

---

## 🎨 2. Философия UI/UX (Arena Style)

1. **Двусторонний баббл-чат**
   - `Вы` — справа, `bg-graphite-750`, `rounded-2xl rounded-tr-none`
   - `Ассистент` — слева, `border-white/5 bg-graphite-800/25`, `rounded-2xl rounded-tl-none`
   - Запрещено: заголовки «Вы / Ассистент» над бабблами, аватарки
   - Запрещено: `divide-y` между сообщениями, только `space-y-1.5`

2. **Микро-карточки инструментов**
   - `read`, `write`, `edit`, `bash`, `tests`, `verify` — компактные, моноширинные, раскрывающиеся
   - названия строго lowercase английский

3. **Типографика**
   - `font-weight: 500` для `.md-p`, `.md-list`
   - разделители `---` → `border-top: 1px solid rgba(255,255,255,0.05)`

4. **Никакой воды**
   - никаких «Чем могу помочь?», дубликатов, приветствий
   - результат + лаконичный тех-отчёт, всё

UI файлы: `ui/src/MessageList.jsx`, `ui/src/components/AgentToolBlock.jsx`, `ui/src/index.css`

---

## 💻 3. Архитектура бэкенда

**FastAPI монолит — `core/server.py`**

Ключевые модули `core/`:
- `auth.py` — email/password, HttpOnly cookie, sessions
- `database.py` — keys / params, SQLite
- `conversations.py` — маппинг `BrowserAI chat_id ↔ OpenHands conversation_id`
- `providers.py` — каталог моделей, `validate_key`, `push_to_openhands`
- `agent_state.py` — runs, questions/answers
- `memory_kb.py` — facts, project_memory, KB RAG
- `web_image.py` — web_search, generate_image
- `vault.py` — Fernet-шифрование API-ключей per-user
- `obslog.py` — JSON logs + `trace_id`, `X-Trace-Id`

**OpenHands bridge**
- `POST /api/agent/chat` → `_stream_chat()`
- push LLM settings в OpenHands: `providers.push_to_openhands()`
- `get_or_create_conversation()` — reuse conversation per chatId
- poll `/api/conversations/{cid}/events`, translate в SSE: `agent_state`, `thinking_delta`, `tool_start`, `tool_result`, `assistant_delta`, `done`
- progressive output: rechunk в `STREAM_CHUNK_CHARS=24`, typewriter feel

**Workspace изоляция**
- Один BrowserAI chat = один под-workspace: `/workspace/chats/<chatId>`
- `_chat_workspace_abs(chat_id)` / `_ensure_chat_workspace()`
- API: `/api/workspace/tree`, `/api/workspace/file`, `/api/workspace/upload`, `/api/workspace/upload-url` (git clone / zip auto-extract), `/api/workspace/download`
- OpenHands контейнер монтирует тот же volume, файлы видны сразу

**Cloud Sync**
- `/api/cloud` — OpenHands является source of truth для истории чатов
- `/_fetch_oh_conversations_for_cloud()` — импорт OH conversations → BrowserAI chats
- `PUT /api/cloud` сохраняет только settings, НЕ чаты — иначе воскресают удалённые

**Auth / Vault**
- `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`
- Vault: `/api/vault/setup`, `/api/vault/unlock`, `/api/vault/lock`
- Ключи: `/api/keys`, `/api/keys/rotate` — валидация нового секрета перед заменой

---

## 🛡️ 4. Правила для агентов

1. **Workspace scope**
   - Всегда работай в `/workspace/chats/<chatId>`, никогда в `/workspace` корне
   - Перед файловой операцией: `mkdir -p /workspace/chats/<chatId>`

2. **Chat deletion**
   - Удаление чата в BrowserAI → обязательно `DELETE /api/conversations/{cid}` в OpenHands, иначе чат воскреснет при следующем `/api/cloud`

3. **Secrets**
   - Никогда не коммить `.env`, `browserai.db`, `deepseek_session.json`
   - Токены в логах маскируются
   - `git push` только после проверки секретов

4. **Тесты перед коммитом**
   ```bash
   python -m py_compile core/server.py
   pytest -q
   cd ui && npm run build
   ```

5. **Модели**
   - Default: `glm-4.5-flash` / z.ai / BigModel
   - Каталог: `core/providers.py`, unified model catalog, live-probe
   - DeepSeek tool-calling: fresh session per call, loop-guard

6. **SSE протокол**
   - События: `stream_protocol`, `agent_context`, `agent_state`, `thinking_delta`, `tool_start`, `tool_result`, `assistant_delta`, `assistant`, `done`, `error`
   - Не ломай порядок событий

7. **Логи**
   - JSON logs, `trace_id` в `X-Trace-Id`
   - `core/obslog.py`

---

## 🗂️ 5. Деплой

- Repo: `robesthud/browserAI`, branch `main`
- Server: `root@186.246.14.141`, `/opt/browserai`
- Data: `/opt/browserai-data` — `browserai.db`, workspace, backups
- Deploy:
  ```bash
  cd /opt/browserai
  git reset --hard origin/main
  docker compose up -d --build browserai
  curl http://localhost:8080/api/health
  ```
- CI: `.github/workflows/deploy-timeweb.yml`

---

BrowserAI — автономный, минималистичный, надёжный ИИ-помощник поверх OpenHands. Код чистый, интерфейс плотный, никакой воды.
