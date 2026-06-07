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

**Сессионные токены (веб-интерфейс):**
- ✨ **DeepSeek (managed)** — серверная сессия с автообновлением, без ввода токена клиентом
- 🍪 DeepSeek Web — ручной Bearer JWT из заголовка Authorization
- 🍪 Grok Web — Bearer токен из заголовка Authorization
- 🍪 Claude Web — Cookie из заголовка Cookie

**Локальные и кастомные:**
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
- **GitHub Import**: загрузка repo/blob-ссылок в Workspace с авто-распаковкой и удалением верхней папки архива
- Авто-распаковка ZIP / TAR / TGZ (с защитой от path traversal)
- **История ревизий**: до 30 снапшотов на файл, восстановление любой
- **grep-поиск** по содержимому всех текстовых файлов
- Preview: text, code (подсветка синтаксиса), markdown, image, PDF
- Встроенный редактор с Save / Cancel
- **AI-генерация файлов** по текстовому промпту
- **AI-патчинг** (дифференциальное редактирование через search/replace) с предпросмотром перед применением
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

## ✨ Managed DeepSeek — серверная сессия

BrowserAI хранит `userToken` и cookies от `chat.deepseek.com` **на сервере**
и сам поддерживает их свежими. Клиенту не нужно вставлять ключ — он
просто выбирает пресет **«✨ DeepSeek (managed)»**.

**Что делает сервер:**
- хранит `userToken` (Bearer JWT) и cookies в `/data/deepseek_session.json` (переживает рестарт)
- каждые 10 минут стучится в `GET /api/v0/users/current`, перехватывает обновлённые `Set-Cookie`
- раз в час освежает список моделей
- при 401/403 пишет в Telegram «токен умер»
- авто-подставляет Bearer + Cookie в `/api/chat` когда фронт шлёт `apiKey: '__managed__'`

**Как настроить (одноразово):**
1. Открой <https://chat.deepseek.com> и залогинься
2. DevTools → Application → Local Storage → ключ `userToken` → скопируй `value` (JWT)
3. DevTools → Application → Cookies → строка `cf_clearance=...; ds_session_id=...; smidV2=...`
4. Вставь оба значения в админ-панели `/admin/deepseek` **или** отправь Telegram-боту:
   ```
   /settoken eyJhbGc...
   /setcookie cf_clearance=...; ds_session_id=...; smidV2=...
   ```
5. После этого любой клиент использует пресет **«✨ DeepSeek (managed)»** без своего ключа

Полный гайд: [`server/DEEPSEEK_SESSION.md`](server/DEEPSEEK_SESSION.md) — описывает все
env-переменные, REST-эндпоинты, команды Telegram-бота и протокол refresh'а.

### 🔒 Где живёт токен и почему redeploy его не трогает

Состояние сессии лежит в файле `deepseek_session.json` **на хосте**, не в
образе и не в git:

```
/opt/browserai-data/deepseek_session.json   (host bind-mount)
    ↕
/data/deepseek_session.json                 (контейнер)
    ↕
runtime в памяти процесса Node (deepseekTokenRefresher.js)
```

`docker-compose.yml` использует bind-mounts (`DATA_DIR=/opt/browserai-data`),
поэтому:

| Действие | Что с токеном |
|---|---|
| `git pull && docker compose up -d --build` | ✅ сохраняется |
| `docker compose down && docker compose up -d` | ✅ сохраняется |
| `docker compose down -v` (удаление volume) | ✅ сохраняется (bind-mount, не volume) |
| GitHub Actions auto-deploy (см. ниже) | ✅ сохраняется |
| Удаление `/opt/browserai` и реклон с нуля | ✅ сохраняется (data в `/opt/browserai-data`) |
| Удаление `/opt/browserai-data` вручную | ❌ удалится (но есть бэкапы) |

### 🗂 Бэкапы

`scripts/backup-deepseek-session.sh` копирует `deepseek_session.json` в
`/var/backups/browserai/deepseek_session.YYYYMMDDTHHMMSSZ.json` (perms
`0600`, ротация — 7 дней).

`systemd`-таймер `browserai-backup.timer` запускает скрипт **каждый час**
с небольшим случайным сдвигом. Установка:

```bash
sudo cp scripts/systemd/browserai-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now browserai-backup.timer
```

Восстановление:
```bash
docker compose stop
cp /var/backups/browserai/deepseek_session.2026....json \
   /opt/browserai-data/deepseek_session.json
docker compose start
```

### 🚀 Auto-deploy (GitHub Actions → Timeweb)

Workflow `.github/workflows/deploy-timeweb.yml` срабатывает на push в
`main` (игнорирует изменения только в `*.md`, `android-app/`,
`cf-proxy/`) и через SSH делает `git pull && docker compose up -d --build`.
Bind-mount-каталоги при этом не трогаются.

Нужны **4 repo secrets** (Settings → Secrets and variables → Actions):

| Secret | Значение |
|---|---|
| `TIMEWEB_SSH_KEY` | приватный ed25519-ключ для деплоя (без passphrase) |
| `TIMEWEB_HOST` | `72.56.116.15` |
| `TIMEWEB_USER` | `root` |
| `TIMEWEB_APP_DIR` | `/opt/browserai` |

Запустить вручную: Actions → «Deploy to Timeweb» → Run workflow.

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
| `GET` | `/api/deepseek/managed` | Public-probe: доступен ли managed-режим |
| `GET` | `/api/admin/deepseek/status` | Состояние серверной DeepSeek-сессии |
| `POST` | `/api/admin/deepseek/refresh` | Принудительный heartbeat + обновление моделей |
| `POST` | `/api/admin/deepseek/token` | Задать `userToken` и/или `cookies` |
| `GET` | `/api/admin/deepseek/models` | Кэш моделей |

---

## Changelog — что изменилось в этой версии

### 🆕 Managed DeepSeek (v1.1.0)
- **`server/deepseekTokenRefresher.js`** — хранит `userToken` и
  cookies `chat.deepseek.com` в `/data/deepseek_session.json`, делает heartbeat
  каждые 10 мин, перехватывает `Set-Cookie`, обновляет список моделей раз в час
- **Telegram-бот** (`server/deepseekBot.js`): `/status`, `/refresh`, `/settoken`,
  `/setcookie`, `/models` — только из admin chat; сообщение с токеном удаляется
- **Админ-страница** `/admin/deepseek` — статус, force-refresh, форма ввода
  токена и cookies
- **Auto-inject** в `/api/chat` и `/api/validate`: если клиент шлёт
  `apiKey: '__managed__'` (или пустой) и URL — `chat.deepseek.com`, сервер
  подставляет свой Bearer + Cookie
- **Новые эндпоинты:** `/api/deepseek/managed`, `/api/admin/deepseek/{status,refresh,token,models}`
- **Docker:** добавлены `Dockerfile`, `docker-compose.yml`, `.env.example` — деплой одной командой
- Полная документация: [`server/DEEPSEEK_SESSION.md`](server/DEEPSEEK_SESSION.md)

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
- Пресеты: DeepSeek (managed), DeepSeek Web, Grok Web, Claude Web, Свой сайт
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
5. Пресет `custom-web` попадал в секцию «Официальные API» → добавлено поле `group`
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
| `DEEPSEEK_USER_TOKEN` | — | Bootstrap Bearer для managed-сессии (опционально, первый старт) |
| `DEEPSEEK_COOKIES` | — | Bootstrap cookies `name=value; ...` (опционально) |
| `DEEPSEEK_HEARTBEAT_MS` | `600000` | Интервал heartbeat в мс (10 мин по умолчанию) |
| `DEEPSEEK_MODELS_REFRESH_MS` | `3600000` | Интервал обновления списка моделей (1 ч) |
| `DEEPSEEK_BOT` | — | `off` отключает Telegram-бота |
| `TG_BOT_TOKEN` | — | Токен Telegram-бота (`123:ABC…`) для уведомлений + управления |
| `TG_ADMIN_CHAT_ID` | — | `chat_id` админа, кто может слать боту команды |
