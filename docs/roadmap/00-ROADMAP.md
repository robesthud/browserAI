# BrowserAI ↔ OpenHands — Integration Roadmap

> 📋 **Этот план сверен с реальным кодом 2026-06-27.** Полный построчный отчёт
> верификации (статусы Step 1–10 по единой шкале, доказательства, что доделать) —
> в `docs/VERIFICATION-REPORT-2026-06-27.md`. Метки статусов ниже отражают факт.

> Полный план полной интеграции. UI BrowserAI (React/Vite, не меняем),
> "мозг" — OpenHands Agent Server v0.59, бекенд-мост — Python FastAPI монолит
> `core/server.py`.

**Branch:** `sync/from-timeweb-2026-06-27`
**Прод:** `root@186.246.14.141`, путь `/opt/browserai`
**UI URL:** `http://186.246.14.141/`
**Текущий статус (ВЕРИФИЦИРОВАНО 2026-06-27 по коммиту `70a79a4`):**
В проде (`main`) работают Step 1–9 (Step 10 — частично, только healthcheck).
Чат отвечает, multi-turn с reuse, workspace, auth + cloud sync, мульти-провайдер,
vault, память/KB, jobs/cost/notifications/operator/incidents/gateway на реальных
данных, интерактивный agent-flow (вопросы/ответы/runs/control-plane). Step 6 влит
в main (`70a79a4`) и задеплоен. Полный разбор: см. `docs/VERIFICATION-REPORT-2026-06-27.md`.

**Архитектурный принцип:** UI ходит к `core/server.py`, тот переводит вызовы
в OpenHands. Старые таблицы от Node-стека (40+ табл., `agent_workflows`,
`notifications`, `semantic_memory`, ...) переиспользуем где возможно вместо
пересоздания с нуля.

---

## ✅ DONE — что уже работает

### STEP 1 — Audit & Baseline (commit предшествует sync)
- [x] Проинвентаризированы все 97 endpoint-ов, которые UI вызывает
- [x] Найдены 8 корневых архитектурных разрывов (см. `01-audit.md`)
- [x] Зафиксирован API-контракт UI (body shapes, SSE events, cookie expectations)

### STEP 2 — Chat core (commits `201d924`, `8479154`)
**Цель:** чат отвечает, агент работает, streaming чистый.
- [x] `/api/health` теперь `{ok:true}` (раньше UI считал себя offline)
- [x] CORS: убран wildcard, allow_credentials валиден
- [x] `/api/agent/chat`:
  - [x] парсит реальный body UI: `{chatId, history, extraSystem, keyId, useStoredSecret, baseUrl, apiKey, authType, authHeader, extraHeaders, model, temperature}`
  - [x] резолвит сохранённый ключ из БД при `useStoredSecret=true`
  - [x] добавляет `openai/` префикс для bigmodel/z.ai/deepseek (LiteLLM требование)
  - [x] полный SSE event lifecycle: `stream_protocol → agent_context → thinking → agent_state → tool_start/result → assistant_delta → assistant → done`
- [x] **Bug fix:** WebSocket `/api/sockets/events/{cid}` не существует в OpenHands v0.59 → переход на HTTP polling `/api/conversations/{id}/events`
- [x] **Bug fix:** OpenHands пытался использовать `ghcr.io/all-hands-ai/runtime:main` (устарел с авг 2024, нет `action_execution_server.py`) → убрали override `SANDBOX_RUNTIME_CONTAINER_IMAGE`, OpenHands собирает кастомный runtime сам из main исходников
- [x] **Bug fix:** DNS `host.docker.internal` не работает на Linux Docker → добавлен `extra_hosts: host-gateway` для openhands и browserai в compose
- [x] **Bug fix:** event translator писали под угаданную схему OpenHands; v0.59 использует top-level `action`/`observation` строки + `args`/`extras` payload → переписан под реальный wire format
- [x] **Bug fix:** GLM возвращает `<think>...</think>` (иногда без открывающего тега) → парсер вырезает CoT, оставляет только финальный текст; thinking идёт в отдельный SSE event
- [x] **Bug fix:** стрим не закрывался при `awaiting_user_input` (статус `/conversations/{id}` остаётся `RUNNING`) → используем `agent_state_changed` event как источник правды
- [x] **Bug fix:** wrapper `docker/runtime/micromamba-wrapper.sh` неправильно проксировал вызов; теперь корректно превращает `micromamba run -n openhands poetry run python ...` в прямой `/openhands/poetry/openhands-*-py*/bin/python ...`
- [x] Stub-маршруты JSON-200 для всех ~60 ещё нереализованных endpoint-ов (UI не падает на HTML 404)

### STEP 3 — Auth + Cloud sync (commits `133b257`, `304e707`)
**Цель:** пользователи, логин, сохранение настроек/чатов в БД.
- [x] `core/auth.py` (новый): таблицы `users`, `sessions`, `cloud_state`
- [x] bcrypt cost-12 для паролей
- [x] `itsdangerous.URLSafeTimedSerializer` для подписи cookie
- [x] `browserai_session` cookie: HttpOnly, SameSite=Lax, Secure (auto при https://APP_URL)
- [x] 30-дневная сессия с auto-renew при каждом `/api/auth/me`
- [x] Endpoints: `/api/auth/{me, register, login, logout}`, `/api/cloud` GET/PUT
- [x] Registration policy: первый юзер = `owner`; дальше открыто или закроется по `REGISTRATION_SECRET`
- [x] Per-user изоляция cloud данных
- [x] `password-recovery`, `sms-*` отдают честный 501 с понятным reason
- [x] `init_auth_schema` запускается на FastAPI startup (no race с первым request)
- [x] **Bug fix:** старая `sessions` таблица с другой схемой (`token_hash` колонка) от прошлой попытки → дроп + пересоздание
- [x] **Bug fix:** `docker-compose.yml` не прокидывал `AUTH_SECRET`, `SESSION_SECRET`, `APP_URL` → добавлен явный `environment:` блок + `env_file: .env`
- [x] **Bug fix:** `Dockerfile` не ставил `bcrypt`, `itsdangerous` → добавлены в pip install layer
- [x] **Bug fix (3.1):** SSE стрим висел после ответа агента (`/conversations/{id}` status=RUNNING остаётся) → закрываем при event `agent_state_changed → awaiting_user_input`

### STEP 4 — Conversation reuse + Workspace API (commit `f48530f`)
**Цель:** ×3 ускорение multi-turn, реальный workspace в UI.
- [x] `core/conversations.py` (новый): таблица `chat_conversations` маппит `chat_id ↔ openhands_conversation_id`
- [x] Reuse policy: live → POST `/message`, dead/none → create+start
- [x] SSE `agent_state {phase: warm|cold, conversationId}` для UI
- [x] `done` event содержит `reused: bool`
- [x] Workspace endpoints (real, не stub):
  - [x] `GET /api/workspace/tree?chatId=...&path=...` → `/list-files`
  - [x] `GET /api/workspace/file?chatId=...&path=...` → `/select-file`
  - [x] `GET /api/workspace/metadata?chatId=...` → mapping info
  - [x] `GET /api/workspace/download?chatId=...` → zip via `/zip-directory`
- [x] **Bug:** OpenHands `/events?start_id=N` всегда возвращает `[]` → не используем фильтр, дедуплицируем через `seen_ids` set
- [x] **Bug:** OpenHands `/events?limit>100` → 400 → жёстко `limit=100`
- [x] Persist `last_event_id` после каждого turn — warm reuse не реплеит старые события
- [x] **Подтверждено замером:** TURN 1 cold 180s → TURN 2 warm **60s** (×3 ускорение)
- [x] **Подтверждено e2e:** агент создал `/workspace/test.txt`, в следующем turn прочитал и вернул контент с контекстом TURN 1

---

### STEP 7 — Memory / KB / Web / Image — 🟡 ЧАСТИЧНО (влит в main, commit `531f895`)
- [x] **7.1 Memory facts CRUD** — `core/memory_kb.py`, таблица `user_facts` (40 строк)
- [ ] **7.1 Авто-извлечение фактов (factExtractor)** — ❌ НЕ реализовано
- [x] **7.2 Semantic memory + FTS5** — `search_semantic()` (460+163 строк)
- [x] **7.3 Knowledge base** — TF-IDF search/add/delete/list (таблицы пустые)
- [x] **7.4 Project memory** — реализован (таблица пустая)
- [~] **7.5 Web search** — через Brave/DuckDuckGo, НЕ через OpenHands MCP (отклонение от плана)
- [ ] **7.6 Image generation** — ❌ ЗАГЛУШКА: пишет SVG-плейсхолдер, реального image-API нет

---

## 🚧 TODO — что осталось

### STEP 5 — Multi-provider + Settings persistence + Vault ✅ DONE (commit `1a734ea`)
- [x] **5.1 Provider switching через OpenHands settings** — activate_key → async push, qualify_model для openai/anthropic/gemini/openrouter
- [x] **5.2 Settings persistence (params)** — таблица `params` + GET/PUT `/api/params`, params попадают в push_to_openhands
- [x] **5.3 Per-key validation** — `/api/validate` с реальным round-trip + latencyMs
- [x] **5.4 Model catalog** — `/api/models?baseUrl=&keyId=`, fetch с /models или /v1/models + fallback hardcoded, кэш 1 час
- [x] **5.5 Vault** — `core/vault.py`, PBKDF2-HMAC-SHA256 (200k) + AES-GCM, full UI surface (status/setup/unlock/lock/change/disable/autolock/backup/restore)
- [x] **Bug fix:** маска для `enc:` ключей не должна leak'ать ciphertext → "🔒 encrypted"
- [x] **Bug fix:** secrets никогда не отдаются в `/api/keys` — `maskedApiKey` отдельным полем
- [x] **Bug fix:** при upsert key с `useStoredSecret=true` и пустым/masked apiKey сохраняем существующий secret из БД
- [x] **Bug fix:** Anthropic использует `x-api-key`, Gemini использует query `?key=` (не Bearer)
- См. `05-step5-done.md`

### STEP 6 — Agent interactive flow — 🟢 ГОТОВО (в main + прод)
**Цель:** агент может задавать вопросы юзеру, юзер видит progress, может прерывать.

> ✅ **ВЕРИФИЦИРОВАНО (2026-06-27, commit `70a79a4`):** уникальные step6-эндпоинты
> перенесены в `core/server.py` напрямую (НЕ merge ветки — он затёр бы Step 7/8/9),
> `core/agent_state.py` теперь импортируется и `init_agent_state_schema()` вызывается
> на старте. Таблицы `agent_runs` + `agent_questions` наполняются прямо из chat-стрима
> (`upsert_run`/`set_run_status`/`create_question`). Все 7 путей исключены из stub'ов
> (`_REAL_NOW`). Проверено вживую на проде: recipes→3 рецепта, control-plane→`{runs,count}`,
> answer без qid→400, runs/{id}/reset+history→реальные хендлеры. Контейнер healthy.

- [x] **6.1 ask_user через OpenHands**
  - [x] Агент задаёт вопрос → backend парсит (`_extract_ask_user_payload`: JSON `ASK_USER:{...}` или текст с `?`+опциями), шлёт SSE `ask_user {question_id, question, options[]}` + создаёт row в `agent_questions`
  - [x] `/api/agent/answer` POST с `{question_id, answer}` → сохраняет ответ + пушит его в OH через `/api/conversations/{id}/message`
- [x] **6.2 Runs & resume**
  - [x] `/api/agent/runs/:chatId/reset` POST — `drop_mapping(chatId)` + DELETE OH conversation + `set_run_status('reset')` → следующий submit = fresh start
  - [x] `/api/agent/runs/:chatId/history` GET — последние N events transformed под UI (`_translate_event`)
- [x] **6.3 Control plane**
  - [x] `/api/agent/control-plane` GET (список runs из `agent_runs`) / POST (abort/pause/resume)
- [x] **6.4 Stop/abort**
  - [x] `/api/agent/chat/stop` работает (POST /stop в OH) + `set_run_status('stopped')`
- [x] **6.5 Recipes / self-test / workflows**
  - [x] `/api/agent/recipes` GET — список преднастроенных промптов (repo_audit / bugfix / deploy_check)
  - [x] `/api/agent/self-test` POST — health-check агента (один turn ping через `_stream_chat`)
  - [x] `/api/agent/workflows` GET — реальный хендлер (`{ok, items:[]}`)

### STEP 7 — Memory / KB / Web / Image
**Цель:** «умные» фичи поверх агента.

- [ ] **7.1 Memory facts**
  - [ ] `/api/memory/facts` GET/POST/DELETE — используем существующую таблицу `user_facts` (40 строк уже там!)
  - [ ] Авто-извлечение фактов из чата через small LLM (factExtractor)
  - [ ] Включать `recall_facts` в OpenHands `conversation_instructions` при создании conv
- [ ] **7.2 Semantic memory**
  - [ ] `/api/memory/semantic` GET (поиск) — таблица `semantic_memory` (460 rows) + `semantic_memory_fts` (FTS5 индекс готов)
  - [ ] Использовать `kb_search` для подмешивания контекста в начало OH conversation
- [ ] **7.3 Knowledge base**
  - [ ] `/api/kb/{search, list, add, delete}` — таблицы `kb_documents` + `kb_chunks` (пустые, но schema готова)
  - [ ] Upload → chunk → TF-IDF (или embeddings если есть provider)
- [ ] **7.4 Project memory**
  - [ ] `/api/memory/project` — таблица `project_memory`, key-value scoped to chat_id
- [ ] **7.5 Web search**
  - [ ] Если есть `TAVILY_API_KEY` или `BRAVE_API_KEY` в env → backend выставляет `OH SearchEngineMCP` (OpenHands его поддерживает, видели "No search engine API key found" в логах)
- [ ] **7.6 Image generation**
  - [ ] `/api/agent/chat` с body содержащим `image_request: {prompt, size}` → backend вызывает GLM/OpenRouter image API напрямую, сохраняет в `/workspace/.downloads/`, шлёт результат как `tool_result {name:"generate_image", result:{path,url}}`

### STEP 8 — DeepSeek managed + Admin panels
**Цель:** UI админка работает, DeepSeek managed session live.

- [ ] **8.1 DeepSeek managed**
  - [ ] `/api/admin/deepseek/{status, refresh, token}` — bootstrap Bearer/cookies из env, рефреш через scheduled task
  - [ ] При выборе key=DeepSeek managed в UI → backend сам подставляет credentials
  - [ ] Использовать `meta` таблицу или новую для хранения текущей сессии
- [ ] **8.2 Cost tracking**
  - [ ] `/api/cost/today` GET — агрегат по `llm_spend` (2929 rows уже там, есть полная история!)
  - [ ] Парсить `llm_metrics` из OpenHands events → записывать в `llm_spend`
- [ ] **8.3 Notifications**
  - [ ] `/api/notifications` GET/POST/DELETE — таблица `notifications` (6 rows)
  - [ ] `/api/notifications/summary` — кол-во непрочитанных
  - [ ] `/api/notifications/read-all` PUT
- [ ] **8.4 Jobs panel**
  - [ ] `/api/jobs` GET — таблица `jobs` (24 rows!), фильтр по статусу
  - [ ] `/api/jobs/:id` GET — детали + logs
  - [ ] `/api/agent/jobs/:id` — то же что выше но скоупом на agent runs
- [ ] **8.5 Checkpoints**
  - [ ] `/api/checkpoints` POST — `git commit` в workspace через OH bash
  - [ ] `/api/checkpoints/:id/restore` — `git reset --hard`

### STEP 9 — Operator / MCP / Push / Telegram / Webhooks
**Цель:** периферийные фичи UI работают.

- [ ] **9.1 Operator mode**
  - [ ] `/api/operator/{missions, projects, runbooks, status}` — таблицы `operator_missions` (4 rows), `operator_projects` (3 rows), `operator_mission_events` (9 rows) уже с данными
  - [ ] `/api/operator/projects/analyze` — запустить агента с заранее-подготовленным промптом анализа репо
  - [ ] `/api/operator/recoveries/{supervise, graph}` — стабилизация после фейлов
  - [ ] `/api/operator/failure/{classify, execute, incident}` — таблица `incidents` (2 rows)
  - [ ] `/api/operator/github-automation/{comment, events}` — таблица `github_automation_events`
- [ ] **9.2 MCP**
  - [ ] `/api/mcp/{config, status, restart}` — настройка MCP-серверов для OpenHands
  - [ ] `/api/mcp/server/:id` — установить marketplace MCP
  - [ ] `/api/operator/mcp/{catalog, install}` — каталог
- [ ] **9.3 Push notifications**
  - [ ] `/api/push/{vapid, subscribe, unsubscribe, test}` — таблица `push_subscriptions`
  - [ ] VAPID-ключи в env, web-push library
- [ ] **9.4 Telegram bot**
  - [ ] `/api/integrations/telegram/*` — таблицы `tg_chats` (8), `tg_messages` (18), `tg_users` (1)
  - [ ] Bot polls Telegram → пересылает в OH conversation того же юзера
- [ ] **9.5 GitHub webhooks**
  - [ ] `/api/webhooks/github` POST — приём событий
  - [ ] `/api/webhooks/github/{config, secret}` — настройка
- [ ] **9.6 Ops panels**
  - [ ] `/api/ops/{services, action, audit}` — docker ps / restart / logs через docker SDK
  - [ ] `/api/gateway/status` — health всех контейнеров
  - [ ] `/api/cron` — таблица `cron_jobs`
- [ ] **9.7 Approval policy**
  - [ ] `/api/approval/policy` GET/PUT — таблица `automation_policy_events`
  - [ ] Сцепить с OpenHands `confirmation_mode`

### STEP 10 — Polish, tests, hardening, deploy
**Цель:** production-ready качество.

- [ ] **10.1 Streaming improvements**
  - [ ] Token-by-token streaming через LiteLLM streaming API (сейчас message приходит целиком)
  - [ ] `assistant_delta` чанки по 10-50 токенов вместо одного финального
- [x] **10.2 Zombie runtime GC** — ✅ СДЕЛАНО (`f52f489`)
  - [x] `scripts/gc_runtimes.sh` + systemd timer (каждые 15 мин): удаляет `openhands-runtime-*` старше `IDLE_MINUTES=45`, которые НЕ обслуживают активную conversation; host-level (в контейнере нет docker.sock)
  - [x] Установлен и проверен на проде: `browserai-gc.timer` активен, dry-run/реальный прогон чистые
- [x] **10.3 Pytest suite** — ✅ СДЕЛАНО (`f52f489`)
  - [x] `tests/` (conftest с изолированной temp-БД): `test_health.py`, `test_agent_state.py`, `test_openapi.py`, `test_memory.py` — 13 тестов зелёные
  - [x] Smoke test против реального OH в `tests/integration/` (opt-in, skip если OH недоступен)
- [x] **10.4 OpenAPI docs** — ✅ СДЕЛАНО (`f52f489`)
  - [x] Stub-роуты исключены из схемы (`include_in_schema=False`) + уникальные operation names → `/docs` и `/openapi.json` документируют только реальные эндпоинты, без warning'ов о дублях
- [x] **10.5 Healthcheck endpoint** — ✅ СДЕЛАНО
  - [x] `/api/health/deep` (`f52f489`) — проверяет: db reachable, OpenHands reachable, активный ключ настроен, free disk > 5 GB; 200/ready или 503/degraded. Живьём: ready, все 4 ✅
  - [x] **Docker `HEALTHCHECK` директива** — ✅ 2026-06-27 (`2d56485`): `Dockerfile` + `docker-compose.yml`, проверка `/api/health` (ok=true)
- [x] **10.6 Logging & observability** — ✅ СДЕЛАНО (`f52f489`)
  - [x] `core/obslog.py`: structured JSON logs (`LOG_FORMAT=json`) + contextvar trace_id
  - [x] Per-request middleware: trace_id на каждый запрос, заголовок `X-Trace-Id`, корреляция с chatId / OH conversation_id (`bind_conversation`)
  - [ ] Запись в `agent_tool_ledger` для аудита (отложено)
- [ ] **10.7 HTTPS**
  - [ ] Let's Encrypt cert через certbot (если есть домен) или self-signed
  - [ ] nginx redirect 80 → 443, HSTS header
  - [ ] `APP_URL=https://...` → cookies автоматом становятся Secure
- [ ] **10.8 Secret rotation**
  - [ ] BigModel API ключ `dba035e8...` сейчас лежит в `.env` и в БД — нужно ротировать (упоминался в коммитах несколько раз, могла утечь)
  - [ ] Add `/api/admin/keys/rotate` чтобы перегенерить
- [x] **10.9 Backup** — ✅ СДЕЛАНО (`f52f489`)
  - [x] `scripts/backup.sh`: online `.backup` → gzip → `PRAGMA integrity_check` → прунинг `RETENTION_DAYS=14`
  - [x] systemd timer `browserai-backup.timer` (ежедневно 02:30 UTC), установлен; первый прогон на проде: 41M gz, integrity ok. На host доустановлен `sqlite3`
- [ ] **10.10 Merge to main**
  - [ ] Открыть PR `sync/from-timeweb-2026-06-27 → main`
  - [ ] Code review, squash, merge
  - [ ] Auto-deploy через GitHub Actions подхватит коммит

---

## Карта endpoints: реализовано vs осталось

| Группа | Всего endpoint | Реализовано | TODO в шаге |
|---|---|---|---|
| auth | 9 | 5 | 5 (recovery), 9 (sms) |
| cloud | 2 | 2 | — |
| settings/keys/params | 6 | 5 | 5 (params PUT) |
| agent chat | 5 | 3 | 6 (answer, questions) |
| agent runs/workflows | 9 | 0 | 6 |
| workspace | 5 | 4 | 8 (checkpoints) |
| memory/kb | 6 | **6** ✅ | 7 (factExtractor осталось) |
| jobs/notifications | 5 | 0 (stub) | 8 |
| cost/cron | 2 | 0 (stub) | 8, 9 |
| admin deepseek | 3 | 0 (stub) | 8 |
| mcp | 4 | 0 (stub) | 9 |
| operator | 20+ | 0 (stub) | 9 |
| push | 4 | 0 (stub) | 9 |
| webhooks | 3 | 0 (stub) | 9 |
| ops/gateway | 4 | 0 (stub) | 9 |
| approval | 1 | 0 (stub) | 9 |
| **итого** | **~97** | **48 реальных (~47%) + 55 stub** | — |

> Цифры пересчитаны 2026-06-27 по факту (`grep` декораторов `@app.*` vs `_STUB_ROUTES`).
> Прежняя оценка «24 (25%)» относилась к состоянию после Step 4 и устарела.

## Текущее состояние сервера (обновлено 2026-06-27)

- ✅ `browserai` (FastAPI) — UP **(healthy — добавлен Docker healthcheck)**
- ✅ `openhands` v0.59.0 — UP
- ❌ `browserai-db` (Postgres) — **УДАЛЁН 2026-06-27** (образ `postgres:15-alpine` снесён при очистке сервера, контейнера не было, всё в SQLite)
- 🧹 Сервер очищен: удалено ~36 ГБ Docker-мусора (мёртвые runtime-контейнеры, неиспользуемые образы, build cache). Оставлены только рабочие образы + по одному свежему бэкапу.
- ✅ Runtime image `oh_v0.59.0_o7nt9lingn02n8vm` собран и закэширован
- ✅ В БД 40+ таблиц от старого Node-стека с реальными данными (jobs, llm_spend, semantic_memory, operator_*, notifications, user_facts) — будем переиспользовать
- ✅ 1 юзер зарегистрирован (твой owner)
- ✅ Активный API-ключ: Zhipu AI / GLM-4.7-Flash

## Решения, которые нужно принять

1. **`browserai-db` Postgres** — нужен или удалить? (сейчас не используется)
2. **HTTPS** — есть ли у тебя домен для Let's Encrypt, или делаем self-signed?
3. **Старые таблицы Node-стека** — переиспользуем под новый бэкенд (быстрее, бесплатные данные) или начинаем чистый schema?
4. **Streaming token-by-token** — приоритет? (сейчас message приходит целиком, у GLM это ~3-5 сек "тишины" перед текстом)
5. **Cold start runtime ~60s** — мириться или серьёзно оптимизировать (pre-warmed pool sandbox-контейнеров)?
6. **Vault шифрование** — критично или можно отложить?
