# BrowserAI — план рефакторинга «убрать дубли, укрепить стыки»

> Цель: устранить дублирующий слой состояния (на который указал разбор z.ai),
> **не переписывая** проект и **не ломая прод**. Двигаемся маленькими
> обратимыми шагами, каждый — с бэкапом БД и проверкой через self-test.
>
> v2: добавлены Этап 0.5 (явный список 🔴-багов), требование Mock OH,
> tenancy вынесен в самое начало, измеримые метрики. Учтены замечания
> code-review: план про архитектуру не ловил баги — теперь ловит.

---

## ✅ РЕШЕНИЕ ПО TENANCY: Single-tenant (принято)

Выбран single-tenant. Уточнено по данным с прода (3 юзера, 9 чатов,
папки почти пустые):
- **Per-chat папки `/workspace/chats/<id>/` ОСТАВЛЕНЫ** — это не multi-tenant
  изоляция, а защита проектов от взаимного перетирания файлов. Стоимость ~0.
- `_chat_workspace_instruction` **упрощён** — убраны multi-tenant формулировки
  («не лезь в чужой чат»), оставлено указание рабочей папки. (server.py)
- `isolation.py` — `ensure_openhands_config`/`ensure_sandbox_dir` ОСТАВЛЕНЫ
  (нужны для монтирования /workspace в OH). Не мёртвый код.
- Тестовый мусор: удалено 85 папок-сирот из `/workspace/chats` (без записи
  в `chat_conversations`); 9 реальных сохранены.

### ⏸ Отложено ДО Mock OH (осознанно, не вслепую):
- `_is_owner` / `user_id`-ветвление пронизывает ~десятки эндпоинтов (jobs,
  notifications, operator, cost). Это **главный** single-tenant выигрыш, но
  широкий и рискованный рефакторинг. Делать по одному эндпоинту ПОД тестами,
  иначе сломаем тихо (self-test ловит только LLM-pong). Соответствует
  принципу review: «инструмент (Mock OH) → потом рискованная чистка».

---

## Этап 0.5 — Закрыть критические баги (ДО чистки дубликатов)

Каждый баг = отдельный коммит + интеграционный тест с **Mock OH** (см. ниже).
Статусы сверены с реальным кодом репозитория.

| # | Баг | Где | Статус |
|---|-----|-----|:---:|
| 1.1 | Stop → `/chat/stop` вместо `/runs/{id}/reset` | `useChats.js:453` | ✅ сделано |
| 2.1 | Warm-start context fetch ДО `get_or_create` | `server.py:1643` | ✅ сделано |
| — | Idempotency guard через `turn_id` | `conversations.py:222` | ✅ сделано |
| 1.2 | `_locked_stream_chat` TOCTOU + нет таймаута на `acquire`. Фикс: `wait_for(lock.acquire(), 0.25)` + `acquired`-флаг | `server.py:2138` | ✅ сделано |
| 2.2 | `update_last_event(max_seen)` двигался даже при `done=False` → потеря событий. Фикс: `cursor = max_seen if done else last_seen_event_id` | `server.py:2096` | ✅ сделано |
| 3.1 | `ASK_USER:{...}` marker уходит в `assistant_delta` | `server.py:1387` | ❌ открыт |
| 3.2 | `/api/agent/answer` релеит ответ (проверить формат) | `server.py:2234` | ❌ открыт |
| 3.3 | `ask_user` эмитится mid-stream без координации со стримом | `server.py:1743` | ❌ открыт |
| 5.2 | `selectChat` не abort'ит активный стрим | `useChats.js` | ❌ открыт |
| 6.2 | Workspace isolation — решается через tenancy (см. блокер) | `isolation.py` | ⏸ зависит |

> Приоритет по дороговизне: **2.2 → 1.2 → 3.3 → 3.1/3.2 → 5.2**.

### Mock OpenHands — ✅ ГОТОВ (`tests/mock_openhands.py`, 206 строк, stdlib)
In-process HTTP-мок на `http.server` (без aiohttp-зависимости). Реализует
точный контракт, который BrowserAI потребляет:
`POST /api/conversations`, `GET /api/conversations/{cid}`,
`GET .../events?limit=N`, `POST .../message`, `POST .../stop`.
Программируемый: `push_event` / `finish` / `messages_for` / `stop_count`.

Тесты (`tests/integration/test_mock_openhands.py`, 8 шт, все зелёные):
- 3× fidelity (мок отвечает по контракту OH: id монотонны, finish-маркер);
- **Bug 2.2** — курсор уходит при `done=False` → `xfail(strict)` (загорится
  XPASS при фиксе server.py:2087);
- **Bug 4.2** — stop завершённого turn'а → `xfail(strict)`;
- idempotency — дубль `turn_id` шлёт prompt ровно один раз.

> `xfail(strict)` = регрессионная «ловушка»: когда баг чинится, тест становится
> XPASS и заставляет снять метку. Self-test (LLM-pong) такие баги НЕ ловит.

## Принципы
1. **OpenHands не трогаем.** Browser-tool, MCP, file-history, error-recovery,
   sandbox-runtime — это месяцы работы, которые он даёт бесплатно. Оставляем.
2. **OpenHands = источник правды** для всего, что он и так хранит (conversations,
   события, runtime, изоляция). BrowserAI перестаёт это дублировать.
3. **BrowserAI оставляет за собой только то, чего у OH нет:** auth, vault (ключи),
   биллинг/лимиты, провайдеры, UI-предпочтения, уведомления.
4. **Каждый шаг:** бэкап → правка → авто-миграция → self-test → коммит. Откат
   возможен в любой момент.

---

## Текущая карта состояния (по факту с сервера)

| Файл | CREATE TABLE | Назначение | Дубль OH? |
|------|:---:|------|:---:|
| `agent_state.py` | 5 | `agent_runs`, `agent_questions` (run-статусы, ask_user) | **частично** |
| `conversations.py` | 1 | маппинг `chat_id ↔ conversation_id` | **да** |
| `server.py` | 4 | прочее runtime-состояние | проверить |
| `auth.py` | 3 | users, sessions, password_resets | нет (нужно) |
| `database.py` | 3 | базовые kv/meta | нет (нужно) |

**Ключевые дубли, которые убираем:**
- `conversations.upsert_mapping()` — своя таблица соответствия, хотя OH сам
  знает свои conversations. → свести к тонкому кешу/вью.
- `agent_runs.last_*` — зеркалит состояние, которое OH отдаёт через
  `/api/conversations/<id>/events`. → оставить только то, что реально нужно UI.
- `isolation.py` `safe_chat_id` / `_chat_workspace_instruction` — косметика
  поверх реальной изоляции OH (`config.toml` bind). → упростить.

---

## Этап 0 — Страховка (СДЕЛАНО / поддерживаем)
- [x] Авто-миграция схемы — общий модуль `core/migrations.py`.
- [x] Подключено к `agent_state` (`agent_runs`, `agent_questions`).
- [x] **Расширено на `auth` (`users`, `sessions`, `cloud_state`) и
      `conversations` (`chat_conversations`)** — закрыт пробел из review.
- [x] Удалён мёртвый дубликат `core/ws_client.py` (не импортировался;
      живой — `core/bridge/ws_client.py`, `idle_timeout=30`).
- [x] Ежедневный бэкап БД (`browserai-backup.service`) + ретеншн 14д.
- [x] Self-test (`/api/agent/self-test`) как канарейка LLM-цепочки.
- [ ] `server.py` schema (4 CREATE TABLE) — подключить к миграциям.

## Этап 1 — Укрепить стыки (низкий риск, высокая отдача)
*Не убираем дубли пока — сначала делаем гибрид надёжным.*
1. Вынести `_migrate_missing_columns` в общий модуль (`core/migrations.py`),
   подключить к `auth`, `conversations`, `server` схемам.
2. Декларативно описать ожидаемые колонки всех таблиц.
3. Добавить smoke-тест миграций в CI (как уже сделан для `agent_runs`).
4. **Критерий готовности:** перезапуск на «старой» БД любой версии → схема
   сама догоняется, 0 ошибок «no column named».

## Этап 2 — Определить tenancy (продуктовое решение)
Развилка, от неё зависит объём Этапа 3:
- **A. Single-tenant** (инструмент для тебя/малой команды) → выкинуть имитацию
  multi-user: упростить `chats/<id>`, убрать `safe_chat_id`, один workspace.
  Архитектура приближается к thin-agent z.ai, но с persistence. **Меньше кода.**
- **B. Multi-tenant** (реальные разные пользователи) → довести изоляцию до конца
  (per-user + per-chat), а не косметику. **Больше кода, но честно.**

> Рекомендация: если нет реальных сторонних пользователей — выбрать **A**.

## Этап 3 — Убрать дублирующее состояние (по одной подсистеме)
Порядок — от самого безопасного к самому связанному:
1. **`conversations` mapping** → сделать OH источником правды; локальную таблицу
   свести к кешу (TTL) или вью. Тест: создать чат, перезапустить, продолжить.
2. **`agent_runs`** → оставить только поля для UI (status, last_error), остальное
   читать из OH events on-demand. Тест: self-test + история run.
3. **`isolation.py`** → если выбран путь A, удалить `safe_chat_id` и
   `_chat_workspace_instruction`, оставить один `/workspace`. Тест: файловые API.
4. Каждое удаление — за отдельный коммит с откатом.

## Этап 4 — Чистка и наблюдаемость
- Единый health-дашборд: BrowserAI + OH + runtime + LLM в одном `/api/health/deep`.
- Алерты, если self-test падает (cron + Telegram-бот, который уже в проекте).
- Удалить мёртвый код WIP-панелей Operator Console или явно пометить.

---

## Что НЕ делаем (и почему)
- ❌ **Не переписываем с нуля.** ~25k строк работающего кода + год работы OH-эквивалента.
  z.ai сам пишет: «Переписывать это — год работы».
- ❌ **Не трогаем OpenHands.** Окупается.
- ❌ **Не делаем всё сразу.** Каждый шаг изолирован и обратим.

## Метрики успеха (измеримые)

| Метрика | Сейчас | Цель |
|---|:---:|:---:|
| 🔴-багов из review открыто | 6 (2 покрыты xfail-ловушками) | 0 |
| Mock OH интеграционных тестов | 8 ✅ (было 0) | ≥10 |
| SQLite-таблиц с дублирующим OH-состоянием | 4 (`agent_runs`, `agent_questions`, `chat_conversations`, `agent_tool_ledger`) | ≤1 |
| Дубликатов `ws_client.py` | ~~2~~ → **1** ✅ | 1 |
| Таблиц, подключённых к авто-миграции | 6 | все (~10 ключевых) |
| `update_last_event` вызовов вне `done=True` | 0 ✅ (баг 2.2 закрыт) | 0 |
| Прод-инцидентов за рефакторинг | 0 | 0 |

## Обобщить паттерн `turn_id` (idempotency)
Лучшее из прошлой итерации. Применить ту же логику к:
- `ask_user` — `question_id` как ключ; `/answer` проверяет, что не отвечено (3.3/3.2).
- Stop — `turn_id` в `/chat/stop`; игнорировать stop завершённого turn (баг 4.2).
- Branch — `branch_from_turn_id`, новый чат наследует курсор.
