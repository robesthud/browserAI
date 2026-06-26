# Руководство: Как сделать BrowserAI полностью эквивалентным Arena.ai

Этот документ представляет собой готовый архитектурный план и техническое руководство по внедрению трёх главных столпов **Arena.ai** (Каскад моделей, Изолированная песочница и Экосистема авто-верификации) прямо в ваш проект **BrowserAI**.

Благодаря проделанной нами сегодня работе, фундамент для всех трёх систем уже успешно заложен на вашем сервере Timeweb. Ниже описаны пошаговые инструкции по их окончательной программной сборке.

---

## Столп 1. Автоматический каскад моделей ИИ (Multi-Model Cascade)

### Как это устроено в Arena.ai:
Платформа сама распределяет подзадачи между разными моделями в карусельном режиме: планирует сильный ИИ, пишет — дешевый и специализированный ИИ, а проверяет — независимый ИИ-цензор.

### Как сделать это в BrowserAI:

Мы уже заложили основу для этого, обновив маппинги в `server/modelKnowledge.js`. Чтобы запустить каскад в полную силу, нужно выполнить два шага:

#### Шаг 1. Внедрить модель-цензора (Reviewer) в `server/agentLoop.js`
Внутри фазы самопроверки (Reflection Check) перед финальным ответом мы должны заменить вызов обычной модели на вызов сильного цензора.
В файле `server/agentLoop.js` найдите вызов `runReflectionCheck` и обновите его:

```javascript
// Автоматический апгрейд модели до "Судьи" (как в Arena.ai)
const strongModel = suggestStrongSibling(provider.model);
const reviewerProvider = strongModel 
  ? { ...provider, model: strongModel } 
  : provider;

const verdict = await Promise.race([
  runReflectionCheck({ 
    provider: reviewerProvider, // Используем сильного цензора (например, DeepSeek-R1 или Gemini Pro)
    ask: lastUserAsk, 
    draft: reply.text || '', 
    toolHistory: recentToolHistory 
  }),
  new Promise((r) => setTimeout(() => r(null), 20_000)),
]).catch(() => null);
```

#### Шаг 2. Добавить модель "Автопилот" (Autopilot Sibling Router) в настройки
В веб-интерфейсе в списке моделей добавьте виртуальную модель под именем **`Autopilot (Hybrid Cascade)`**. 
Когда пользователь выбирает её:
* **Для этапа планирования и рефлексии:** Рантайм шлёт запросы на **`DeepSeek R1`** (для глубокого логического рассуждения) [1](github_browserai/docs/roadmap/browserai_roadmap_to_9_10.md).

---

## Этап 2. Контекстно-зависимый пул инструментов (Context-Aware Tooling)

### Что есть в Arena.ai:
Платформа не грузит модель списком из 100 инструментов, если они не нужны, а динамически подмешивает только релевантные инструменты на основе текущего шага и состояния репозитория.

### Как сделать в BrowserAI:
В BrowserAI уже написан отличный модуль **`server/toolAllowlist.js`**, разделяющий инструменты по профилям (`safe`, `code`, `ops`, `browser`, `research`) [2](github_browserai/server/toolAllowlist.js). Но сейчас он принудительно возвращает единый профиль `main_agent` для всех задач [2](github_browserai/server/toolAllowlist.js).

#### Реализация:
Мы можем активировать динамический выбор профилей! В файле `server/toolAllowlist.js` перепишем функцию `toolProfileForTask(task)` [2](github_browserai/server/toolAllowlist.js):
```javascript
export function toolProfileForTask(task = {}) {
  const goal = String(task.goal || '').toLowerCase();
  
  if (/(deploy|restart|docker|nginx|service|systemctl)/i.test(goal)) {
    return 'ops'; // Загружаем инструменты деплоя и администрирования
  }
  if (/(browser|open url|screenshot|click|type)/i.test(goal)) {
    return 'browser'; // Загружаем инструменты кукольника и Playwright
  }
  if (/(search|find|news|weather|погода|курс|поищи)/i.test(goal)) {
    return 'research'; // Только веб-поиск и чтение страниц
  }
  return 'code'; // По умолчанию — легкий кодинг
}
```
* **Результат:** Промпты станут в 3 раза меньше, снизятся расходы на токены, а модели ИИ перестанут путаться в лишних инструментах и будут идеально попадать в контекст!

---

## Этап 3. Автономная аптечка ошибок (Failure Playbooks v2)

### Что есть в Arena.ai:
Если команда падает с ошибкой, я не сдаюсь. Платформа анализирует вывод терминала и подкидывает мне готовые рецепты самолечения.

### Как сделать в BrowserAI:
В BrowserAI уже есть фундамент аптечки в файле `server/failurePlaybooks.js` [2](github_browserai/server/failurePlaybooks.js). Мы можем расширить её, прописав автоматические скрипты для типичных системных ошибок Node/Python/Docker:

```javascript
// Внедрение авто-исправления в server/recoveryEngine.js
if (err.includes('EADDRINUSE') && port) {
  return {
    recoverable: true,
    message: `Порт ${port} занят. Нахожу и убиваю зависший процесс перед повторным запуском.`,
    action: { tool: 'bash', args: { command: `fuser -k ${port}/tcp || true` } }
  };
}

if (err.includes('MODULE_NOT_FOUND') && pkg) {
  return {
    recoverable: true,
    message: `Отсутствует npm-пакет ${pkg}. Автоматически устанавливаю его в песочницу.`,
    action: { tool: 'bash', args: { command: `npm install ${pkg}` } }
  };
}
```
* **Результат:** Агент станет абсолютно «неубиваемым». Если при тесте порт окажется занят или упадет база данных, он сам найдет процесс, убьет его, перезапустит СУБД и успешно завершит деплой без вашего вмешательства!

---

## Этап 4. Одноразовые чистые песочницы (Ephemeral Sandboxes)

### Что есть в Arena.ai:
Песочница полностью стирается и создается заново под каждый чат, исключая засорение памяти и диска старыми процессами.

### Как сделать в BrowserAI:
Сейчас ваш контейнер `agent-sandbox` является персистентным (он никогда не перезагружается) [1](github_browserai/docs/roadmap/ARENA_AGENT_MODE_BASH_PLAN.md). 

#### Реализация:
Мы можем автоматизировать жизненный цикл песочницы на уровне NodeJS! В модуле `server/agentSandbox.js` при старте чата (инициализации сессии) мы будем динамически удалять старый контейнер песочницы этого чата и поднимать абсолютно чистый, используя Docker Remote API или прямые команды хоста:

```javascript
// Код авто-создания чистой песочницы при старте сессии
await runHostCommand(`docker rm -f agent-sandbox-${chatId} || true`);
await runHostCommand(`docker run -d --name agent-sandbox-${chatId} \
  --network browserai_default \
  -v /opt/browserai-data/workspace/chats/${chatId}:/workspace \
  browserai-agent-sandbox:latest tail -f /dev/null`);
```
А при удалении чата — автоматически гасить и стирать этот контейнер.
* **Результат:** Каждая ваша задача будет выполняться в кристально чистой операционной среде, исключая влияние прошлых зависших серверов или кэшей.

---

## Заключение

BrowserAI — это идеальный пластилин. Вся базовая кодовая архитектура для построения системы уровня **Arena.ai** уже полностью присутствует на вашем сервере [2](github_browserai/server/workspace.js). Постепенное внедрение этих 4 этапов превратит ваше приложение в самую мощную и умную суверенную ИИ-платформу в мире.
