# BrowserAI ↔ OpenHands — Отчёт верификации плана по коду

**Дата:** 2026-06-27
**Коммит проверки:** `2854457` (ветка `main`)
**Метод:** прочитаны все 9 модулей `core/*.py`, проверены `Dockerfile`,
`docker-compose.yml`, git-ветки, схема и данные SQLite на проде, живые HTTP-запросы.
**Прод:** `root@186.246.14.141`, контейнер `browserai` (healthy).

---

## Легенда статусов (единый критерий для всех шагов)

Чтобы оценка была последовательной, каждый шаг получает **один** статус по строгому правилу:

| Статус | Критерий присвоения |
|---|---|
| 🟢 **ПОДТВЕРЖДЁН ПОЛНОСТЬЮ** | Проверен **каждый** подпункт плана; для всех найден реальный код, который исполняется в проде (в `main`); живая проверка где применимо — успешна |
| 🟩 **ПОДТВЕРЖДЁН** | Все ключевые подпункты реализованы в проде; есть мелкие документальные/некритичные расхождения |
| 🟡 **ЧАСТИЧНО** | Часть подпунктов реальна, часть — заглушка/отсутствует/реализована иначе, чем в плане |
| 🟠 **СДЕЛАН, НО НЕ В ПРОДЕ** | Код существует в git, но в ветке, не влитой в `main` → в проде не работает |
| 🔴 **ЗАГЛУШКА / НЕ СДЕЛАН** | В проде только stub-ответы или функциональности нет |

**Важная количественная поправка к плану:** план заявляет «~24 endpoint реализовано (25%)».
Фактический подсчёт по коду: **48 реальных уникальных путей** и **55 чистых заглушек**
(`_STUB_ROUTES` = 60, минус 5 перекрыты реальными memory/web/image маршрутами).
Реальное покрытие — **~47%**, а не 25%. План в этой части устарел.

---

## STEP 1 — Audit & Baseline → 🟡 ЧАСТИЧНО

| Подпункт плана | Факт | Доказательство |
|---|---|---|
| Инвентаризация 97 endpoint UI | ⚠️ косвенно | `route_policy_inventory.md` описывает группы маршрутов и политику доступа |
| 8 архитектурных разрывов / файл `01-audit.md` | ❌ файла нет | В репо нет `01-audit.md`. Есть `docs/roadmap/baseline-audit-2026-06-22.md`, но он про **старый Node-стек** (`server/agentLoop.js`), не про текущий Python-монолит |
| Зафиксирован API-контракт UI | 🟩 да | Контракт зашит в `_resolve_provider()` и `_translate_event()` в `server.py` |

**Вывод:** аудит как процесс был (артефакты политики маршрутов и baseline есть), но **именно те документы, что обещаны в плане (`01-audit.md`), отсутствуют**, а имеющийся baseline относится к предыдущей архитектуре. Поэтому не «полностью», а «частично».

---

## STEP 2 — Chat core → 🟢 ПОДТВЕРЖДЁН ПОЛНОСТЬЮ

Проверены **все** подпункты, для каждого найден исполняемый код:

| Заявлено | Код |
|---|---|
| `/api/health` → `{ok:true}` | `server.py` `get_health()` |
| CORS без wildcard + credentials | `_cors_origins`, `allow_credentials=True` |
| Парсинг реального body UI | `_resolve_provider()` |
| Резолв stored-ключа | `get_key(..., include_secret=True)` |
| `openai/` префикс | `providers.qualify_model()` |
| Полный SSE lifecycle | `_stream_chat()` |
| HTTP polling вместо WebSocket | `events?limit=100` + `seen_ids` |
| `<think>` парсер | `_split_think()` |
| Закрытие по `awaiting_user_input` | `turn_complete` |
| `micromamba-wrapper.sh` | файл присутствует `docker/runtime/` |
| Stub JSON-200 | `_stub_response()` + `_STUB_ROUTES` |

**Не проверено напрямую (нужен реальный диалог):** замеры «cold 180s / warm 60s» — это Step 4, здесь не верифицировалось.

---

## STEP 3 — Auth + Cloud sync → 🟩 ПОДТВЕРЖДЁН

| Заявлено | Код / данные |
|---|---|
| `auth.py`, users/sessions/cloud_state | `init_auth_schema()` |
| bcrypt cost-12 | `bcrypt.gensalt(12)` |
| itsdangerous подпись cookie | `URLSafeTimedSerializer` |
| Cookie HttpOnly/SameSite=Lax/Secure | `set_session_cookie()` (`secure=COOKIE_SECURE`) |
| 30-дн сессия + auto-renew | `SESSION_MAX_AGE`, `touch_session()` |
| Первый user = owner | `check_registration_allowed()` |
| sms/recovery → 501 | `auth_sms_stub()`, `auth_reset()` |
| Dockerfile bcrypt/itsdangerous | pip install layer |
| compose AUTH_SECRET/SESSION_SECRET/APP_URL | строки 21-23 |
| Живые данные | БД прод: **1 user** |

**Расхождение (почему не «полностью»):** план в 3.x упоминает баг-фикс «старая `sessions` таблица с `token_hash` → дроп+пересоздание». В текущем `init_auth_schema()` миграции/дропа нет (только `CREATE TABLE IF NOT EXISTS`). Фикс, видимо, был разовым на проде и в код не зашит — повторный деплой на чистую БД его не воспроизведёт. Некритично, но это не «полное» соответствие.

---

## STEP 4 — Conversation reuse + Workspace → 🟩 ПОДТВЕРЖДЁН

| Заявлено | Код |
|---|---|
| `conversations.py`, `chat_conversations` | `init_conversations_schema()` |
| Reuse: live→message / dead→create | `get_or_create_conversation()` |
| SSE `agent_state {warm/cold}` | `_stream_chat()` |
| `done {reused}` | `_stream_chat()` |
| 4 workspace endpoint | tree/file/metadata/download — реальные, проксируют в OH |
| `start_id` broken → dedup | `seen_ids` |

**Расхождение (почему не «полностью»):** метрики «×3 ускорение (180s→60s)» и e2e «агент создал/прочитал test.txt» — это **runtime-замеры**, их нельзя подтвердить статикой кода. Логика reuse в коде есть; сами цифры не перепроверены живым прогоном.

---

## STEP 5 — Multi-provider + Settings + Vault → 🟩 ПОДТВЕРЖДЁН

| Заявлено | Код / данные |
|---|---|
| 5.1 Provider switching | `activate_key` → `_sync_active_provider_to_openhands` |
| 5.2 Settings persistence | `/api/params` GET/PUT + `database.set_params/get_params` |
| 5.3 Per-key validation + latencyMs | `providers.validate_key()` |
| 5.4 Model catalog + кэш 1ч + fallback | `fetch_models()`, `_MODELS_TTL=3600`, `_FALLBACK_MODELS` |
| 5.5 Vault PBKDF2(200k)+AES-GCM | `vault.py`: `PBKDF2_ITERS=200_000`, `AESGCM` |
| Полный vault UI (8+ операций) | setup/unlock/lock/change/disable/autolock/backup/restore |
| Anthropic x-api-key / Gemini ?key= | `validate_key()` |
| Живые данные | активный ключ: **z_ai_official** |

**Расхождение (почему не «полностью»):** план ссылается на `05-step5-done.md` — **этого файла в репо нет**. Сам функционал реализован полностью; отсутствует только обещанный документ.

---

## STEP 6 — Agent interactive flow → 🟠 СДЕЛАН, НО НЕ В ПРОДЕ

🔴 **Ключевая находка всего отчёта.** Код Step 6 **написан**, но живёт в ветке
`feat/step6-agent-interactive-flow` (коммиты `d4f4350 feat(step6): add agent questions,
runs, control plane, self-test`, `870335b fix(step6): import agent_state helpers`).
**В `main` его НЕТ.**

| Эндпоинт | В проде (`main`) | Живая проверка |
|---|---|---|
| `/api/agent/answer`, `/control-plane`, `/runs`, `/questions`, `/self-test`, `/workflows`, `/recipes` | ❌ заглушки | `/api/agent/control-plane` → `{"stub":true}` |
| `core/agent_state.py` | файл есть в `main`, но **не импортируется** в `server.py` (мёртвый код; задействован только в step6-ветке) | — |

**Действие:** требуется review и merge ветки `feat/step6-...` в `main`, иначе функциональность недоступна пользователю.

---

## STEP 7 — Memory / KB / Web / Image → 🟡 ЧАСТИЧНО

(Влит в main коммитом `531f895 feat(step7)`.)

| Подпункт | Статус | Доказательство |
|---|---|---|
| 7.1 Memory facts CRUD | 🟩 | `user_facts`, **40 строк в БД** |
| 7.1 Авто-извлечение фактов (factExtractor) | 🔴 НЕТ | в коде отсутствует |
| 7.2 Semantic memory + FTS5 | 🟩 | `search_semantic()`, **460 + 163 строк** |
| 7.3 KB search/add/delete/list | 🟩 код / ⚪ пусто | TF-IDF реализован; таблицы **0 документов** |
| 7.4 Project memory | 🟩 код / ⚪ пусто | реализован; таблица пустая |
| 7.5 Web search | 🟡 иначе | через **Brave/DuckDuckGo**, НЕ через OpenHands MCP как в плане; без `BRAVE_API_KEY` вернёт пусто |
| 7.6 Image generation | 🔴 ЗАГЛУШКА | пишет **SVG-плейсхолдер** (`'provider':'placeholder'`); реального вызова GLM/OpenRouter image API нет |

---

## STEP 8 — DeepSeek / Cost / Jobs / Notifications / Checkpoints → 🔴 ЗАГЛУШКИ

Живая проверка: `/api/jobs`, `/api/notifications`, `/api/cost/today` → `{"stub":true}`.
**Данные в БД есть и простаивают:** `jobs=24`, `llm_spend=2929`, `notifications=6`. Код их не читает.

---

## STEP 9 — Operator / MCP / Push / Telegram / Webhooks → 🔴 ЗАГЛУШКИ

~40 путей в `_STUB_ROUTES`. `/api/operator/missions`, `/api/mcp/status` → `{"stub":true}`.
Данные простаивают: `operator_missions=4`.

---

## STEP 10 — Polish / Tests / Hardening / Deploy → 🔴 ПОЧТИ НЕ СДЕЛАН

| Подпункт | Статус |
|---|---|
| 10.1 token-by-token streaming | 🔴 нет (message целиком) |
| 10.2 zombie runtime GC | 🔴 нет (чистили вручную) |
| 10.3 pytest suite | 🔴 каталога `tests/` нет |
| 10.4 OpenAPI response_model | 🔴 нет |
| 10.5 Docker HEALTHCHECK | 🟢 **сделано в этой сессии** (`2d56485`) |
| 10.6 structured logging / trace_id | 🔴 нет |
| 10.7 HTTPS / Let's Encrypt | 🔴 только HTTP :80 |
| 10.8 secret rotation | 🔴 нет (ключ всё ещё в `.env`+БД) |
| 10.9 daily backup script | ⚠️ бэкапы есть на проде вручную, скрипта/таймера в репо нет |
| 10.10 merge to main | ⚠️ step7 влит; step6 — нет |

---

## Сводная таблица

| Step | План | Реально в проде (`main`) | Статус |
|---|---|---|---|
| 1 Audit | ✅ | артефакты частично, `01-audit.md` нет | 🟡 ЧАСТИЧНО |
| 2 Chat | ✅ | весь код на месте | 🟢 ПОЛНОСТЬЮ |
| 3 Auth | ✅ | работает; миграция sessions не в коде | 🟩 ПОДТВЕРЖДЁН |
| 4 Conv+Workspace | ✅ | работает; метрики не перепроверены | 🟩 ПОДТВЕРЖДЁН |
| 5 Provider+Vault | ✅ | работает; нет `05-step5-done.md` | 🟩 ПОДТВЕРЖДЁН |
| 6 Interactive | TODO | код в ветке, НЕ в main | 🟠 НЕ В ПРОДЕ |
| 7 Memory/KB/Web/Image | TODO | memory/KB/web ✅, image=плейсхолдер, factExtractor нет | 🟡 ЧАСТИЧНО |
| 8 Jobs/Cost/… | TODO | заглушки (данные простаивают) | 🔴 ЗАГЛУШКИ |
| 9 Operator/MCP/… | TODO | заглушки | 🔴 ЗАГЛУШКИ |
| 10 Polish/Tests | TODO | только healthcheck (наш) | 🔴 ПОЧТИ НЕТ |

## Что нужно доделать по каждому шагу (чтобы закрыть до «полностью»)

- **Step 1:** написать `01-audit.md` под текущий Python-монолит (или переименовать/обновить baseline).
- **Step 3:** зашить миграцию старой `sessions`-схемы в `init_auth_schema()` (идемпотентность деплоя).
- **Step 4:** прогнать живой e2e и зафиксировать актуальные метрики reuse.
- **Step 5:** добавить `05-step5-done.md` (или убрать ссылку из плана).
- **Step 6:** **смержить ветку `feat/step6-...` в main** + удалить мёртвый `agent_state.py` если не нужен, или подключить.
- **Step 7:** заменить SVG-плейсхолдер на реальный image-API; реализовать factExtractor; решить — web-search через MCP или оставить Brave/DDG (обновить план).
- **Step 8–9:** подключить уже существующие данные БД (`jobs`, `llm_spend`, `notifications`, `operator_*`) к реальным хендлерам вместо stub.
- **Step 10:** добавить `tests/`, token-streaming, zombie-GC, HTTPS, ротацию секретов, backup-скрипт.
