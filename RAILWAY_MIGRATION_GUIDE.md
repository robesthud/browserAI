# Инструкция по переезду на новый сервер Railway (Migration Guide)

Этот гайд поможет вам быстро развернуть BrowserAI на новом аккаунте Railway без ошибок сборки и потери данных.

## 1. Подготовка (на старом сервере)
1. Откройте ваш BrowserAI, зайдите в **Настройки** -> **Экспорт** и сохраните файл `keys_backup.json`.
2. Если у вас есть важные файлы в **Workspace**, скачайте их (кнопка "Скачать папку" в интерфейсе).

## 2. Создание проекта на новом Railway
1. Создайте новый пустой проект (Empty Project).
2. Добавьте два сервиса:
   - **browserAI** (подключите репозиторий `robesthud/browserAI`).
   - **lmarena-bridge** (подключите репозиторий `CloudWaddie/LMArenaBridge` или `jtostrings/LMarenaBridge`).

## 3. Настройка хранилища (Volume)
**Критически важно для сохранения истории и ключей:**
1. В панели Railway нажмите **New** -> **Volume**. Назовите его `browserai-data`.
2. Зайдите в настройки сервиса **browserAI** -> **Settings** -> **Volumes**.
3. Нажмите **Mount Volume** и укажите путь: `/data`.
   *Теперь база данных будет лежать в `/data/browserai.db`, а файлы в `/data/workspace`.*

## 4. Переменные окружения (Variables)

### Для сервиса `browserAI`:
| Переменная | Значение | Описание |
|------------|----------|----------|
| `PORT` | `8787` | Порт сервера |
| `AUTH_SECRET` | `ваша_секретная_строка` | Ключ шифрования (минимум 32 символа) |
| `BROWSERAI_DB` | `/data/browserai.db` | Путь к БД на диске |
| `WORKSPACE_ROOT` | `/data/workspace` | Путь к файлам на диске |
| `ARENA_AUTH_COOKIE` | `base64-...` | Ваша полная кука Arena (обязательно!) |
| `RAILWAY_API_TOKEN` | `ваш_PAT_токен` | Токен из настроек аккаунта Railway для автообновления кук |
| `CF_PROXY_URL` | `https://...` | (Опционально) Прокси для обхода блокировок |

### Для сервиса `lmarena-bridge`:
**Важно:** Бриджу нужны системные библиотеки для запуска браузера.
1. Установите переменную `NIXPACKS_APT_PKGS` со следующим списком (в одну строку):
   `libgtk-3-0 libasound2 libnss3 libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrender1 libxtst6 libglib2.0-0 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libgcc-s1 libc6 libdbus-1-3 libxcb1 libxkbcommon0 libgbm1 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxt6 libdbus-glib-1-2 libpci3 libegl1 libopus0 libevent-2.1-7 ca-certificates`
2. Переменная `NIXPACKS_START_CMD`: `python3 -m src.main`
3. `LMARENA_AUTH_TOKENS`: ваша кука `base64-...`
4. `LMARENA_API_KEY`: придумайте ключ (например `sk-arena-123`)

## 5. Исправление кода под новый аккаунт
Если вы меняете аккаунт, обновите в файле `server/arenaCookieRefresher.js` следующие константы:
- `projectId`
- `envId`
- `bridgeServiceId`
Их можно взять из URL браузера, когда вы находитесь в панели управления сервисом.

## 6. Решение проблем (Troubleshooting)
- **Ошибка "Cannot GET /"**: Это значит, что папка `dist` не собралась или попала в `.dockerignore`. Убедитесь, что в корне проекта есть файл `nixpacks.toml` с командой `npm run build`.
- **Бридж выдает 502**: Проверьте логи бриджа. Если там ошибка `Browser process failed to launch`, значит не хватает какой-то библиотеки из списка в пункте 4.
- **Arena просит капчу**: Обновите `ARENA_AUTH_COOKIE` в переменных Railway, взяв свежую куку `arena-auth-prod-v1` с сайта `arena.ai`.

---
*Инструкция создана автоматически для упрощения миграции проекта.*
