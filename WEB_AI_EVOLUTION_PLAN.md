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
- Railway
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

## Краткое решение по стратегии

**Основа:** стабильный code-aware retrieval.  
**Дополнение:** session-based source с токенами/куками.  
**Цель:** меньше токенов, точнее код, лучше patch workflow.
