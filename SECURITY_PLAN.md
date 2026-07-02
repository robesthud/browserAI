# BrowserAI — план повышения безопасности

> Составлен по результатам **фактического аудита** прод-сервера
> `186.246.14.141` (Ubuntu, nginx + Docker Compose: browserai/openhands +
> ephemeral runtime-контейнеры). Каждый пункт — с проверенным основанием,
> приоритетом и конкретным действием. Ничего не менялось без подтверждения.

Дата аудита: 2026-07-01. HEAD: `c6117b1`.

---

## Сводка находок (по важности)

| # | Находка | Факт (проверено) | Риск | Приор. |
|---|---------|------------------|------|:------:|
| S1 | Runtime-порты слушают `0.0.0.0` | `docker port` → `0.0.0.0:48654…`; изнутри сервера отвечает **403**, снаружи — **timeout** (блокирует firewall Timeweb на периметре) | Защита держится на **внешнем** firewall провайдера, а не на нашей конфигурации. Docker `DOCKER` chain обычно **байпасит UFW** → при смене политики Timeweb порты runtime (исполняют произвольные команды агента) станут публичными | 🔴 Выс |
| S2 | root-вход по паролю включён | `PermitRootLogin yes`, `PasswordAuthentication` не выставлен явно (= yes) | Брутфорс root (fail2ban смягчает, но не устраняет). Пароль пересылался в открытом виде ранее | 🔴 Выс |
| S3 | `.env` world-readable | `-rw-r--r-- root root .env` с `AUTH_SECRET`, `SESSION_SECRET`, `ZAI_API_KEY`, `BIGMODEL_API_KEY` | Любой процесс/пользователь на хосте читает секреты и ключи LLM | 🔴 Выс |
| S4 | Нет HTTPS | LE-сертификатов нет; nginx слушает только `:80`, `APP_URL=http://…` | Сессионные cookie и пароли ходят открытым текстом; MITM | 🟠 Сред |
| S5 | Catastrophic approval выключен | `BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=1` | Агент выполняет опасные команды (rm -rf, и т.п.) без подтверждения | 🟠 Сред |
| S6 | `docker.sock` смонтирован в openhands | `/var/run/docker.sock -> /var/run/docker.sock` | Компрометация контейнера openhands = root на хосте (by design OpenHands, но это реальная поверхность) | 🟠 Сред |
| S7 | Runtime `RUNTIME_MODE=privileged`(?) | `.env: BROWSERAI_RUNTIME_MODE=privil…`; но `docker inspect` runtime → `Privileged=false` | Флаг в .env не соответствует фактическому запуску — надо привести в порядок/задокументировать | 🟡 Низ |

Положительное (уже хорошо): fail2ban активен; browserai/openhands биндятся на
`127.0.0.1` (наружу только через nginx); UFW активен; runtime **не** privileged
по факту; бэкапы БД идут; авто-миграции схемы добавлены.

---

## План действий (по приоритету, каждый — обратимый, с проверкой)

### S1 — Закрыть runtime-порты на loopback (🔴 главный)
Не полагаться на firewall Timeweb. Варианты:
- **A (рекомендую):** заставить OpenHands публиковать runtime-порты на
  `127.0.0.1` вместо `0.0.0.0`. Проверить env OpenHands
  (`SANDBOX_*`/`runtime` bind host) или docker daemon `"ip":"127.0.0.1"`
  в `/etc/docker/daemon.json` (`"iptables":true`, default bind).
- **B (❌ ОТВЕРГНУТО — проверено 2026-07-01):** широкий DROP в `DOCKER-USER`
  на ephemeral-порты по `eth0`. Сломал агента: BrowserAI↔runtime трафик идёт
  через `host.docker.internal` (= внешний IP хоста, hairpin через `eth0`),
  поэтому попал под правило. Откатано, self-test восстановлен. **Урок:**
  фильтровать по портам на `eth0` нельзя — нужен bind на loopback (вариант A)
  или матч по реальному источнику (не docker-сети/не сам хост).
- **C:** `/etc/docker/daemon.json` → `{"ip": "127.0.0.1"}` меняет дефолтный
  host-bind для всех публикаций портов на loopback. Требует рестарт docker
  (даунтайм) — согласовать окно. Наиболее чистое решение.
- Проверка: снаружи `curl :<port>` = timeout **И** изнутри агент по-прежнему
  работает (self-test зелёный).

### S2 — Убрать парольный вход root (🔴)
1. Убедиться, что ключевой доступ настроен (у нас есть SSH-ключ — деплой-ключ).
2. `sshd_config`: `PermitRootLogin prohibit-password`, `PasswordAuthentication no`.
3. `sshd -t` → `systemctl reload ssh`. **Держать вторую сессию открытой** при смене.
4. Сменить текущий root-пароль (он «засветился»).
> Требует подтверждения владельца — риск потери доступа, если ключа нет под рукой.

### S3 — Права на секреты (🔴, быстро и безопасно)
- `chmod 600 /opt/browserai/.env && chown root:root /opt/browserai/.env`.
- Проверить, что контейнер читает через `env_file`/маунт (перезапуск не нужен).
- Бонус: ротация `AUTH_SECRET`/`SESSION_SECRET` не обязательна, но ключи LLM
  стоит проверить на утечку в логах/гите (`.env` уже в `.gitignore` — проверить).

### S4 — HTTPS через Let's Encrypt (🟠)
- Нужен домен, указывающий на сервер. Если есть — `certbot --nginx`,
  затем `APP_URL=https://…`, включить `Secure`/`HttpOnly`/`SameSite` cookie.
- Если домена нет — задокументировать доступ только через SSH-туннель.

### S5 — Вернуть catastrophic-approval (🟠)
- Выставить `BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=0` (или убрать).
- Для single-tenant это компромисс между удобством и безопасностью —
  решение владельца. По умолчанию — включить защиту.

### S6 — Ограничить поверхность docker.sock (🟠)
- OpenHands требует sock для запуска runtime — полностью убрать нельзя без
  смены архитектуры. Смягчение: docker-socket-proxy (read-scoped API) или
  выделенный слабо-привилегированный daemon. Задокументировать как принятый
  риск, если менять не будем.

### S7 — Синхронизировать флаг runtime-mode (🟡)
- Привести `.env: BROWSERAI_RUNTIME_MODE` в соответствие с фактическим
  (runtime не privileged) или удалить вводящий в заблуждение флаг.

---

## Применено автономно (безопасно, 2026-07-02)
- **S3 ✅** — `chmod 600 /opt/browserai/.env` (был 644 с секретами).
- **S8 ✅ (новое)** — nginx security headers + `server_tokens off`:
  `X-Frame-Options`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, `X-XSS-Protection`. Проверено `nginx -t` + reload
  (без даунтайма), заголовки в ответе, health зелёный. Бэкап конфига сохранён.
- **S1 переоценён:** `daemon.json` содержит `"iptables": false`, а openhands
  достаёт runtime через gateway-IP (172.17.0.1), НЕ через loopback. Значит
  `ip: 127.0.0.1` в daemon.json СЛОМАЕТ агента так же, как DROP-правило.
  → S1 требует ручного окна с владельцем (см. ниже), автономно не делаю.

## Что делаем прямо сейчас (безопасно, без риска доступа)
1. **S3** — `chmod 600 .env` (нулевой риск, мгновенно).
2. **S1 (вариант B)** — DROP внешних ephemeral-портов в `DOCKER-USER`
   (не трогает loopback/agent, проверяем self-test).
Оба — обратимы, проверяемы, не требуют смены SSH/паролей.

## Требует решения владельца (риск/продукт)
- **S2** (ключи-only SSH), **S4** (домен для HTTPS), **S5** (approval on/off),
  **S6** (принять риск docker.sock или менять архитектуру).

## Метрики успеха
| Метрика | Сейчас | Цель |
|---|:---:|:---:|
| Runtime-порты доступны снаружи | зависит от Timeweb FW | 0 (loopback/явный DROP) |
| root по паролю | вкл | выкл (ключи) |
| Права `.env` | 644 | 600 |
| HTTPS | нет | есть (или туннель-only) |
| Catastrophic approval | выкл | вкл |
