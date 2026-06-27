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

## STEP 1 — Audit & Baseline → 🟡 ЧАСТИЧНО (2 из 3 подпунктов подтверждены)

| Подпункт плана | Факт | Доказательство |
|---|---|---|
| Инвентаризация 97 endpoint UI | ✅ да, точно | `grep -roE "/api/[...]" ui/src \| sort -u \| wc -l` = **ровно 97** уникальных путей, что UI реально вызывает. Цифра из плана воспроизводится 1-в-1. Дополнительно `route_policy_inventory.md` фиксирует политику доступа по группам маршрутов |
| 8 архитектурных разрывов / файл `01-audit.md` | ❌ нет | Файла `01-audit.md` в репо нет. Фраза «8 разрывов / architectural gaps» не встречается ни в одном `.md` (проверено grep по всему `docs/`). Есть `docs/roadmap/baseline-audit-2026-06-22.md`, но он про **старый Node-стек** (`server/agentLoop.js`), не про текущий Python-монолит |
| Зафиксирован API-контракт UI | 🟩 да | Контракт зашит в исполняемый код: `_resolve_provider()` (body-поля UI), `_translate_event()` (полный SSE wire-формат OpenHands v0.59), `set_session_cookie()` (cookie-контракт) в `server.py`/`auth.py`. Отдельного `.md`-документа нет, но контракт реален и работает |

**Вывод:** Step 1 сделан на **2/3**. Главная работа выполнена и проверяема:
(1) инвентаризация — **97 путей подтверждены точным подсчётом** (а не «косвенно»);
(3) API-контракт — зафиксирован в коде. Не хватает только формального документа
**`01-audit.md` с «8 архитектурными разрывами»** — этого артефакта нет. Поэтому статус
«частично», а не «полностью». Кандидаты в те самые 8 разрывов фактически уже устранены
баг-фиксами Step 2 (WebSocket→HTTP polling, runtime image, DNS host-gateway, event wire
format, `<think>`-парсер, закрытие стрима по `awaiting_user_input` и др.) — их достаточно
оформить в `01-audit.md`, чтобы закрыть шаг до 🟢.

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

## STEP 6 — Agent interactive flow → 🟢 ГОТОВО (в main + прод)

✅ **РЕШЕНО (2026-06-27, commit `70a79a4`).** Уникальные step6-эндпоинты перенесены
в `core/server.py` напрямую (НЕ через `git merge` ветки `feat/step6-...` — её merge-base
устарел, и merge затёр бы Step 7/8/9). `core/agent_state.py` теперь импортируется,
`init_agent_state_schema()` вызывается на старте, а таблицы `agent_runs` + `agent_questions`
наполняются прямо из chat-стрима (`upsert_run`/`set_run_status`/`create_question`).

| Эндпоинт | В проде (`main`) | Живая проверка (прод) |
|---|---|---|
| `/api/agent/recipes` | ✅ реальный | 3 рецепта (repo_audit/bugfix/deploy_check) |
| `/api/agent/workflows` | ✅ реальный | `{ok:true, items:[]}` |
| `/api/agent/control-plane` GET | ✅ реальный | `{ok:true, runs:[], count:0}` |
| `/api/agent/control-plane` POST | ✅ реальный | abort/pause/resume → `set_run_status` |
| `/api/agent/questions` | ✅ реальный | `{ok:true, items:[]}` из `agent_questions` |
| `/api/agent/answer` | ✅ реальный | без `question_id` → **400** (валидация) |
| `/api/agent/runs/{id}/reset` | ✅ реальный | `{ok:true, reset:true}` + drop_mapping |
| `/api/agent/runs/{id}/history` | ✅ реальный | transformed events через `_translate_event` |
| `/api/agent/self-test` | ✅ реальный | SSE ping через `_stream_chat` |
| `core/agent_state.py` | ✅ импортируется + schema на старте | CRUD проверен (runs/questions) |

**Способ:** все 7 базовых путей исключены из `_STUB_ROUTES` через `_REAL_NOW`.
Контейнер `browserai` healthy после деплоя.

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
| 10.1 streaming | 🟢 **сделано** (`3262460`): сервер ре-чанкит ответ в мелкие `assistant_delta` по словам с pacing (OH token-stream не отдаёт); проверено на проде, lossless |
| 10.2 zombie runtime GC | 🟢 **сделано** (`f52f489`): `gc_runtimes.sh` + `browserai-gc.timer` (15 мин), проверено на проде |
| 10.3 pytest suite | 🟢 **сделано** (`f52f489`): `tests/` 13 зелёных + opt-in `tests/integration/` |
| 10.4 OpenAPI docs | 🟢 **сделано** (`f52f489`): stub'ы вне схемы, `/docs`+`/openapi.json` чистые, без warning'ов |
| 10.5 Docker HEALTHCHECK + /api/health/deep | 🟢 **сделано** (`2d56485` + `f52f489`): deep-probe db/OH/key/disk, X-Trace-Id, ready на проде |
| 10.6 structured logging / trace_id | 🟢 **сделано** (`f52f489`): `core/obslog.py` JSON-логи + per-request trace_id + `X-Trace-Id` |
| 10.7 HTTPS / Let's Encrypt | 🔴 только HTTP :80 (домена нет — отложено) |
| 10.8 secret rotation / key UI | 🟢 **сделано** (`d717394`): UI «Ротация ключа» + `/api/keys/rotate`; новый ключ валидируется до замены, при failure старый не трогается; проверено на проде |
| 10.9 daily backup script | 🟢 **сделано** (`f52f489`): `backup.sh` (online .backup+gzip+integrity+prune) + `browserai-backup.timer` (02:30 UTC), проверено |
| 10.10 merge to main | ✅ step6/7/8/9 влиты в main (`70a79a4`) |

---

## Сводная таблица

| Step | План | Реально в проде (`main`) | Статус |
|---|---|---|---|
| 1 Audit | ✅ | 97 endpoint ✅ + контракт ✅; нет `01-audit.md` (2/3) | 🟡 ЧАСТИЧНО |
| 2 Chat | ✅ | весь код на месте | 🟢 ПОЛНОСТЬЮ |
| 3 Auth | ✅ | работает; миграция sessions не в коде | 🟩 ПОДТВЕРЖДЁН |
| 4 Conv+Workspace | ✅ | работает; метрики не перепроверены | 🟩 ПОДТВЕРЖДЁН |
| 5 Provider+Vault | ✅ | работает; нет `05-step5-done.md` | 🟩 ПОДТВЕРЖДЁН |
| 6 Interactive | ✅ | questions/answer/runs/control-plane/recipes/self-test/workflows на реальных хендлерах (`70a79a4`) | 🟢 ПОЛНОСТЬЮ |
| 7 Memory/KB/Web/Image | ✅ | memory/KB/web ✅, image=реальный images API+fallback, factExtractor ✅ (`70b4f08`) | 🟩 ПОДТВЕРЖДЁН |
| 8 Jobs/Cost/… | ✅ | jobs/cost/notifications на реальных данных БД (`cc3a6f2`); остаток: deepseek/checkpoints | 🟩 ПОДТВЕРЖДЁН |
| 9 Operator/MCP/… | ✅ | operator/incidents/gateway на реальных данных (`e3cfaa6`) | 🟩 ПОДТВЕРЖДЁН |
| 10 Polish/Tests | ✅ | deep-health/logs+trace_id/GC/backup/pytest/OpenAPI готовы (`f52f489`); осталось streaming(10.1)+HTTPS(10.7, нет домена)+key-UI(10.8) | 🟩 БЕЗОПАСНЫЙ БЛОК ГОТОВ |

## Что нужно доделать по каждому шагу (чтобы закрыть до «полностью»)

- **Step 1:** написать `01-audit.md` под текущий Python-монолит (или переименовать/обновить baseline).
- **Step 3:** зашить миграцию старой `sessions`-схемы в `init_auth_schema()` (идемпотентность деплоя).
- **Step 4:** прогнать живой e2e и зафиксировать актуальные метрики reuse.
- **Step 5:** добавить `05-step5-done.md` (или убрать ссылку из плана).
- **Step 6:** ✅ ВЫПОЛНЕНО (`70a79a4`) — step6-эндпоинты перенесены в main напрямую, `agent_state.py` подключён, таблицы наполняются из chat-стрима. Остаток: web-socket control-plane (необяз.).
- **Step 7:** ✅ ВЫПОЛНЕНО (`70b4f08`) — реальный images API (cogview-3/dall-e-3) + graceful fallback, эвристический factExtractor. Остаток: web-search оставлен на Brave/DDG (не MCP); KB-таблицы пустые.
- **Step 8–9:** ✅ ВЫПОЛНЕНО (`cc3a6f2`, `e3cfaa6`) — jobs/cost/notifications/operator/incidents/gateway на реальных данных БД. Остаток Step 8: `/api/admin/deepseek/*`, `/api/checkpoints`.
- **Step 10:** добавить `tests/`, token-streaming, zombie-GC, HTTPS, ротацию секретов, backup-скрипт.
