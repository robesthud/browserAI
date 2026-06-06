# DeepSeek managed session

BrowserAI больше не использует LMArenaBridge. Вместо него — встроенный
менеджер сессии `chat.deepseek.com`, который:

1. Хранит `userToken` (Bearer JWT) и cookies в
   `/data/deepseek_session.json` (переживает рестарт контейнера).
2. Каждые 10 минут стучится `GET /api/v0/users/current`, чтобы убедиться,
   что сессия жива; собирает обновлённые `Set-Cookie`.
3. Каждый час освежает список моделей.
4. При 401/403 пишет в Telegram «токен умер, обнови».
5. Когда фронт шлёт запрос с `apiKey: '__managed__'` (или вообще без
   `apiKey`), сервер подставляет хранящиеся `Bearer` + `Cookie`.

## Файлы

- `server/deepseekTokenRefresher.js` — менеджер сессии
- `server/deepseekBot.js`            — Telegram-бот (опционально)
- `server/index.js`                  — bootstrap + админ-эндпоинты
- `src/components/DeepSeekAdmin.jsx` — страница `/admin/deepseek`

## Эндпоинты

| Метод | Путь                              | Auth        | Назначение                                  |
|-------|-----------------------------------|-------------|---------------------------------------------|
| GET   | `/api/admin/deepseek/status`      | requireAuth | состояние сессии (без секретов)             |
| POST  | `/api/admin/deepseek/refresh`     | requireAuth | принудительный heartbeat + обновление моделей |
| POST  | `/api/admin/deepseek/token`       | requireAuth | задать `userToken` и/или `cookies`          |
| GET   | `/api/admin/deepseek/models`      | requireAuth | кэшированный список моделей                 |
| GET   | `/api/deepseek/managed`           | public      | признак доступности managed-режима для UI   |

## ENV

| Переменная                | По умолчанию                | Описание                                  |
|---------------------------|-----------------------------|-------------------------------------------|
| `DEEPSEEK_STATE_FILE`     | `/data/deepseek_session.json` | Файл состояния                           |
| `DEEPSEEK_HEARTBEAT_MS`   | `600000` (10 мин)           | Интервал heartbeat                        |
| `DEEPSEEK_MODELS_REFRESH_MS` | `3600000` (1 ч)          | Интервал обновления списка моделей        |
| `DEEPSEEK_USER_TOKEN`     | —                           | Bootstrap-токен при первом старте         |
| `DEEPSEEK_COOKIES`        | —                           | Bootstrap-cookies (`name=value; ...`)    |
| `DEEPSEEK_BOT`            | (вкл)                       | `off` отключает Telegram-бота             |
| `TG_BOT_TOKEN`            | —                           | Токен Telegram-бота (`123:ABC...`)        |
| `TG_ADMIN_CHAT_ID`        | —                           | chat_id админа (числовой)                 |

## Telegram-бот

Если задан `TG_BOT_TOKEN` + `TG_ADMIN_CHAT_ID`, бот стартует автоматически и
принимает команды **только из admin chat**:

```
/status                  — текущее состояние
/refresh                 — force heartbeat
/settoken <userToken>    — задать Bearer (сообщение с токеном удаляется)
/setcookie <name=val;..> — задать/добавить cookies
/models                  — кэш моделей
/help                    — список команд
```

## Где взять `userToken` и cookies

1. Открой <https://chat.deepseek.com> и залогинься.
2. DevTools → Application → Local Storage → ключ **`userToken`** →
   значение (`{"value":"eyJhbGciOi..."}`) — нужна именно строка `value`.
3. DevTools → Application → Cookies → Domain `chat.deepseek.com` →
   скопируй пары `cf_clearance`, `ds_session_id`, `smidV2` в формате
   `name=value; name2=value2`.
4. Вставь оба значения на странице `/admin/deepseek` или отправь боту
   `/settoken ...` и `/setcookie ...`.

После этого сервер сам поддерживает сессию: фронт просто выбирает пресет
**«✨ DeepSeek (managed)»** и общается с моделью без ввода ключа.
