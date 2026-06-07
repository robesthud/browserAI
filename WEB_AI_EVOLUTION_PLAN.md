# Web AI Evolution Plan

## Цель

Превратить текущий `Web AI` из простого режима «поиск + текст страницы» в полноценный модуль retrieval-помощи для разработки, который:

1. помогает модели находить актуальные примеры кода, документацию и конфиги;
2. умеет работать с несколькими источниками;
3. поддерживает экспериментальный режим с пользовательскими сессиями/токенами сайтов как дополнительный источник;
4. сжимает найденное до компактного контекста и реально экономит токены;
5. безопасно связывается с Workspace и AI Patch/Create flow.

---

## Что есть сейчас

Текущий `Web AI`:
- берёт последнее сообщение пользователя как query;
- ищет через DuckDuckGo HTML;
- вытаскивает несколько результатов;
- скачивает несколько страниц через backend;
- превращает HTML в plain text;
- подмешивает текст в system prompt.

Это полезно для общего web-контекста, но слабо подходит для программирования, потому что:
- нет code-aware поиска;
- нет извлечения code snippets;
- нет официальных источников в приоритете;
- нет reranking;
- нет компрессии retrieval-контекста;
- нет кэша;
- нет связи «поиск → patch файла»;
- нет сессионных источников.

---

## Целевая модель

Нужны **два режима Web AI**, которые живут параллельно.

### Режим A — Основной, стабильный, для production
Источник знаний:
- официальный docs retrieval;
- GitHub code/repo search;
- package docs;
- curated web sources.

Назначение:
- надёжный code/document retrieval;
- минимизация токенов;
- стабильность и предсказуемость.

### Режим B — Дополнительный, экспериментальный, session-based
Источник знаний:
- пользовательские cookie/session/token-коннекторы к сайтам, где у пользователя уже есть доступ.

Назначение:
- вытягивать материалы из авторизованных или нестандартных интерфейсов;
- использовать как дополнительный источник, а не как единственную основу.

Важно:
- это будет более хрупкий путь;
- возможны истечения сессий, anti-bot, сломанные UI-потоки;
- использовать как fallback/extra source.

---

## Принципы реализации

1. **Chat model и retrieval должны быть разделены.**
   Модель не «ходит в браузер» напрямую. Retrieval layer приносит ей уже подготовленный контекст.

2. **Сначала local project, потом external sources.**
   При задачах изменения кода приоритет должен быть такой:
   1. Workspace / локальные файлы;
   2. official docs;
   3. GitHub examples;
   4. package docs / Q&A;
   5. session-based источники.

3. **Не страницы целиком, а фрагменты.**
   В модель должны лететь не сырые HTML/text pages, а короткие snippets + summary.

4. **Сессионные источники — только как пользовательские коннекторы.**
   Никакой магии «обхода»; только явно импортированные пользователем сессии/токены.

5. **Всё чувствительное хранить только в шифровании.**
   Cookie/token/session payload хранить только в зашифрованном виде.

---

## Целевая архитектура

### 1. Retrieval Orchestrator
Отвечает за:
- определение, нужен ли web lookup;
- определение типа задачи;
- выбор источников;
- сбор финального retrieval context;
- передачу этого контекста в AI и/или Workspace patch flow.

### 2. Source Connectors
Единый интерфейс источников:
- docs connector;
- GitHub connector;
- package registry/docs connector;
- generic web search connector;
- experimental session connector.

### 3. Browser Worker
Нужен для session-based и сложных JS-страниц.

Лучший стек:
- Playwright.

Что умеет:
- запуск headless browser;
- загрузка cookies/local storage/session token;
- открытие страниц;
- поиск по сайту;
- ожидание рендера;
- extraction code/text/snippets.

### 4. Session Vault
Хранит:
- cookies;
- bearer tokens;
- headers;
- session metadata;
- статус валидации.

### 5. Retrieval Cache / Snippet Store
Нужен для:
- повторного использования результатов;
- уменьшения числа сетевых запросов;
- сокращения токенов;
- стабильной скорости.

### 6. Context Compression Layer
Превращает найденное в компактный packet:
- summary;
- 1–3 snippets;
- source metadata;
- warning / version notes.

### 7. Workspace Integration Layer
Связывает retrieval и AI patching:
- получает текущий файл;
- получает найденные snippets;
- собирает prompt для patch/create;
- применяет изменения к файлам.

---

## Дорожная карта по этапам

# Этап 0 — Подготовка основы

## Цель
Зафиксировать архитектурные точки расширения и не ломать текущий Web AI.

## Что сделать
- выделить текущую web-логику в отдельный retrieval модуль;
- формализовать интерфейс источника;
- добавить флаг режима Web AI;
- добавить feature toggles для новых источников.

## Результат
Текущий Web AI продолжает работать, но код становится готовым к расширению.

## Оценка
Можно начать сразу. Это короткий этап.

---

# Этап 1 — Production-ready code retrieval MVP

## Цель
Сделать действительно полезный для разработки режим Web AI без сессий и без костылей.

## Источники
- official docs;
- GitHub search;
- package docs;
- текущий web search как fallback.

## Что сделать

### 1. Docs-first retrieval
Добавить поиск по приоритетным docs-источникам:
- React
- Vite
- Express
- Docker / Timeweb
- Tailwind
- SQLite / better-sqlite3
- Nodemailer
- Twilio
- OpenAI-compatible providers

### 2. GitHub code search connector
Сделать отдельный коннектор для:
- repo search;
- code example retrieval;
- file-level snippet extraction.

### 3. Code-aware extraction
Извлекать отдельно:
- `pre/code`;
- commands;
- config blocks;
- API signatures;
- file names.

### 4. Snippet ranking
После поиска выбирать только лучшие фрагменты.

### 5. Context compression
Сжимать найденное до компактного блока, пригодного для модели.

### 6. Retrieval packet format
Внутренний формат результата:
- source type;
- title;
- url;
- relevance;
- summary;
- snippets[];
- version note;
- usage note.

### 7. Workspace-aware patch flow
Новый сценарий:
- user request;
- retrieval;
- current file;
- prompt for AI patch;
- apply patch.

## Результат
Это уже даст реальную пользу и заметную экономию токенов.

## Оценка
Первый по-настоящему полезный этап. Его можно делать первым делом.

---

# Этап 2 — Экспериментальный session-based источник

## Цель
Добавить дополнительный режим источников через пользовательские сессии/токены.

## Важно
Этот этап делать **после Этапа 1**, а не вместо него.

## Что именно поддерживать
Разрешить пользователю подключать источники одного из типов:
- cookie-based session;
- bearer token;
- custom headers;
- local/session storage payload;
- domain-bound auth profile.

## Как это использовать
Как **дополнительный источник**, когда нужно:
- вытащить инфу из авторизованного сайта;
- искать внутри приватной документации;
- использовать нестандартный web-интерфейс.

## Что сделать

### 1. Таблицы в БД
Добавить, например:
- `retrieval_connectors`
- `retrieval_connector_secrets`
- `retrieval_cache`
- `retrieval_runs`

### 2. Шифрование session payload
Все cookie/token/session данные хранить:
- либо через vault,
- либо через отдельный encrypted blob с backend secret.

### 3. UI в настройках
Новый раздел:
- Web Sources / Connectors;
- список источников;
- добавить источник;
- импорт сессии/токена;
- включить/выключить источник;
- проверить источник;
- удалить источник.

### 4. Browser worker на Playwright
Для session connector нужен реальный headless browser.

### 5. Session validation
Проверка:
- сессия жива;
- домен доступен;
- источник может выполнить test query.

### 6. Read-only режим по умолчанию
По умолчанию session connector должен:
- читать страницы;
- искать;
- извлекать данные;
- НЕ выполнять опасные действия.

## Результат
Появится рабочий, но экспериментальный способ брать инфу через пользовательские сессии.

## Оценка
Это можно сделать как «костыль, но рабочий» дополнительный вариант после базового retrieval MVP.

---

# Этап 3 — Реальная экономия токенов

## Цель
Сделать так, чтобы Web AI не просто искал, а действительно уменьшал размер контекста и стоимость запросов.

## Что сделать

### 1. Кэш запросов
Кэшировать:
- query → result set;
- url → extracted snippets;
- normalized docs chunks.

### 2. Dedupe
Убирать:
- повторяющиеся страницы;
- одинаковые snippets;
- одинаковые docs mirrors.

### 3. Query rewriting
Из пользовательского запроса строить уточнённые поисковые подзапросы.

### 4. Task classification
Понимать, что нужно:
- docs;
- code example;
- bug fix;
- config;
- migration;
- issue workaround.

### 5. Token budget control
Ввести budget на retrieval context:
- max sources;
- max snippets;
- max chars/tokens per source;
- hard cap total context.

### 6. Summary before AI
Если найденного много, сначала сжать retrieval локально/вспомогательной моделью, а потом только давать основной модели.

## Результат
Web AI начнёт реально экономить токены, а не только увеличивать качество ответа.

---

# Этап 4 — Полноценный режим для агентной разработки

## Цель
Связать поиск, локальный проект и файловые операции в единый dev-assistant workflow.

## Что сделать

### 1. Mixed retrieval
Одновременно использовать:
- local project search;
- workspace file context;
- official docs;
- GitHub examples;
- optional session source.

### 2. Planner/orchestrator flow
Логика вида:
1. понять задачу;
2. решить, нужен ли поиск;
3. выбрать источник;
4. собрать контекст;
5. сформировать patch prompt;
6. применить изменения;
7. показать diff/result.

### 3. Source-aware patching
Для каждого patch-а хранить:
- на что опирались;
- какой snippet использован;
- какие файлы изменены.

### 4. Explainability mode
Показывать пользователю:
- какие источники использованы;
- какие snippets повлияли на изменение;
- почему был сделан именно такой patch.

## Результат
Это уже будет полноценный dev-oriented Web AI, а не просто поиск по интернету.

---

## Порядок реализации

### Правильный порядок
1. Этап 0 — подготовить архитектуру
2. Этап 1 — docs/GitHub/snippet MVP
3. Этап 3 — token-saving механики
4. Этап 2 — session-based source как дополнительный режим
5. Этап 4 — полноценный orchestration flow

### Почему именно так
Потому что если начать с session-костылей, получится хрупкая система без хорошей базы. Сначала нужен нормальный retrieval для кода, потом уже дополнительный нестабильный источник.

---

## Минимальный рабочий план, если нужно быстро

Если цель — получить пользу как можно быстрее, то делаем такой MVP-путь:

### Фаза MVP-A
- вынести current Web AI в retrieval module;
- добавить GitHub search connector;
- добавить docs-first retrieval;
- сделать snippet extraction;
- сделать compact retrieval packet;
- использовать это в AI Patch flow.

### Фаза MVP-B
- добавить session connector;
- импорт cookie/token;
- browser worker на Playwright;
- validate session;
- использовать как optional extra source.

### Фаза MVP-C
- кэш;
- reranking;
- query rewriting;
- token budget.

---

## Что конкретно даст экономию токенов

Самые эффективные механики экономии:

1. **официальные источники вместо общего web search**
2. **поиск snippets вместо целых страниц**
3. **reranking лучших 2–3 фрагментов**
4. **кэш retrieval результатов**
5. **budget cap на web-context**
6. **mixed local+external retrieval вместо огромного prompt**
7. **pre-summary найденного контекста**

Если всё это сделать, Web AI будет реально экономить токены, а не просто добавлять шум.

---

## Что считаем успехом

### Успешный результат этапа 1
- Web AI находит кодовые примеры лучше текущей версии;
- retrieval context компактный;
- AI patch начинает лучше редактировать файлы.

### Успешный результат этапа 2
- можно подключить пользовательский session source;
- источник валидируется;
- можно получить данные из авторизованного UI/сайта.

### Успешный результат этапа 3
- уменьшается размер web-context;
- повторные запросы быстрее;
- снижается средний token cost.

### Успешный результат этапа 4
- появляется почти полноценный dev-assistant workflow:
  поиск → контекст → patch → сохранение.

---

## Что делать следующим шагом

### Следующий практический шаг
Начинать с **Этапа 0 + Этапа 1**.

То есть прямо сейчас логичный следующий пакет работ:
1. спроектировать retrieval interface;
2. вынести current Web AI из `api.js` в отдельный модуль;
3. добавить docs-first и GitHub connector;
4. сделать snippet extraction;
5. подключить retrieval packet в AI patch workflow.

### Session source
Сессионный режим не отменяется — он идёт **сразу после MVP retrieval**, как отдельный дополнительный источник.

---

## Детальный план по варианту №2: Web Session Sources (DeepSeek / Gemini / другие)

Этот раздел описывает именно второй путь — использование web-сессий/токенов как дополнительного источника знаний. Это не основной production-путь, а **экспериментальный retrieval-режим**, который можно включать как extra source.

---

### Идея режима

Пользователь подключает к BrowserAI внешний web-источник, в котором уже есть:
- авторизация;
- поиск;
- ответы модели;
- документация;
- private knowledge;
- внутренний UI.

BrowserAI не делает этот источник своей основной моделью. Вместо этого он использует его как **внешний браузерный источник**, чтобы:
1. задать вопрос через сессию;
2. получить ответ / код / выдержку;
3. привести результат к нормализованному retrieval packet;
4. передать это основной модели BrowserAI;
5. на основе этого уже редактировать файлы в Workspace.

То есть схема такая:

**User request → session source → normalized snippets/summary → main AI model → patch/create file**

---

### Какие сценарии должен поддерживать session-based режим

#### Сценарий A — «спросить web-модель как дополнительный источник»
Пример:
- пользователь пишет: «найди актуальный способ сделать такую кнопку в React»;
- BrowserAI отправляет этот вопрос в DeepSeek web или Gemini web через сохранённую сессию;
- получает ответ, snippets и советы;
- извлекает полезную часть;
- отдаёт её основной модели BrowserAI;
- основная модель патчит файл проекта.

#### Сценарий B — «использовать search внутри авторизованного UI»
Пример:
- источник — закрытая документация или custom knowledge base;
- BrowserAI через браузерную сессию открывает поиск, вводит query, переходит по результатам;
- вытаскивает релевантные code blocks / text chunks;
- передаёт в patch workflow.

#### Сценарий C — «получить второе мнение от другой модели»
Пример:
- основная рабочая модель — через API;
- session source — Gemini web / DeepSeek web;
- BrowserAI использует web-модель как дополнительный reviewer / retriever, а не как основной engine.

---

### Что должен уметь session connector

Каждый session connector должен поддерживать единый интерфейс:

- `validate()` — проверить, что сессия жива;
- `search(query)` — выполнить поиск или задать вопрос;
- `fetch(query)` — получить результат в raw-формате;
- `extract(raw)` — вытащить текст, код, ссылки, metadata;
- `normalize(result)` — привести к retrieval packet;
- `refresh()` — обновить состояние сессии, если возможно;
- `disable()` — отключить connector при невалидной сессии.

---

### Какие типы секретов/сессий надо поддержать

Нужно поддержать несколько форматов, потому что разные сервисы авторизуются по-разному:

1. **Cookie set**
   - импорт cookie в JSON / Netscape format;
   - привязка к домену;
   - browser worker загружает cookie в isolated profile.

2. **Bearer token / access token**
   - если источник работает через API-like headers.

3. **Custom headers**
   - для нестандартных внутренних систем.

4. **localStorage / sessionStorage payload**
   - для SPA, где авторизация сидит в storage.

5. **Hybrid auth profile**
   - cookie + headers + localStorage вместе.

---

### Где и как это хранить

#### Новые таблицы в SQLite

Рекомендуемые таблицы:

- `retrieval_connectors`
  - `id`
  - `name`
  - `type` (`docs`, `github`, `session-web`, `custom-api`)
  - `provider` (`deepseek-web`, `gemini-web`, `custom-site`)
  - `enabled`
  - `priority`
  - `mode` (`search`, `qa`, `hybrid`)
  - `created_at`
  - `updated_at`
  - `last_validated_at`
  - `last_status`

- `retrieval_connector_secrets`
  - `connector_id`
  - `payload_encrypted`
  - `payload_version`

- `retrieval_cache`
  - `connector_id`
  - `query_hash`
  - `result_payload`
  - `created_at`
  - `expires_at`

- `retrieval_runs`
  - история вызовов retrieval layer
  - какие источники использовались
  - сколько snippet'ов вернулось
  - сколько символов ушло в модель

#### Шифрование

Все session payload хранить только в зашифрованном виде:
- через текущий vault;
- либо через отдельный encrypted storage layer;
- plaintext cookie/token никогда не хранить открыто в БД.

---

### Browser Worker: обязательная часть

Для session-based сценария `fetch()` недостаточно. Нужен **реальный браузерный runtime**.

#### Стек
Рекомендуется:
- **Playwright**

#### Почему именно он
Потому что нужен функционал:
- загрузить cookies;
- загрузить localStorage/sessionStorage;
- открыть страницу;
- дождаться SPA-render;
- вводить query;
- кликать по результатам;
- собирать DOM-данные;
- извлекать code blocks.

#### Базовые возможности browser worker
- isolated browser context на каждый connector;
- headless mode;
- timeout control;
- safe navigation rules;
- DOM extraction helpers;
- screenshots/debug traces по необходимости.

---

### Как должен выглядеть пользовательский flow

#### Этап 1 — Добавление источника
Пользователь в настройках открывает новый раздел:
- **Web Sources / Session Sources**

И выбирает:
- DeepSeek Web
- Gemini Web
- Custom Site
- Other

#### Этап 2 — Импорт сессии
Пользователь вставляет одно из:
- cookies;
- token;
- browser session JSON;
- custom headers.

#### Этап 3 — Валидация
BrowserAI запускает `validate()`:
- пробует открыть страницу;
- проверяет, что не разлогинен;
- проверяет, что можно выполнить test query.

#### Этап 4 — Использование в запросе
Когда пользователь пишет задачу, orchestrator решает:
- надо ли использовать session source;
- какой именно connector вызывать;
- сколько источников использовать.

#### Этап 5 — Получение ответа из session source
Browser worker:
- открывает сайт;
- выполняет query;
- ждёт появления результата;
- извлекает snippets / text / links / metadata.

#### Этап 6 — Нормализация
Результат приводится к единому формату retrieval packet.

#### Этап 7 — Передача основной модели
В main AI prompt летит не вся страница и не вся переписка, а только:
- краткая summary;
- 1–3 релевантных snippets;
- source metadata.

#### Этап 8 — Patch/Create file
Основная модель использует retrieval packet, чтобы:
- создать файл;
- изменить файл через patch;
- объяснить изменения.

---

### Форматы retrieval packet для session source

#### Вариант 1 — если получили ответ модели

```json
{
  "sourceType": "session-web-model",
  "provider": "deepseek-web",
  "title": "DeepSeek Web Answer",
  "url": "https://...",
  "query": "...",
  "summary": "Краткий вывод ответа",
  "snippets": [
    {
      "kind": "code",
      "language": "javascript",
      "content": "..."
    }
  ],
  "notes": ["..."],
  "retrievedAt": "..."
}
```

#### Вариант 2 — если получили документ/страницу

```json
{
  "sourceType": "session-web-page",
  "provider": "custom-site",
  "title": "Internal Docs Page",
  "url": "https://...",
  "summary": "О чём страница",
  "snippets": [
    {
      "kind": "code",
      "language": "ts",
      "content": "..."
    },
    {
      "kind": "text",
      "content": "..."
    }
  ]
}
```

---

### Ограничения и правила безопасности

#### 1. Session source не должен быть единственным источником
Использовать его как:
- optional extra source;
- fallback;
- reviewer;
- private knowledge retriever.

#### 2. По умолчанию read-only
Никаких действий типа:
- publish;
- submit forms;
- modify account state;
- execute external destructive actions.

#### 3. Ограничение доменов
Каждый connector должен быть привязан к allowlist доменов.

#### 4. Timeout и retries
Нужны строгие лимиты:
- navigation timeout;
- action timeout;
- extraction timeout;
- retry count.

#### 5. Логи без утечек
Нельзя логировать:
- cookie payload;
- access token;
- session storage plaintext.

---

## Этапность именно для варианта №2

### Session Stage S0 — Архитектурная подготовка
Что делаем:
- закладываем abstraction layer `connector interface`;
- добавляем в orchestrator понятие `sourceType=session-web`;
- подготавливаем DB schema под connectors.

Когда делать:
- параллельно или сразу после базового retrieval interface.

Результат:
- проект готов принять session sources без переписывания основной логики.

---

### Session Stage S1 — Session Vault и UI управления источниками
Что делаем:
- таблицы connectors/secrets/cache/runs;
- backend CRUD API для connectors;
- UI для добавления/удаления/включения/выключения connectors;
- импорт cookie/token/session payload;
- encrypted storage.

Когда делать:
- после базового retrieval MVP (после Этапа 1 основной дорожной карты).

Результат:
- пользователь может подключить session source, но он ещё не используется полноценно.

---

### Session Stage S2 — Browser Worker MVP
Что делаем:
- подключаем Playwright;
- создаём isolated browser contexts;
- умеем загружать cookie/localStorage;
- делаем `validateSession()`;
- делаем debug-mode для проверки коннектора.

Когда делать:
- сразу после S1.

Результат:
- BrowserAI может проверить: жив ли DeepSeek/Gemini/custom session source.

---

### Session Stage S3 — Первый адаптер: DeepSeek Web
Что делаем:
- описываем provider adapter `deepseek-web`;
- сценарий: открыть сайт, вставить query, дождаться ответа, забрать результат;
- extraction:
  - plain answer;
  - code blocks;
  - ссылки/notes при наличии;
- normalization в retrieval packet.

Когда делать:
- после S2.

Результат:
- DeepSeek Web работает как дополнительный источник знаний.

---

### Session Stage S4 — Второй адаптер: Gemini Web
Что делаем:
- adapter `gemini-web`;
- отдельные selectors/flows;
- extraction под конкретный UI Gemini.

Когда делать:
- после DeepSeek Web, потому что infrastructure уже будет готова.

Результат:
- можно выбирать несколько web-model sources.

---

### Session Stage S5 — Generic Custom Site Connector
Что делаем:
- generic connector для сайтов, где есть:
  - login session;
  - поиск;
  - контент;
- source mapping rules:
  - search URL pattern;
  - selectors;
  - snippet extraction rules.

Когда делать:
- после конкретных adapters, когда станет понятен универсальный abstraction shape.

Результат:
- пользователи смогут подключать свои сайты/доки.

---

### Session Stage S6 — Orchestrator Integration
Что делаем:
- orchestrator решает, когда использовать session source;
- priority rules;
- combination с docs/GitHub/local retrieval;
- budget limits на session results.

Когда делать:
- после S3/S4, когда хотя бы один session source реально работает.

Результат:
- session source начинает работать в общем pipeline, а не отдельно.

---

### Session Stage S7 — Token Saving Layer для session sources
Что делаем:
- compression;
- dedupe;
- snippet-only mode;
- cache;
- summary-before-main-model.

Когда делать:
- после подключения session sources в orchestrator.

Результат:
- session mode перестаёт быть дорогим и шумным.

---

### Session Stage S8 — Workspace Patch Flow
Что делаем:
- добавляем режим:
  - user asks for change;
  - system consults session source;
  - main AI builds patch;
  - patch applies to workspace.

Когда делать:
- после S6/S7.

Результат:
- session source становится не просто поиском, а частью реального dev workflow.

---

## Порядок работ относительно основной дорожной карты

### Правильный порядок
1. Основной Этап 0 — retrieval architecture foundation
2. Основной Этап 1 — code-aware retrieval MVP
3. Session Stage S0
4. Session Stage S1
5. Session Stage S2
6. Session Stage S3 (DeepSeek Web)
7. Session Stage S4 (Gemini Web)
8. Основной Этап 3 — token saving
9. Session Stage S6–S8
10. Основной Этап 4 — full orchestrator flow

### Почему так
Потому что session source сам по себе не должен стать «кривой заменой нормального retrieval». Сначала нужна хорошая база поиска и компрессии, потом уже дополнительные web-session источники.

---

## Минимально рабочий экспериментальный вариант

Если нужно сделать именно «костыль, но рабочий» быстро, то минимальный путь такой:

### Быстрый Session MVP
1. Таблица connectors + encrypted secrets
2. UI для импорта cookie/token
3. Playwright worker
4. Один adapter: `deepseek-web`
5. Один adapter: `gemini-web`
6. Вызов session source только вручную или по флагу
7. Из ответа брать:
   - summary
   - code blocks
8. Передавать это основной модели в AI patch prompt

### Что получим
- уже можно будет использовать DeepSeek/Gemini web как дополнительный источник;
- но это ещё не будет оптимально по токенам;
- token optimization придёт на следующем шаге.

---

## Риски варианта №2

1. сайты меняют UI;
2. ломаются селекторы;
3. истекают cookie;
4. anti-bot может блокировать автоматизацию;
5. источники могут отвечать нестабильно;
6. поддержка такого режима дороже, чем обычного docs/GitHub retrieval.

Поэтому этот режим должен быть помечен как:
- experimental;
- optional;
- best-effort.

---

## Когда именно это реально внедрять

### Сразу сейчас не первым номером
Не стоит начинать проект развития Web AI именно с сессий.

### Реалистичный момент старта
Начинать вариант №2 стоит **после того, как будет готов code-aware retrieval MVP**:
- интерфейс источников;
- docs/GitHub retrieval;
- snippet extraction;
- basic compression.

То есть practically:
- сначала сделать **основу Этапа 1**;
- потом сразу переходить к **Session S1–S4**.

---

## Что считать готовностью варианта №2

Вариант считается готовым, когда:

1. пользователь может добавить DeepSeek/Gemini session source;
2. система умеет проверить, что источник жив;
3. можно выполнить query через этот источник;
4. можно извлечь code/text fragments;
5. результат нормализуется в retrieval packet;
6. main model использует это для patch/create file;
7. токены не тратятся на сырые ответы целиком.

---

## Краткое решение по стратегии

**Основа:** стабильный code-aware retrieval.  
**Дополнение:** session-based source с токенами/куками.  
**Цель:** меньше токенов, точнее код, лучше patch workflow.
