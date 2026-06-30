# BrowserAI — Документация

## Быстрый старт

1. Открой браузер → `http://<your-server-ip>:8080`
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
- 📁 — прикрепить файл / скриншот
- ▶ / ⏹ — запустить / остановить агента
- «Фон» — запустить агента в фоне, продолжить другие задачи

---

## Dev Mode и Operator Console

По умолчанию BrowserAI показывает только чат с агентным режимом — чистый, минимальный интерфейс.

**Dev Mode** (опционально) — раскрывает инструменты для разработчиков и операторов:
- Включение: Настройки → «Включить Dev Mode»
- Sidebar: кнопка 🧪 Dev Lab (диагностика, провайдер-чеки, event replay)
- Sidebar: кнопка 🎯 Operator (миссии, инциденты, деплои)

> **Внимание:** Operator Console — в активной разработке (WIP). Большинство
> эндпоинтов — заглушки, панели отрисовываются с WIP-маркерами 🚧.

### Operator Console (`/operator`, только Dev Mode)

Вкладки:
- **Миссии** — запущенные и завершённые operator missions + dependency graph *(WIP)*
- **Проекты** — репозитории, команды, политики *(WIP)*
- **Инциденты** — производственные инциденты + авто-восстановление *(WIP)*
- **Деплои** — deploy sessions с rollback *(stub)*
- **Runbooks** — процедуры и уроки агента *(stub)*
- **Автоматизация** — GitHub webhooks, Automation Center *(stub)*
- **Политики** — редактор политик безопасности *(partial)*
- **Обзор** — дашборд, уведомления, inbox *(partial)*

---

## Безопасность

- Пароли: bcrypt (cost 12)
- Сессии: подписанные HttpOnly cookie (itsdangerous)
- API-ключи: Vault с шифрованием (PBKDF2 + AES-GCM)
- SSRF защита: внутренние IP заблокированы
- SQL: whitelist валидация имён таблиц
- Markdown: DOMPurify с allowlist тегов
- AUTH_SECRET: обязательный в production (NODE_ENV=production)

---

## Устранение проблем

**Агент говорит "невозможно в sandbox"** — это галлюцинация. Напиши:
> "Стоп. Выполни прямо сейчас: `curl -s https://api.github.com/zen`. После покажи вывод."

**Нет streaming (пачками выдаёт)** — Проверь настройки провайдера.

**Диск заполнен** — `du -sh /opt/browserai-data/*`

---

## См. также

- [Release checklists](release/release-checklist.md)
- [Rollback plan](release/rollback-checklist.md)
- [Backup policy](release/backup-policy.md)
- [SSE contract](sse-contract.md)
- [Provider support matrix](providers/support-matrix.md)
