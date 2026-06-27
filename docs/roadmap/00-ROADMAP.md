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

### STEP 7 — Memory / KB / Web / Image — 🟩 ПОДТВЕРЖДЁН (commit `70b4f08`)
- [x] **7.1 Memory facts CRUD + auto factExtractor** — `user_facts`, эвристический RU/EN extractor из `/api/agent/chat`
- [x] **7.2 Semantic memory + FTS5** — `search_semantic()` по `semantic_memory`/FTS5
- [x] **7.3 Knowledge base** — `/api/kb/{search,list,add,delete}` (schema готова; таблицы пока пустые)
- [x] **7.4 Project memory** — `/api/memory/project`, scoped to `chat_id`
- [x] **7.5 Web search** — Brave/DuckDuckGo fallback (не OpenHands MCP; принято как реализация)
- [x] **7.6 Image generation** — реальный OpenAI-compatible images API (`/images/generations`, CogView/OpenAI/OpenRouter) + graceful `no_image_provider`

---

## 🚧 Ограничения / остатки (не блокируют prod)

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

### STEP 7 — Memory / KB / Web / Image — 🟩 ПОДТВЕРЖДЁН
**Цель:** «умные» фичи поверх агента.

- [x] **7.1 Memory facts**
  - [x] `/api/memory/facts` GET/POST/DELETE — `user_facts`
  - [x] Авто-извлечение фактов из чата (`extract_facts`, RU/EN эвристики без LLM)
  - [x] Facts/semantic/project endpoints исключены из stub'ов и проверены
- [x] **7.2 Semantic memory** — `/api/memory/semantic` по `semantic_memory` + FTS5
- [x] **7.3 Knowledge base** — `/api/kb/{search,list,add,delete}`; таблицы готовы, данные можно наполнять через UI/API
- [x] **7.4 Project memory** — `/api/memory/project`, key-value scoped to chat_id
- [x] **7.5 Web search** — `/api/web/search`, Brave при ключе + DuckDuckGo fallback
- [x] **7.6 Image generation** — `/api/image/generate`, реальный OpenAI-compatible image API + graceful fallback без ключа

### STEP 8 — DeepSeek managed + Admin panels — 🟩 ПОДТВЕРЖДЁН
**Цель:** UI админка работает, существующие данные БД видны.

- [x] **8.1 DeepSeek managed diagnostics**
  - [x] `/api/admin/deepseek/{status, refresh, token}` — реальные diagnostic endpoints: session-file status, token never exposed, refresh unsupported без интерактивного bootstrap
- [x] **8.2 Cost tracking** — `/api/cost/today` агрегирует `llm_spend` (2929 rows на момент проверки)
- [x] **8.3 Notifications** — `/api/notifications`, `/summary`, `/read-all` на реальной таблице `notifications`
- [x] **8.4 Jobs panel** — `/api/jobs`, `/api/jobs/{id}` на реальной таблице `jobs`
- [x] **8.5 Checkpoints metadata**
  - [x] `/api/checkpoints` POST + `/api/checkpoints/{chatId}` GET совместимы с legacy schema
  - [~] `/api/checkpoints/{chatId}/restore` возвращает честный `restore_not_available`: для restore нужны OpenHands file_history snapshots/preimages, которых bridge пока не пишет

### STEP 9 — Operator / MCP / Push / Telegram / Webhooks — 🟩 БАЗОВЫЙ UI-КОНТРАКТ ГОТОВ
**Цель:** периферийные фичи UI не являются stub'ами и возвращают честные состояния.

- [x] **9.1 Operator mode** — `/api/operator/{missions,projects,status}`, `/api/incidents`, `/api/gateway/status` на реальных данных БД/health
- [x] **9.2 MCP**
  - [x] `/api/mcp/{config,status,restart}` + `/api/mcp/server/{name}` PUT/PATCH/DELETE — persistent JSON config в `/data/mcp_config.json`
  - [~] marketplace `/api/operator/mcp/{catalog,install}` остаётся advanced placeholder
- [x] **9.3 Push notifications**
  - [x] `/api/push/{vapid,subscribe,unsubscribe,test}` — подписки пишутся в SQLite; VAPID/web-push sender честно `not_configured`, если ключей нет
- [~] **9.4 Telegram bot** — не делали: нет bot token/требований в текущем prod-плане
- [x] **9.5 GitHub webhooks** — `/api/webhooks/github`, `/config`, `/secret`: приём и запись последнего события/config без stub
- [x] **9.6 Ops panels** — `/api/ops/{services,action,audit}` + `/api/gateway/status`: реальные health/diagnostic responses
- [x] **9.7 Approval policy** — `/api/approval/policy` GET/POST, persistent `app_kv`

### STEP 10 — Polish, tests, hardening, deploy
**Цель:** production-ready качество.

- [x] **10.1 Streaming improvements** — ✅ СДЕЛАНО (`3262460`)
  - [x] OpenHands event API отдаёт ответ целиком (нет token-stream), поэтому ре-чанкинг на сервере: сообщение режется на мелкие `assistant_delta` по словам с лёгким pacing (typewriter). UI уже буферит deltas → чистое улучшение восприятия
  - [x] Tunable через env: `BROWSERAI_STREAM_RECHUNK` (вкл/выкл), `STREAM_CHUNK_CHARS=24`, `STREAM_CHUNK_DELAY=0.02`, `STREAM_RECHUNK_MIN=48`
  - [x] Проверено на проде: ответ из 1 предложения пришёл 3-6 чанками по границам слов + финальный `assistant`; lossless; 17 тестов зелёные
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
  - [x] Запись `tool_start`/`tool_result` в `agent_tool_ledger` для аудита (`ec5aeb6+`)
- [ ] **10.7 HTTPS**
  - [ ] Let's Encrypt cert через certbot (если есть домен) или self-signed
  - [ ] nginx redirect 80 → 443, HSTS header
  - [ ] `APP_URL=https://...` → cookies автоматом становятся Secure
- [x] **10.8 Secret rotation / Key UI** — ✅ СДЕЛАНО (`d717394`)
  - [x] UI: в Settings → Keys добавлен блок **«Ротация ключа»** для активного ключа: ввести новый секрет → **«Проверить и заменить»**
  - [x] Backend: `/api/keys/rotate` — сначала реальный `validate_key` (1-token probe), и только при успехе перезаписывает старый секрет тем же `keyId`, делает ключ active и пушит настройки в OpenHands
  - [x] Безопасность: если проверка нового ключа падает (401/403/любая ошибка), старый ключ НЕ трогается. Проверено на проде плохим ключом → `stage=validate`, deep-health после этого `ready`
  - [x] Тесты: `tests/test_key_rotation.py`; всего 20 тестов зелёные
- [x] **10.9 Backup** — ✅ СДЕЛАНО (`f52f489`)
  - [x] `scripts/backup.sh`: online `.backup` → gzip → `PRAGMA integrity_check` → прунинг `RETENTION_DAYS=14`
  - [x] systemd timer `browserai-backup.timer` (ежедневно 02:30 UTC), установлен; первый прогон на проде: 41M gz, integrity ok. На host доустановлен `sqlite3`
- [x] **10.10 Merge to main** — ✅ СДЕЛАНО
  - [x] Все Step 1–10 изменения идут напрямую в `main`; пуш выполняется с сервера через deploy key
  - [x] Прод `/opt/browserai` и GitHub `main` синхронизированы после каждого блока
  - [x] Auto-deploy GitHub Actions не используется в текущем Timeweb-потоке; фактический deploy: `docker compose build/up` на сервере

---

## Карта endpoints: реализовано vs осталось (актуально после `ec5aeb6`)

| Группа | Статус |
|---|---|
| auth/cloud/settings/keys/params | 🟩 real (кроме legacy recovery/sms stubs) |
| agent chat + interactive flow | 🟢 real: chat/stop/questions/answer/runs/control-plane/recipes/self-test/workflows |
| workspace + checkpoints | 🟩 real workspace + checkpoint metadata; restore честно `restore_not_available` без file_history snapshots |
| memory/kb/web/image | 🟩 real |
| jobs/cost/notifications | 🟩 real DB-backed |
| admin deepseek | 🟩 real diagnostics (configured/status; token не раскрывается) |
| mcp | 🟩 real config/status/server CRUD; marketplace advanced placeholder |
| operator/incidents/gateway | 🟩 real read-side for existing DB + health; advanced automation placeholders остаются |
| push/webhooks/ops/approval | 🟩 real base handlers with honest `not_configured` where external credentials absent |
| **итого** | **40 formerly-stub bases promoted to real; 105 decorated FastAPI routes; remaining stubs are advanced/legacy placeholders, not core Step 1–10 blockers** |

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
