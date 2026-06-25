# BrowserAI — Документация

## Быстрый старт

1. Открой браузер → `http://186.246.31.78`
2. Зарегистрируйся (первый пользователь = owner)
3. Настройки → добавь API ключ (DeepSeek/Gemini/OpenAI/OpenRouter)
4. Напиши задачу в чат — агент выполнит её автоматически

---

## Чат и Агент

**Основной экран** — просто опиши задачу, агент сделает сам:
- Читает файлы workspace
- Запускает команды в sandbox (bash, git, npm, docker)
- Проверяет результат и сообщает о проблемах

**Кнопки**:
- 🎤 — голосовой ввод (STT, только Chrome/Safari)
- 📁 — прикрепить файл / скриншот
- ▶ / ⏹ — запустить / остановить агента
- «Фон» — запустить агента в фоне, продолжить другие задачи

**Настройки агента** (`⚙️ → Agent`):
- Политика подтверждений: YOLO / Безопасный / Строгий
- Max Steps: слайдер 0–100 (0 = авто по сложности задачи)
- Память: факты, воспоминания, контекст проекта
- MCP Marketplace: подключить GitHub, Postgres, Slack и др.

---

## Operator Console (`/operator`)

Доступен через кнопку "🎯 Operator Console" в Agent Lab.

Вкладки:
- **Миссии** — запущенные и завершённые operator missions + dependency graph
- **Проекты** — репозитории, команды, политики
- **Инциденты** — производственные инциденты + авто-восстановление
- **Деплои** — deploy sessions с rollback
- **Runbooks** — процедуры и уроки агента
- **Автоматизация** — GitHub webhooks, Automation Center
- **Политики** — редактор политик безопасности + audit log
- **Обзор** — дашборд, уведомления, inbox

### Запуск миссии

Через чат:
```
Создай фичу X и доведи до продакшена
```

Или через Agent Lab → Operator → OperatorConsole → "New Mission".

Типы миссий:
- `universal_dev_task` — любая задача разработки
- `full_dev_cycle` — код → PR → CI → авто-фикс → merge → deploy
- `code_task` — только разработка и верификация
- `fix_tests` — починить тесты/сборку
- `full_diagnostic` — диагностика production
- `safe_deploy` — безопасный деплой с rollback
- `self_heal_restart` — самовосстановление + health check

---

## Деплой на сервер

**Правило**: push в GitHub → платформа собирает автоматически.

**Никогда не использовать** `railway up`, `vercel deploy`, `netlify deploy` напрямую из sandbox — они падают с EACCES.

### Railway
```bash
# 1. Push в GitHub
git remote set-url origin https://TOKEN@github.com/USER/REPO.git
git push origin main

# 2. Подключить через API
curl -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ me { workspaces { id name } } }"}'
# ... (полный sequence в /workspace/AGENTS.md)
```

### SSH/VPS
```bash
sshpass -p 'PASS' ssh -o StrictHostKeyChecking=no root@IP \
  'cd /opt/app && git pull && docker compose up -d'
```

---

## Telegram интеграция

1. Создай бота через @BotFather → получи `TG_BOT_TOKEN`
2. Добавь в `.env`: `TG_BOT_TOKEN=...`, `TG_ADMIN_CHAT_ID=...`
3. Отправь боту `/start`

Команды бота:
- `/status` — состояние сервера
- `/deploy` — запустить safe deploy
- `/health` — health check
- `/logs` — последние логи

Уведомления приходят автоматически при:
- Production health failure (watchdog)
- Disk > 80% (disk alert)
- Завершении миссии
- Инцидентах высокой серьёзности

---

## GitHub Webhook

1. Репозиторий → Settings → Webhooks → Add webhook
2. URL: `https://YOUR_DOMAIN/api/webhooks/github`
3. Content type: `application/json`
4. Secret: `GITHUB_WEBHOOK_SECRET` из `.env`
5. Events: Issues, Issue comments, Pull requests, PR review comments, Workflow runs, Push

Команды в issue/PR комментариях:
- `/browserai run <задача>` — запустить миссию
- `/browserai review` — code review
- `/browserai fix-ci` — починить CI
- `/browserai status` — статус
- `/browserai help` — помощь

---

## MCP серверы

Настройки агента → MCP Marketplace → установить в один клик.

Доступные: GitHub, PostgreSQL, SQLite, Sentry, Puppeteer, Brave Search, Slack, Notion, Google Drive, Redis, MySQL, MongoDB и другие.

---

## Переменные окружения

| Переменная | Описание | Обязательно |
|-----------|----------|-------------|
| `SESSION_SECRET` | Секрет сессий (>32 символов) | ✅ |
| `AUTH_SECRET` | Ключ шифрования БД | ✅ |
| `GITHUB_TOKEN` | Personal Access Token | Для GitHub ops |
| `TG_BOT_TOKEN` | Telegram bot token | Для TG уведомлений |
| `TG_ADMIN_CHAT_ID` | ID admin chat | Для TG уведомлений |
| `GITHUB_WEBHOOK_SECRET` | Webhook подпись | Для GitHub webhook |
| `BACKUP_KEEP_LAST` | Сколько бэкапов хранить | 3 |
| `BROWSERAI_MAX_STEPS` | Макс. шагов агента | авто |
| `DEEPSEEK_STREAMING` | Включить DS streaming | 1 |
| `GEMINI_STREAMING` | Включить Gemini streaming | 1 |
| `WATCHDOG_DISK_WARN_PCT` | % диска для TG warning | 80 |
| `WATCHDOG_DISK_CRIT_PCT` | % диска для TG critical | 92 |

---

## Безопасность

- Токены в сообщениях автоматически маскируются (`<redacted>`) перед отправкой в LLM
- Токены маскируются в localStorage перед сохранением
- Секреты (`.env`, `*.key`, `*.pem`) не попадают в архивы и коммиты
- SSRF защита: внутренние IP заблокированы для всех внешних запросов
- Webhook подписи верифицируются через HMAC-SHA256
- Rate limiting: 5 попыток входа/мин, 30 agent запросов/мин

---

## Устранение проблем

**Агент говорит "невозможно в sandbox"** — это галлюцинация. Напиши:
> "Стоп. Выполни прямо сейчас: `curl -s https://api.github.com/zen`. После покажи вывод."

**Нет streaming (пачками выдаёт)** — Проверь настройки провайдера. DeepSeek и Gemini streaming включены по умолчанию. OpenRouter всегда стримит.

**Диск заполнен** — Получишь Telegram алерт. Вручную: `du -sh /opt/browserai-data/*`

**Сервер упал** — Telegram watchdog пришлёт уведомление и попробует авто-восстановление.
