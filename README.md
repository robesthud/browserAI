# browserAI — чат с AI

[![Version](https://img.shields.io/badge/version-1.0.11-blue)](https://github.com/robesthud/browserAI)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/robesthud/browserAI)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff)](https://vitejs.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57)](https://github.com/WiseLibs/better-sqlite3)

Full-stack клиент чата с AI: **React 19 + Vite 8 + Tailwind CSS 3** на фронте и
**Express 5 + SQLite (better-sqlite3)** на бэке. Обращается к любому
**OpenAI-совместимому** Chat Completions API. Мягкая тёмно-серая тема
(нейтральная, щадящая для глаз), интерфейс на русском. Ключи можно
**шифровать мастер-паролем**. Запуск в один клик через **Docker** или
деплой на **Railway**. Поддерживает **Web AI** — поиск и загрузку контента
из интернета для обогащения контекста.

## Текущий контекст для разработки и деплоя

Короткая памятка для следующих разработчиков/AI-агентов:

- Production Railway URL: `https://browserai-production.up.railway.app/`.
- Android wrapper находится в `android-app/`, package/applicationId: `ai.browser.app`.
- Android-приложение — это WebView-обёртка над Railway-версией. Backend/SQLite/Workspace остаются на Railway.
- Web-изменения обновляются «по воздуху» после redeploy Railway; APK нужно пересобирать только при изменениях в `android-app/`.
- Для Android WebView важны:
  - Vite legacy build в `vite.config.js`;
  - CSP в `server/index.js` должен разрешать Vite legacy inline scripts: `script-src 'self' 'unsafe-inline'`;
  - `normalizeKey(null)` не должен падать при первом запуске без API-ключей;
  - WebView не должен форсировать desktop viewport (`setUseWideViewPort(false)`).
- Подробная история исправлений и диагностики сохранена в `PROJECT_CONTEXT.md`.

## Возможности

- 💬 **Рабочий чат**: textarea с авто-ростом, отправка по `Enter`
  (`Shift+Enter` — новая строка), потоковый (streaming) вывод ответа через
  Server-Sent Events (SSE).
- 🗂 **История и состояние чатов**: список чатов в сайдбаре, создание, выбор,
  удаление, автоматическое название по первому сообщению. Сохраняется в
  `localStorage` и переживает перезагрузку.
- 📎 **Загрузка файлов**: кнопка «Add files» и drag-and-drop. Текстовые файлы
  читаются и передаются модели (до 200 КБ на файл); бинарные показываются как
  вложения и доступны для скачивания.
- 📁 **Workspace**: компактная **прозрачная** панель с деревом файлов активного
  чата. Когда файлов нет — сжимается до минимума; при добавлении расширяется.
  При наведении на файл справа появляются иконки **просмотр** и **скачать**;
  просмотр открывает файл в панели на пол-окна (текст/картинка/PDF).
- 📝 **Markdown** в ответах ассистента: заголовки, списки, код (с подсветкой
  синтаксиса), ссылки. Безопасный рендер через DOMPurify.
- 🔑 **Менеджер API-ключей с базой данных**: несколько ключей, у каждого
  **имя**, Base URL, модель и список доступных моделей; добавление,
  редактирование, удаление, выбор активного, **проверка валидности**,
  **маскирование/показ** ключа (кнопка-глаз 👁), **экспорт/импорт** ключей
  в JSON. Ключи хранятся в **SQLite** на сервере; при недоступности сервера —
  fallback в `localStorage`.
- 🌐 **Web AI**: поиск в интернете (DuckDuckGo) и загрузка содержимого страниц
  через серверный прокси для обогащения контекста ответов.
- 🔄 **Автосуммаризация**: при длинных диалогах (>14 сообщений) модель
  автоматически создаёт краткую сводку предыдущего контекста для экономии
  токенов.
- 📂 **Управление файлами в Workspace**: создание файлов/папок,
  переименование, перемещение, удаление, drag-and-drop, загрузка по URL,
  авто-распаковка ZIP/TAR/TGZ архивов.
- 🕐 **История ревизий**: автоматическое сохранение до 30 ревизий каждого
  файла в Workspace с возможностью восстановления.
- 🔍 **Поиск по содержимому**: grep-поиск по всем текстовым файлам в
  Workspace.
- 🤖 **AI-генерация и патчинг файлов**: создание файлов по промпту и
  дифференциальное редактирование (patch) через AI.
- 🎨 **Пресеты провайдеров**: быстрый выбор OpenAI, DeepSeek, Gemini с
  автозаполнением Base URL.

## Запуск

### Docker (одна команда)

```bash
docker compose up --build
# открыть http://localhost:8787
```

### Railway

Для Railway проект должен запускаться как **Web Service**, а не как
статический `serve dist`. В репозитории уже есть `nixpacks.toml`, который
принудительно задаёт:
- install: `npm ci`
- build: `npm run build`
- start: `npm start`

#### Рекомендуемая схема деплоя на Railway

1. Создайте **Web Service** из этого репозитория.
2. Включите **Volume** и смонтируйте его в путь **`/data`**.
3. Деплойте без дополнительных Start Command — Railway возьмёт `nixpacks.toml`.
4. После первого запуска откройте приложение по Railway URL.

Проект автоматически использует `/data`, если такой mount существует:
- SQLite: `/data/browserai.db`
- Workspace: `/data/workspace`

Если volume не подключать, приложение тоже запустится, но БД и workspace будут
**эфемерными** и могут пропасть при redeploy/restart.

### Локально (Node.js)

```bash
npm install

# фронт + бэк одной командой (рекомендуется для разработки)
npm run dev:all          # web: http://localhost:5173, api: http://localhost:8787

# или по отдельности
npm run server           # бэкенд (Express + SQLite) на :8787
npm run dev              # фронтенд (Vite) на :5173, /api проксируется на :8787

# production без Docker
npm run build && npm start   # сервер раздаёт dist/ и API на :8787
```

Линт: `npm run lint`.

### 📱 Termux на Android

Запуск BrowserAI прямо на Android-устройстве через Termux — полностью
локальный, без облака.

#### Шаг 1: Установка Termux и зависимостей

```bash
# Установите Termux из F-Droid (не из Google Play — там устаревшая версия)
# https://f-droid.org/packages/com.termux/

# Обновите пакеты
pkg update && pkg upgrade

# Установите Node.js, Python, make и другие зависимости
pkg install nodejs python make clang git

# Убедитесь, что версия Node.js >= 20
node -v
```

#### Шаг 2: Клонирование репозитория

```bash
git clone https://github.com/robesthud/browserAI.git
cd browserAI
```

#### Шаг 3: Установка зависимостей

```bash
npm install
```

> 💡 **better-sqlite3** — нативный модуль (C++). Termux предоставляет `python`,
> `make` и `clang` для его компиляции. Если `npm install` падает на сборке
> better-sqlite3, убедитесь, что `clang` установлен: `pkg install clang`.

#### Шаг 4: Запуск

```bash
# Режим разработки (фронт + бэк одновременно)
npm run dev:all
# web: http://localhost:5173, api: http://localhost:8787

# Или только сервер (production):
npm run build && npm start
# доступно по http://localhost:8787
```

Откройте браузер на устройстве: `http://localhost:8787` (production) или
`http://localhost:5173` (dev).

> 📌 **Доступ с другого устройства в локальной сети:**
> ```bash
> # Запустите сервер, привязав к 0.0.0.0
> PORT=8787 node server/index.js &
> # Фронтенд: vite --host
> npx vite --host
> ```
> Затем откройте `http://<IP-терmux-устройства>:8787` с другого устройства.

#### Шаг 5: Настройка в Termux

- Данные (БД и workspace) сохраняются в `server/browserai.db` и `./workspace/`
  внутри каталога проекта (т.к. `/data` в Termux не существует).
- Для персистентности при перезагрузке Termux — держите проект в домашней
  директории: `~/browserAI/`.

#### Оптимизация для слабых устройств

```bash
# Отключите тяжёлые фоновые процессы
export NODE_OPTIONS="--max-old-space-size=256"

# Используйте production-билд (меньше расход памяти)
npm run build && npm start
```

## Регистрация, вход и облачная синхронизация

В проект добавлена полноценная авторизация:

- регистрация по email/паролю;
- вход/выход через HttpOnly session-cookie;
- первый зарегистрированный пользователь получает роль `owner`;
- после создания первого пользователя регистрация закрыта, если не задан и не передан `REGISTRATION_SECRET`;
- настройки, API-ключи и чаты синхронизируются между браузером на компьютере и Android-приложением;
- cloud-sync хранится в SQLite в таблице `user_cloud_data` в зашифрованном виде (`AES-256-GCM`, ключ из `AUTH_SECRET`).

Для production обязательно задайте в Railway Variables:

```text
AUTH_SECRET=длинная_случайная_строка_минимум_32_символа
APP_URL=https://browserai-production.up.railway.app
```

Восстановление пароля использует реальные email-сообщения через SMTP. Пока SMTP не настроен, endpoint восстановления вернёт ошибку настройки email-сервиса. Для включения добавьте:

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=BrowserAI <noreply@example.com>
```

Ссылка восстановления ведёт на `APP_URL/?reset_token=...` и действует 1 час.

## Android OTA-обновления APK

Web-интерфейс обновляется автоматически после Railway redeploy. Если меняется native-обёртка Android (`android-app/`), нужен новый APK.

Реализован in-app updater:

- приложение проверяет последний GitHub Release `android-v...`;
- если версия новее установленной, показывает диалог обновления;
- по кнопке **«Обновить»** приложение само скачивает APK из GitHub Release;
- затем открывает системный установщик Android;
- пользователь подтверждает установку, после чего приложение можно открыть снова.

Android не разрешает полностью тихую установку APK вне Google Play, поэтому подтверждение установки всё равно обязательно.

Важно: APK должен быть подписан тем же ключом, что и установленная версия. GitHub Actions workflows создают и кэшируют стабильный `debug.keystore`. После добавления updater нужно один раз вручную установить APK, собранный workflow `Release Android APK`; будущие обновления будут приходить через диалог внутри приложения.

## Менеджер ключей и база данных

- Откройте **«Настройки»** (внизу сайдбара или иконка-шестерёнка в шапке).
- Бейдж рядом с заголовком показывает источник хранения:
  - **БД** (зелёный) — сервер доступен, ключи пишутся в SQLite;
  - **локально** — сервер не запущен, ключи в `localStorage` браузера.
- В разделе **«API-ключи»**:
  - **+ Добавить** — создать ключ: **Имя**, Base URL, API-ключ (с кнопкой-глазом
    👁 для показа/скрытия), Модель.
  - **Проверить валидность** — серверный тест (`/models`, при необходимости
    `/chat/completions`). Серверная проверка не упирается в CORS.
  - **Изменить / Удалить** — редактирование и удаление сохранённых ключей.
  - Клик по строке (радио-кружок слева) — выбрать активный ключ.
  - **Экспорт** — выгрузить все ключи в JSON-файл.
  - **Импорт** — загрузить ключи из JSON (заменяет текущий набор).

### База данных

- Файл: `server/browserai.db` (SQLite, создаётся автоматически, в `.gitignore`).
  В Docker — в томе `/data/browserai.db`.
- Таблицы: `keys` (ключи), `params` (промпт/temperature/stream), `meta` (vault).
- Сменить путь к БД: переменная окружения `BROWSERAI_DB`.
- Сменить порт API: `PORT` (по умолчанию 8787).
- Режим WAL: `journal_mode = WAL` для лучшей производительности.

### 🔒 Шифрование ключей (мастер-пароль)

В настройках есть раздел **«Шифрование ключей»**:

- **Включить шифрование** — задаёте мастер-пароль. Все `api_key` в БД
  шифруются **AES-256-GCM**; ключ шифрования выводится из пароля через
  **scrypt** (N=16384, r=8, p=1, 32 байта). Соль хранится в БД, сам пароль — нет.
- При перезапуске сервера хранилище **заблокировано** — при открытии настроек
  появится экран ввода мастер-пароля (мастер-ключ держится только в памяти
  процесса, пока разблокировано).
- **Сменить пароль** — перешифровывает все ключи; **Отключить** — расшифровывает
  обратно в открытый вид.
- **Автоблокировка при бездействии** — выпадающий список (выкл / 5 / 15 / 30 / 60
  мин). Сервер блокирует хранилище после простоя; настройка хранится в БД.
- **Бэкап БД** — «Экспорт бэкапа» выгружает JSON со **всеми ключами как есть**
  (если шифрование включено — в зашифрованном виде, вместе с salt/verifier),
  параметрами и настройкой автоблокировки. «Восстановить» загружает такой файл
  обратно; для зашифрованного бэкапа после восстановления нужно ввести
  мастер-пароль.

> ⚠️ Мастер-пароль **нельзя восстановить** — забыв его, вы потеряете доступ к
> зашифрованным ключам. Без шифрования ключи в `browserai.db` хранятся в
> открытом виде — не выкладывайте этот файл (и незашифрованный бэкап) в
> публичный доступ.

## Web AI (поиск в интернете)

- Включается переключателем **«Web AI»** в верхней панели.
- При отправке сообщения сервер:
  1. Ищет релевантные результаты через **DuckDuckGo HTML**.
  2. Загружает содержимое страниц через серверный прокси (защита от CORS).
  3. Обогащает системный промпт актуальным web-контекстом.
- Все запросы к внешним сетям проверяются на **SSRF** — блокируются
  localhost, private IP-адреса, `.local` домены.
- DNS-резолвинг дополнительно проверяет, что хост не ведёт на внутренний IP.

## Workspace: управление файлами

- **Создание**: файлы и папки через контекстное меню или кнопки.
- **Загрузка**: drag-and-drop, файловый диалог, загрузка папок (webkitdirectory),
  загрузка по URL.
- **Архивы**: ZIP, TAR, TGZ автоматически распаковываются с проверкой путей
  (защита от path traversal).
- **Просмотр**: текст, код (с подсветкой синтаксиса), изображения, PDF
  (через iframe).
- **Редактирование**: встроенный редактор с кнопками Save/Cancel.
- **История ревизий**: до 30 снапшотов на файл, возможность восстановления.
- **AI-патчинг**: отправка инструкций модели для дифференциального
  редактирования (search/replace).
- **AI-генерация**: создание файлов по текстовому промпту.
- **Перемещение**: drag-and-drop между папками.
- **Поиск**: grep по содержимому всех текстовых файлов.
- **Скачивание**: отдельные файлы или целые папки (ZIP-архив).

## API Reference

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/health` | Проверка работоспособности |
| `GET` | `/api/settings` | Получить настройки и ключи |
| `POST` | `/api/keys` | Сохранить/создать ключ |
| `DELETE` | `/api/keys/:id` | Удалить ключ |
| `POST` | `/api/keys/:id/activate` | Активировать ключ |
| `POST` | `/api/keys/import` | Импорт ключей из JSON |
| `GET` | `/api/keys/export` | Экспорт ключей в JSON |
| `PUT` | `/api/params` | Обновить параметры генерации |
| `POST` | `/api/validate` | Проверить валидность ключа |
| `GET` | `/api/vault/status` | Статус шифрования |
| `POST` | `/api/vault/setup` | Включить шифрование |
| `POST` | `/api/vault/unlock` | Разблокировать хранилище |
| `POST` | `/api/vault/lock` | Заблокировать хранилище |
| `POST` | `/api/vault/change` | Сменить мастер-пароль |
| `POST` | `/api/vault/disable` | Отключить шифрование |
| `POST` | `/api/vault/autolock` | Настроить автоблокировку |
| `GET` | `/api/vault/backup` | Экспорт бэкапа |
| `POST` | `/api/vault/restore` | Восстановление из бэкапа |
| `GET` | `/api/workspace/tree` | Дерево файлов workspace |
| `GET` | `/api/workspace/file` | Содержимое файла |
| `GET` | `/api/workspace/download` | Скачивание файла/папки |
| `POST` | `/api/workspace/folder` | Создать папку |
| `POST` | `/api/workspace/file` | Создать/сохранить файл |
| `PUT` | `/api/workspace/file` | Обновить содержимое файла |
| `POST` | `/api/workspace/rename` | Переименовать |
| `POST` | `/api/workspace/move` | Переместить |
| `DELETE` | `/api/workspace/item` | Удалить |
| `POST` | `/api/workspace/upload` | Загрузить файлы |
| `POST` | `/api/workspace/upload-url` | Загрузить по URL |
| `GET` | `/api/workspace/search` | Поиск по содержимому |
| `GET` | `/api/workspace/history` | История ревизий |
| `POST` | `/api/workspace/history/restore` | Восстановить ревизию |
| `GET` | `/api/web/search` | Поиск в интернете |
| `GET` | `/api/web/fetch` | Загрузить веб-страницу |

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `PORT` | `8787` | Порт API-сервера |
| `BROWSERAI_DB` | `/data/browserai.db` или `server/browserai.db` | Путь к файлу SQLite |
| `WORKSPACE_ROOT` | `/data/workspace` или `./workspace` | Корень файлового workspace |
| `NODE_ENV` | — | `production` для боевого режима |
| `CORS_ORIGIN` | `*` если не задан | Разрешённый origin для CORS |
| `AUTH_SECRET` | dev fallback | Ключ шифрования cloud-sync и секрет auth; в production обязателен |
| `APP_URL` | Railway domain или localhost | Публичный URL для ссылок восстановления пароля |
| `REGISTRATION_SECRET` | — | Секрет для регистрации дополнительных пользователей после первого owner |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | SMTP-настройки для восстановления пароля |

## Структура проекта

```
├── Dockerfile                # multi-stage образ (build фронта + runtime сервера)
├── docker-compose.yml        # запуск одной командой + том для БД
├── nixpacks.toml             # конфиг для деплоя на Railway (Nixpacks)
├── RAILWAY.md                # инструкция по деплою на Railway
├── package.json              # зависимости и скрипты
├── package-lock.json         # замок зависимостей
├── vite.config.js            # конфиг Vite (proxy /api → :8787)
├── tailwind.config.js        # тема: graphite (тёмно-серый) + cream
├── postcss.config.js         # PostCSS конфиг
├── eslint.config.js          # ESLint 9 flat config
├── .gitignore                # node_modules, dist, *.db, IDE
├── .dockerignore             # node_modules, dist, .git, *.db, *.log
├── index.html                # точка входа фронтенда
├── public/
│   └── favicon.svg           # иконка-логотип
├── server/
│   ├── index.js              # Express API: ключи, vault, /validate, workspace, web
│   ├── db.js                 # SQLite-слой (better-sqlite3), миграции, шифрование
│   ├── crypto.js             # AES-256-GCM + scrypt (мастер-пароль)
│   ├── workspace.js          # Файловый workspace: CRUD, ревизии, архивы, SSRF-защита
│   └── web.js                # Web AI: DuckDuckGo поиск, прокси загрузка страниц
└── src/
    ├── main.jsx              # React entry point
    ├── App.jsx               # Layout: Sidebar + Topbar + Composer + Workspace
    ├── index.css             # Tailwind + тема + Markdown стили
    ├── icons.jsx             # Inline SVG-иконки
    ├── components/
    │   ├── Sidebar.jsx       # Список чатов, New Chat, настройки
    │   ├── Topbar.jsx        # Заголовок, статус API, выбор модели, Web AI тоггл
    │   ├── Composer.jsx      # Ввод, отправка, загрузка/DnD файлов, Workspace Picker
    │   ├── MessageList.jsx   # Рендер истории + Markdown + копирование
    │   ├── Workspace.jsx     # Файловое дерево, поиск, AI-генерация/патчинг
    │   ├── FilePreview.jsx   # Просмотр/редактирование файла + история ревизий
    │   ├── FileTree.jsx      # Дерево с цветными иконками + drag-and-drop
    │   └── SettingsModal.jsx # Менеджер ключей, шифрование, параметры генерации
    └── lib/
        ├── api.js            # Chat Completions, SSE-стрим, validateKey()
        ├── backend.js        # Клиент серверного API (REST)
        ├── useSettings.js    # Хук настроек: БД ↔ localStorage fallback
        ├── useChats.js       # Хук состояния чатов, отправки, автосуммаризации
        ├── storage.js        # Персистентность чатов (localStorage)
        ├── settings.js       # Модель настроек + хелперы (resolveActive и т.д.)
        ├── keyfile.js        # Экспорт/импорт ключей в JSON
        ├── files.js          # Чтение/обработка загруженных файлов
        ├── workspace.js      # Клиент Workspace API
        └── markdown.jsx      # Минимальный безопасный Markdown→HTML (DOMPurify)
```

## Технологии

| Компонент | Технология |
|-----------|-----------|
| Фронтенд | React 19, Vite 8, Tailwind CSS 3 |
| Бэкенд | Express 5, better-sqlite3, Node.js 20 (ESM) |
| Шифрование | AES-256-GCM + scrypt (N=16384) |
| Линтинг | ESLint 9 (react-hooks, react-refresh) |
| Безопасность | Helmet, Rate Limiting, SSRF-защита, CORS, DOMPurify |
| Деплой | Docker, Docker Compose, Railway (Nixpacks) |
| Поиск | DuckDuckGo HTML (серверный прокси) |
| Архивы | AdmZip (ZIP), node-tar (TAR/TGZ) |

## Безопасность

- **Helmet** — HTTP-заголовки безопасности
- **Rate Limiting** — 100 запросов/IP за 15 минут
- **CORS** — ограничение origins
- **SSRF-защита** — блокировка private IP, localhost, DNS-проверка
- **Path Traversal защита** — валидация путей в Workspace и архивах
- **DOMPurify** — санитизация Markdown-вывода
- **Шифрование** — AES-256-GCM для API-ключей

## Документация для разработчиков

Для быстрого входа в проект используйте три файла:

- `README.md` — краткое описание продукта, запуска и инфраструктуры;
- `DEVELOPER_GUIDE.md` — подробная карта модулей, функций и пользовательских сценариев;
- `PROJECT_CONTEXT.md` — история важных технических решений, исправлений и деплоя.

### Краткая карта модулей

| Модуль | Для чего нужен | Где смотреть детали |
|---|---|---|
| Auth / Account | Регистрация, вход, logout, reset password, сессии | `DEVELOPER_GUIDE.md` → разделы 2–3 |
| Chats | История чатов, стриминг, summary memory | `DEVELOPER_GUIDE.md` → разделы 4–5 |
| AI Engine | Работа с OpenAI-compatible API, модели, system prompt, temperature | `DEVELOPER_GUIDE.md` → разделы 6–8 |
| Web AI | Поиск по интернету и добавление web-context | `DEVELOPER_GUIDE.md` → раздел 9 |
| Cloud Sync | Синхронизация чатов и настроек между устройствами | `DEVELOPER_GUIDE.md` → раздел 10 |
| Vault | Шифрование API-ключей мастер-паролем | `DEVELOPER_GUIDE.md` → раздел 11 |
| Workspace | Файлы, папки, preview, history, upload, archive extraction | `DEVELOPER_GUIDE.md` → разделы 12–13 |
| Composer Attachments | Загрузка файлов в чат и обработка вложений | `DEVELOPER_GUIDE.md` → раздел 14 |
| UI Layers | Sidebar, Topbar, Settings, MessageList, Markdown renderer | `DEVELOPER_GUIDE.md` → разделы 15–16 |
| Android Wrapper | WebView-приложение, загрузка файлов, OTA APK update | `DEVELOPER_GUIDE.md` → раздел 17 |

### Что уже реализовано в продукте

- аккаунтная авторизация и cloud sync;
- работа с несколькими API-ключами и моделями;
- чат со streaming-ответами;
- Web AI для web-context;
- Workspace с CRUD, preview, history и AI patch/create;
- vault-шифрование ключей;
- Android WebView wrapper с OTA-обновлением APK.

### Что читать новому разработчику в первую очередь

1. Этот `README.md` — чтобы понять запуск и окружение.
2. `DEVELOPER_GUIDE.md` — чтобы понять модули и возможности.
3. `PROJECT_CONTEXT.md` — чтобы понять историю изменений и деплоя.

## Лицензия

MIT
