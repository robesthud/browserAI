# browserAI — чат с AI

[![Version](https://img.shields.io/badge/version-1.0.12-blue)](https://github.com/robesthud/browserAI)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/robesthud/browserAI)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff)](https://vitejs.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57)](https://github.com/WiseLibs/better-sqlite3)

Full-stack клиент чата с AI: **React 19 + Vite 8 + Tailwind CSS 3** на фронте и
**Express 5 + SQLite (better-sqlite3)** на бэке. Обращается к любому
**OpenAI-совместимому** Chat Completions API, а также поддерживает
**сессионные веб-токены** (Cookie / кастомный заголовок / Bearer JWT) для
работы через веб-интерфейсы DeepSeek, Grok, Claude и других сайтов.
Мягкая тёмно-серая тема, интерфейс на русском. Запуск в один клик через
**Docker** или деплой на **Railway**.

---

## Текущий контекст для разработки и деплоя

- Production Railway URL: `https://browserai-production.up.railway.app/`
- Android wrapper: `android-app/`, package: `ai.browser.app`
- Android-приложение — WebView-обёртка над Railway-версией. Backend/SQLite/Workspace на Railway.
- Web-изменения обновляются «по воздуху» после Railway redeploy; APK нужно пересобирать только при изменениях в `android-app/`.
- Подробный контекст исправлений: `PROJECT_CONTEXT.md`

---

## Возможности

### 💬 Чат
- Textarea с авто-ростом, отправка `Enter` (`Shift+Enter` — новая строка)
- Потоковый (streaming) вывод через Server-Sent Events (SSE)
- Остановка генерации во время стрима
- Markdown с подсветкой кода, безопасный рендер (DOMPurify)
- История чатов в сайдбаре, автозаголовок по первому сообщению
- Копирование сообщений (у пользователя и ассистента)

### 🤖 Выбор модели и авторежим
- **ModelBar** — полоска прямо над/под полем ввода с выпадающим списком всех моделей
- Поиск по моделям внутри дропдауна
- **Авторежим** (`⚡ Авто`) — анализирует текст запроса и автоматически переключает модель:

  | Тип запроса | Пример | Предпочитаемые модели |
  |-------------|--------|----------------------|
  | 💻 Код | «напиши код на Python» | claude, gpt-4, deepseek-coder |
  | 🎨 Изображения | «нарисуй котика» | dall-e, flux, imagen |
  | 🧠 Рассуждения | «реши задачу, докажи теорему» | o1, R1, claude-opus |
  | ✍️ Творчество | «напиши стихотворение» | claude, gpt-4, gemini |
  | 🌐 Перевод | «переведи на английский» | gpt-4, gemini |
  | ⚡ Быстро | «кратко ответь» | mini, haiku, flash |

- Авторежим сохраняется между сессиями (localStorage)
- Модель переключается **до отправки** запроса (без гонки данных)
- Подсказка в топбаре показывает что и почему выбрано

### 🔑 Менеджер API-ключей — полная поддержка всех типов

Каждый ключ содержит:
- `name` — имя для отображения
- `baseUrl` — endpoint провайдера
- `apiKey` — ключ / токен / cookie
- `model`, `availableModels` — модель и список моделей
- **`authType`** — тип авторизации: `bearer` / `cookie` / `custom`
- **`authHeader`** — название кастомного заголовка (для `custom`)
- **`responsePath`** — путь к тексту в нестандартном JSON-ответе

#### Пресеты провайдеров

**Официальные API (Bearer):**
- OpenAI
- DeepSeek API
- Gemini (OpenAI-compatible endpoint)
- **🏟 Arena.ai** — бесплатный доступ к 600+ моделям (GPT-5, Claude Opus, Gemini, Grok и др.)

**Сессионные токены (веб-интерфейс):**
- 🍪 DeepSeek Web — Bearer JWT из заголовка Authorization
- 🍪 Grok Web — Bearer токен из заголовка Authorization
- 🍪 Claude Web — Cookie из заголовка Cookie

**Локальные и кастомные:**
- 🌉 Arena.ai Bridge (через LMArenaBridge)
- 🔧 Свой сайт — произвольный URL и токен

#### Как добавить сессионный токен

1. Открой сайт (Claude, DeepSeek, Grok и т.д.) и залогинься
2. Нажми `F12` → вкладка **Network**
3. Отправь сообщение в чате сайта
4. Найди запрос к API (`/chat`, `/completion`, `/chat/completions`)
5. Вкладка **Headers** → скопируй `Authorization` или `Cookie`
6. В BrowserAI: Настройки → + Добавить → выбери пресет сайта → вставь токен → Проверить

> ⚠️ Токены протухают через дни/недели. При ошибке 401 — обнови токен.

#### Функции менеджера
- Добавление, редактирование, удаление ключей
- Проверка валидности через сервер (без CORS-проблем)
  - Bearer: запрос к `/models` + probe chat
  - Сессионный: прямой probe `/chat/completions`
- Автозагрузка списка моделей при вводе ключа
- Маскирование токена (кнопка 👁)
- Экспорт/импорт ключей в JSON (с сохранением authType)
- Активация нужного ключа кликом

### 🌐 Web AI
- Включается переключателем **«Web AI»** в топбаре
- Поиск через DuckDuckGo HTML
- Загрузка содержимого страниц через backend-прокси
- Обогащение system prompt web-контекстом перед ответом
- Защита от SSRF (блокировка localhost, private IP, .local доменов)
- Таймаут 8 секунд на каждый web-запрос

### 🔄 Автосуммаризация
- При диалогах >14 сообщений — автоматическая краткая сводка предыдущего контекста
- Экономия токенов при длинных чатах
- Сводка подмешивается в system prompt следующего запроса

### 📁 Workspace — встроенный файловый менеджер
- Дерево файлов с CRUD (создать, переименовать, переместить, удалить)
- Upload: file dialog, drag-and-drop, загрузка по URL, загрузка папок
- Авто-распаковка ZIP / TAR / TGZ (с защитой от path traversal)
- **История ревизий**: до 30 снапшотов на файл, восстановление любой
- **grep-поиск** по содержимому всех текстовых файлов
- Preview: text, code (подсветка синтаксиса), markdown, image, PDF
- Встроенный редактор с Save / Cancel
- **AI-генерация файлов** по текстовому промпту
- **AI-патчинг** (дифференциальное редактирование через search/replace)
- Скачивание файлов / папок (ZIP)
- Прикрепление файла из Workspace в сообщение чата
- Квота: `WORKSPACE_QUOTA_MB` (по умолчанию 500 МБ)

### 🔐 Безопасность
- Регистрация/вход по email+пароль
- HttpOnly session cookie (`browserai_session`), 30 дней
- Первый пользователь = owner; после первого — регистрация закрыта (нужен `REGISTRATION_SECRET`)
- **Vault** — шифрование API-ключей мастер-паролем (AES-256-GCM, scrypt)
- Автоблокировка vault: 5 / 15 / 30 / 60 мин бездействия
- **Cloud Sync** — чаты и настройки между устройствами (AES-256-GCM, HKDF)
- Сброс пароля по email (SMTP) и по SMS (Twilio)
- Требования к паролю: 10+ символов, заглавная, строчная, цифра, спецсимвол
- Rate limit на auth-эндпоинты: 10 запросов / 15 мин
- SSRF-защита в Web AI и validate
- CORS ограничен в production
- DOMPurify для всего Markdown-рендера
- SQLite WAL mode, индексы на sessions.token_hash

---

## Запуск

### Docker (одна команда)

```bash
docker compose up --build
# открыть http://localhost:8787
```

### Railway

1. Создайте **Web Service** из этого репозитория
2. Включите **Volume** и смонтируйте в `/data`
3. Деплойте — Railway автоматически использует `nixpacks.toml`
4. После первого запуска откройте приложение по Railway URL

Проект использует `/data` если mount существует:
- SQLite: `/data/browserai.db`
- Workspace: `/data/workspace`

Без volume приложение работает, но данные эфемерны.

### Локально (Node.js)

```bash
npm install

# фронт + бэк одной командой (для разработки)
npm run dev:all   # web: http://localhost:5173, api: http://localhost:8787

# или по отдельности
npm run server    # бэкенд (Express + SQLite) на :8787
npm run dev       # фронтенд (Vite) на :5173

# production без Docker
npm run build && npm start   # сервер раздаёт dist/ и API на :8787
```

Линт: `npm run lint`

### 📱 Termux на Android

```bash
# Установите Termux из F-Droid (не из Google Play)
# https://f-droid.org/packages/com.termux/

pkg update && pkg upgrade
pkg install nodejs python make clang git

git clone https://github.com/robesthud/browserAI.git
cd browserAI
npm install
npm run build && npm start
# http://localhost:8787
```

> 💡 `better-sqlite3` — нативный модуль (C++). Termux предоставляет `clang` для компиляции.

---

## Регистрация, вход и Cloud Sync

- Регистрация по email/паролю
- Первый пользователь получает роль `owner`
- После создания первого пользователя регистрация закрыта (нужен `REGISTRATION_SECRET`)
- Настройки, API-ключи и чаты синхронизируются между браузером и Android-приложением
- Cloud sync хранится в SQLite в зашифрованном виде (AES-256-GCM, ключ из `AUTH_SECRET`)

Для production обязательно задайте в Railway Variables:

```text
AUTH_SECRET=длинная_случайная_строка_минимум_32_символа
APP_URL=https://browserai-production.up.railway.app
```

Восстановление пароля — через SMTP. Без настройки SMTP вернёт ошибку. Для включения:

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=BrowserAI
```

Также поддерживается SMS-сброс через Twilio:

```text
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_FROM=+71234567890
```

---

## Android OTA-обновления APK

Web-интерфейс обновляется автоматически после Railway redeploy.

Если меняется `android-app/` — нужен новый APK:
- Приложение проверяет GitHub Releases при старте
- Если версия новее — предлагает скачать APK
- Скачивает и открывает системный установщик
- APK должен быть подписан тем же ключом

GitHub Actions workflows:
- `build-android-apk.yml` — ручная сборка (тест)
- `release-android-apk.yml` — релиз APK (создаёт GitHub Release `android-v...`)
- `monthly-release.yml` — автосборка 1-го числа каждого месяца в 09:00 UTC

---

## Менеджер ключей и база данных

- **Настройки** → внизу сайдбара или иконка ⚙️ в шапке
- Бейдж рядом с заголовком:
  - **БД** (зелёный) — сервер доступен, ключи в SQLite
  - **локально** — fallback в `localStorage`

### База данных (SQLite)

Файл: `server/browserai.db` (в Docker — `/data/browserai.db`)

| Таблица | Назначение |
|---------|-----------|
| `keys` | API-ключи (id, name, base_url, api_key, model, available_models, **auth_type**, **auth_header**, **response_path**, enc, is_active) |
| `params` | system_prompt, temperature, stream, use_web_ai |
| `meta` | vault salt, verifier, autolock |
| `users` | аккаунты |
| `sessions` | сессии (hash токена, не сам токен) |
| `password_reset_tokens` | токены сброса пароля |
| `sms_codes` | SMS-коды |
| `user_cloud_data` | зашифрованные данные синхронизации |

- Режим WAL для производительности
- Индексы на `sessions.token_hash`
- Миграции старых БД: автоматические `ALTER TABLE` при старте

Сменить путь к БД: `BROWSERAI_DB=...`  
Сменить порт: `PORT=...` (по умолчанию 8787)

### 🔒 Шифрование ключей (Vault)

В настройках → раздел **«Шифрование ключей»**:
- **Включить** — задаёте мастер-пароль, ключи шифруются AES-256-GCM (derive: scrypt N=16384)
- При перезапуске сервера vault **заблокирован** — нужно ввести мастер-пароль
- **Сменить пароль** — перешифровывает все ключи
- **Отключить** — расшифровывает всё в открытый вид
- **Автоблокировка** — 5 / 15 / 30 / 60 мин бездействия
- **Бэкап** — JSON со всеми ключами (зашифрованными, если vault включён)
- **Восстановить** — импорт бэкапа

> ⚠️ Мастер-пароль нельзя восстановить. Без шифрования ключи в `browserai.db` в открытом виде.

---

## 🏟 Arena.ai — встроенный адаптер (600+ бесплатных моделей)

BrowserAI имеет **встроенный адаптер** для Arena.ai, который работает полностью автоматически
через headless Chromium (Playwright). Не нужны внешние прокси, userscript или открытые вкладки.

### Что даёт Arena.ai

- **600+ моделей** бесплатно: GPT-5, Claude Opus 4, Gemini 3, Grok 4, Qwen, Kimi, Mistral и др.
- Все модели доступны через один аккаунт arena.ai (Google-авторизация)

### Как включить

1. **Зарегистрируйтесь** на [arena.ai](https://arena.ai) (Google-аккаунт)

2. **Скопируйте cookie:**
   - Откройте arena.ai → F12 → Application → Cookies
   - Скопируйте **значение** cookie `arena-auth-prod-v1` (начинается с `base64-`)

3. **Задайте переменную окружения** на сервере (Railway / Docker / .env) — один из вариантов:
   - Полная кука: `ARENA_AUTH_COOKIE=base64-eyJhY2Nlc3NfdG9rZW4iOi...`
   - Только refresh + anon: `ARENA_REFRESH_TOKEN=...` и `ARENA_ANON_KEY=...`
   - Email/pass для авто-логина: `ARENA_EMAIL=...` и `ARENA_PASSWORD=...`
   ```
   PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium
   ```

4. **В BrowserAI:** Настройки → пресет **🏟 Arena.ai** → введите любой ключ → Сохранить

5. **Готово!** Токен обновляется автоматически — повторно копировать cookie не нужно.

> 💡 Cookie содержит `refresh_token`. Адаптер сам обновляет `access_token` через Supabase 
> каждый час. Пока `refresh_token` жив (недели), всё работает без вмешательства.

### Как работает

```
Пользователь → BrowserAI → /api/chat
                               │
                               ▼
                     isArenaUrl(baseUrl)?
                               │ да
                               ▼
                     arenaAdapter.js
                         │
                         ├── Playwright (headless Chromium)
                         │     ├── Устанавливает cookie через CDP
                         │     ├── Открывает arena.ai
                         │     ├── Перехватывает Supabase anon key из network
                         │     └── Извлекает reCAPTCHA v3 site key
                         │
                         ├── Автообновление токена
                         │     ├── Декодирует cookie → refresh_token
                         │     ├── POST Supabase /auth/v1/token?grant_type=refresh_token
                         │     └── Обновляет cookie + браузерный контекст
                         │
                         └── Отправка сообщения
                               ├── page.evaluate(fetch('/nextjs-api/stream/create-evaluation'))
                               ├── Обходит CORS и Cloudflare (из контекста браузера)
                               └── Парсит SSE → конвертирует в OpenAI формат
```

### Требования

- **RAM:** +400 МБ (Chromium в headless режиме)
- **Railway:** nixpacks.toml устанавливает Chromium автоматически
- **Docker:** Dockerfile устанавливает Chromium автоматически
- **Termux:** не поддерживается (нет Chromium; используйте Arena.ai Bridge)

### Файлы адаптера

| Файл | Назначение |
|------|-----------|
| `server/arenaAdapter.js` | Playwright, reCAPTCHA, Supabase token refresh, chat API |
| `server/index.js` | Маршруты: `/api/arena/models`, `/api/arena/status`, `/api/arena/diag` |
| `nixpacks.toml` | Chromium + системные зависимости для Railway |
| `Dockerfile` | Chromium + зависимости для Docker |

### Переменные окружения Arena.ai

| Переменная | Описание |
|------------|----------|
| `ARENA_AUTH_COOKIE` | Полная cookie `arena-auth-prod-v1` (`base64-eyJ...`). Содержит access_token + refresh_token. Адаптер автообновляет access_token. |
| `ARENA_ANON_KEY` | Supabase anon key (для использования с ARENA_REFRESH_TOKEN) |
| `ARENA_REFRESH_TOKEN` | refresh_token из cookie (для авто-обновления сессии без полной куки) |
| `ARENA_ENABLED` | `1` — принудительно включить (обычно авто по наличию ARENA_AUTH_COOKIE) |
| `PLAYWRIGHT_CHROMIUM_PATH` | Путь к Chromium (`/usr/bin/chromium` на Railway/Docker) |

### Диагностика

| Эндпоинт | Что показывает |
|----------|----------------|
| `GET /api/arena/status` | Подключён ли адаптер, email пользователя |
| `GET /api/arena/models` | Список доступных моделей |
| `GET /api/arena/diag` | Путь к Chromium, тест запуска Playwright, тест навигации на arena.ai |

---

## Web AI

- Включается переключателем **«Web AI On/Off»** в топбаре
- При отправке сообщения сервер:
  1. Ищет релевантные результаты через DuckDuckGo HTML
  2. Загружает содержимое страниц через серверный прокси
  3. Обогащает system prompt web-контекстом
- SSRF-защита: блокировка localhost, private IP, `.local`
- Таймаут 8 сек на каждый web-fetch

---

## Workspace

- **Создание**: файлы и папки через контекстное меню
- **Загрузка**: drag-and-drop, диалог, загрузка папок, по URL
- **Архивы**: ZIP, TAR, TGZ — автораспаковка с проверкой путей
- **Preview**: text, code (подсветка), markdown, image, PDF
- **Редактирование**: встроенный редактор, Save / Cancel
- **История ревизий**: до 30 снапшотов, восстановление
- **AI-патчинг**: инструкция → search/replace patch → применение
- **AI-генерация**: создание файла по промпту
- **Перемещение**: drag-and-drop между папками
- **Поиск**: grep по содержимому текстовых файлов
- **Скачивание**: файл или папка (ZIP)

---

## API Reference

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/health` | Healthcheck |
| `GET` | `/api/settings` | Настройки и ключи |
| `POST` | `/api/keys` | Сохранить/создать ключ |
| `DELETE` | `/api/keys/:id` | Удалить ключ |
| `POST` | `/api/keys/:id/activate` | Активировать ключ |
| `POST` | `/api/keys/import` | Импорт ключей из JSON |
| `GET` | `/api/keys/export` | Экспорт ключей в JSON |
| `PUT` | `/api/params` | Обновить параметры генерации |
| `POST` | `/api/validate` | Проверить валидность ключа |
| `GET` | `/api/vault/status` | Статус шифрования |
| `POST` | `/api/vault/setup` | Включить шифрование |
| `POST` | `/api/vault/unlock` | Разблокировать |
| `POST` | `/api/vault/lock` | Заблокировать |
| `POST` | `/api/vault/change` | Сменить мастер-пароль |
| `POST` | `/api/vault/disable` | Отключить шифрование |
| `POST` | `/api/vault/autolock` | Настроить автоблокировку |
| `GET` | `/api/vault/backup` | Экспорт бэкапа |
| `POST` | `/api/vault/restore` | Восстановление из бэкапа |
| `GET` | `/api/workspace/tree` | Дерево файлов |
| `GET` | `/api/workspace/file` | Содержимое файла |
| `GET` | `/api/workspace/download` | Скачать файл/папку |
| `POST` | `/api/workspace/folder` | Создать папку |
| `POST` | `/api/workspace/file` | Создать файл |
| `PUT` | `/api/workspace/file` | Обновить файл |
| `POST` | `/api/workspace/rename` | Переименовать |
| `POST` | `/api/workspace/move` | Переместить |
| `DELETE` | `/api/workspace/item` | Удалить |
| `POST` | `/api/workspace/upload` | Загрузить файлы |
| `POST` | `/api/workspace/upload-url` | Загрузить по URL |
| `GET` | `/api/workspace/search` | grep-поиск |
| `GET` | `/api/workspace/history` | История ревизий |
| `POST` | `/api/workspace/history/restore` | Восстановить ревизию |
| `GET` | `/api/web/search` | Поиск в интернете |
| `GET` | `/api/web/fetch` | Загрузить страницу |
| `POST` | `/api/auth/register` | Регистрация |
| `POST` | `/api/auth/login` | Вход |
| `POST` | `/api/auth/logout` | Выход |
| `GET` | `/api/auth/me` | Текущий пользователь |
| `POST` | `/api/auth/forgot-password` | Сброс пароля по email |
| `POST` | `/api/auth/reset-password` | Применить новый пароль |
| `POST` | `/api/auth/sms-send` | Отправить SMS-код |
| `POST` | `/api/auth/sms-verify` | Проверить SMS-код |
| `PUT` | `/api/auth/phone` | Обновить телефон |
| `GET` | `/api/cloud` | Получить cloud data |
| `PUT` | `/api/cloud` | Сохранить cloud data |
| `GET` | `/api/arena/models` | Список моделей Arena.ai |
| `GET` | `/api/arena/status` | Статус Arena.ai адаптера |

---

## Changelog — что изменилось в этой версии

### 🆕 Новое: Встроенный Arena.ai адаптер (v1.0.13)
- **600+ бесплатных моделей** через arena.ai (GPT-5, Claude Opus, Gemini, Grok и др.)
- Встроенный Playwright (headless Chromium) — без внешних прокси и userscript
- Автоматическое обновление Supabase access_token через refresh_token
- Автоматический обход Cloudflare и reCAPTCHA v3
- Новый пресет **🏟 Arena.ai** в настройках
- Новые эндпоинты: `/api/arena/models`, `/api/arena/status`
- Интеграция в `/api/chat` — автоматическое определение Arena.ai по baseUrl
- Docker: Chromium устанавливается автоматически в runtime-образе
- Переменная `ARENA_REFRESH_TOKEN` для включения адаптера

### 🆕 Новое: ModelBar — выбор модели над чатом
- Новый компонент `ModelBar.jsx` — полоска прямо над/под полем ввода
- Кнопка «Авто» + выпадающий список всех доступных моделей с поиском
- Дропдаун открывается вверх в чате (`dropUp=true`) и вниз на стартовом экране (`dropUp=false`)
- Активная модель отмечена зелёной точкой `●`
- Кол-во доступных моделей в футере дропдауна

### 🆕 Новое: Авторежим выбора модели
- Модуль `autoModel.js` — классификация задач по ключевым словам
- Категории: код, изображения, рассуждения, творчество, перевод, быстрый ответ
- Расширенный словарь ключевых слов (рус + eng)
- Подсказка в топбаре и ModelBar когда произошёл автовыбор

### 🆕 Новое: Полная поддержка сессионных токенов
- Тип авторизации `authType`: `bearer` / `cookie` / `custom`
- Поле `authHeader` — кастомное имя заголовка (напр. `Cookie`, `X-Auth-Token`)
- Поле `responsePath` — путь к тексту в нестандартном JSON (`choices.0.message.content`)
- Пресеты: DeepSeek Web, Grok Web, Claude Web, Arena.ai Bridge, Свой сайт
- Для сессионных токенов валидация идёт напрямую в `/chat/completions` (без `/models`)

### 🐛 Исправлено: критический баг — authType/authHeader/responsePath не сохранялись в БД
- В таблице `keys` отсутствовали колонки `auth_type`, `auth_header`, `response_path`
- Данные принимались, но нигде не записывались и терялись после перезагрузки
- Добавлены колонки + автоматическая миграция существующих БД
- `upsertKey()`, `replaceKeys()`, `restoreRawKeys()`, `dumpRawKeys()` — все обновлены

### 🐛 Исправлено: 7 багов в ключах, токенах и авторежиме
1. `check()` в KeyEditor не передавал `authType`/`authHeader` в validate — сессионные токены всегда проверялись как Bearer
2. Auto-validate useEffect тоже не передавал тип — исправлено; для `cookie`/`custom` авто-валидация отключена
3. Гонка данных в авторежиме: `setActiveModel` async → `sendMessage` читал старую модель → исправлено через `overrideModel`
4. Дропдаун ModelBar на стартовом экране открывался вниз за экран → добавлен prop `dropUp`
5. Пресеты `arena-bridge` и `custom-web` попадали в секцию «Официальные API» → добавлено поле `group`
6. Topbar получал лишние props `models/selectedModel/onSelectModel/onToggleAuto` → убраны
7. `applyPreset` обнулял `authHeader` если пресет его не задавал → исправлено

### 🐛 Исправлено: ранее (за сессию разработки)
- 23 security-фикса: XSS, SSRF, CORS, rate-limit, quota, auth
- 13 UX-фиксов: дебаунс localStorage, scroll, confirm перед удалением, унификация языка
- 6 backend-багов: decryptJson без try/catch, path traversal, null bytes, ZIP DoS
- Express 5 wildcard SPA route (нельзя `app.get('*')`)
- Android WebView серый экран (Vite legacy build + CSP `unsafe-inline`)
- `normalizeKey(null)` краш при первом запуске без ключей
- Limit apiKey с 500 до 2000 символов (Cookie-сессии длинные)

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `PORT` | `8787` | Порт HTTP-сервера |
| `BROWSERAI_DB` | `server/browserai.db` | Путь к файлу SQLite |
| `AUTH_SECRET` | `browserai-dev-secret-...` | Ключ шифрования cloud sync (мин. 32 символа) |
| `APP_URL` | `http://localhost:8787` | URL приложения (для reset-ссылок) |
| `REGISTRATION_SECRET` | — | Секрет для регистрации после первого пользователя |
| `CORS_ORIGIN` | — | Явный CORS origin в production |
| `WORKSPACE_QUOTA_MB` | `500` | Квота workspace в МБ |
| `WORKSPACE_MAX_FILE_MB` | — | Лимит на один файл |
| `SMTP_HOST` | — | SMTP сервер для сброса пароля |
| `SMTP_PORT` | `587` | SMTP порт |
| `SMTP_SECURE` | `false` | TLS |
| `SMTP_USER` | — | SMTP логин |
| `SMTP_PASS` | — | SMTP пароль |
| `SMTP_FROM` | — | Отправитель |
| `TWILIO_ACCOUNT_SID` | — | Twilio SID для SMS |
| `TWILIO_AUTH_TOKEN` | — | Twilio токен |
| `TWILIO_PHONE_FROM` | — | Номер отправителя SMS |
| `ARENA_AUTH_COOKIE` | — | Cookie `arena-auth-prod-v1` для Arena.ai (auto-refresh) |
| `ARENA_ANON_KEY` + `ARENA_REFRESH_TOKEN` | — | Для авто-обновления без полной куки (anon key + refresh_token) |
| `ARENA_ENABLED` | — | `1` для принудительного включения Arena.ai |
| `PLAYWRIGHT_CHROMIUM_PATH` | `/usr/bin/chromium` | Путь к Chromium для Playwright |
