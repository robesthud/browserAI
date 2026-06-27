# Step 1 — Audit & Baseline

**Дата аудита:** 2026-06 (зафиксировано ретроспективно 2026-06-27 по факту кода)
**Объект:** интеграция BrowserAI UI (React/Vite) ↔ OpenHands Agent Server v0.59
через Python/FastAPI монолит `core/server.py`.

---

## 1. Инвентаризация endpoint-ов UI

UI вызывает **97 уникальных `/api/*` путей**. Проверяемо командой:

```bash
grep -rhoE "/api/[a-zA-Z0-9_/{}.-]+" ui/src | sed -E 's/\{[^}]+\}/{id}/g' | sort -u | wc -l
# => 97
```

Карта политик доступа по группам маршрутов зафиксирована в
`route_policy_inventory.md` (public / auth / owner / internal).

Текущее покрытие реализацией (на 2026-06-27): **48 реальных путей (~47%)**,
остальные — `_STUB_ROUTES` (заглушки JSON-200), заполняются в Step 6–9.

---

## 2. Восемь корневых архитектурных разрывов

Аудит выявил 8 разрывов между ожиданиями UI и реальностью OpenHands v0.59.
**Все они устранены в Step 2** (см. ссылки на код).

| # | Разрыв | Симптом | Решение | Где в коде |
|---|--------|---------|---------|------------|
| 1 | **`/api/health` не возвращал `{ok:true}`** | UI считал себя offline, не запускал CloudSync | health отдаёт `{ok:true,...}` | `core/server.py` `get_health()` |
| 2 | **CORS wildcard + credentials** | Браузер молча отбрасывал cookie сессии | `allow_origins=[APP_URL]`, без `*` | `core/server.py` CORS middleware |
| 3 | **WebSocket `/api/sockets/events/{cid}` отсутствует в OH v0.59** | События агента не приходили | Переход на HTTP polling `/api/conversations/{id}/events` + dedup `seen_ids` | `core/server.py` `_stream_chat()` |
| 4 | **Устаревший runtime image `runtime:main`** (нет `action_execution_server.py`) | Sandbox не стартовал | Убрали override `SANDBOX_RUNTIME_CONTAINER_IMAGE`; OH собирает кастомный runtime сам | `docker-compose.yml` (нет override) |
| 5 | **DNS `host.docker.internal` не работает на Linux Docker** | browserai/openhands не видели друг друга | `extra_hosts: host.docker.internal:host-gateway` | `docker-compose.yml` |
| 6 | **Неверная схема событий OpenHands** | Translator писали под угаданный формат | Переписан под реальный wire-формат v0.59: top-level `action`/`observation` + `args`/`extras` | `core/server.py` `_translate_event()` |
| 7 | **GLM возвращает `<think>…</think>`** (иногда без открывающего тега) | CoT попадал в финальный ответ | Парсер вырезает CoT в отдельный SSE-event | `core/server.py` `_split_think()` |
| 8 | **Стрим не закрывался при `awaiting_user_input`** (статус `/conversations/{id}` остаётся `RUNNING`) | UI висел после ответа | Источник правды — event `agent_state_changed`, а не статус conversation | `core/server.py` `_stream_chat()` (`turn_complete`) |

Дополнительно (инфраструктурный): `docker/runtime/micromamba-wrapper.sh`
корректно проксирует `micromamba run -n openhands poetry run python …` в прямой
вызов интерпретатора.

---

## 3. Зафиксированный API-контракт UI

Контракт закодирован в исполняемом коде (не только в документе):

- **Body-shape `/api/agent/chat`:** `{chatId, history, extraSystem, keyId,
  useStoredSecret, baseUrl, apiKey, authType, authHeader, extraHeaders, model,
  temperature}` → `core/server.py` `_resolve_provider()`.
- **SSE event lifecycle:** `stream_protocol → agent_context → thinking →
  agent_state → tool_start/result → assistant_delta → assistant → done` →
  `core/server.py` `_stream_chat()` / `_translate_event()`.
- **Cookie-контракт:** `browserai_session`, HttpOnly + SameSite=Lax + Secure(auto),
  подпись `itsdangerous` → `core/auth.py` `set_session_cookie()`.

---

## Статус Step 1: ✅ ЗАКРЫТ

- [x] Инвентаризация 97 endpoint (подтверждено точным подсчётом)
- [x] 8 архитектурных разрывов задокументированы (этот файл) и устранены в Step 2
- [x] API-контракт UI зафиксирован (в коде + здесь)
