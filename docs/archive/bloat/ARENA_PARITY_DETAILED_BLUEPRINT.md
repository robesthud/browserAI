# Чертеж и детальный план внедрения паритета с Arena.ai (Granular Blueprint)

Этот документ содержит пошаговый, детальный до крупиц план реализации четырех ключевых технологий **Arena.ai** внутри платформы **BrowserAI** на сервере Timeweb. Каждая секция описывает конкретные файлы, участки кода, алгоритмы тестирования и краевые сценарии.

---

## 🛠️ Часть 1. Динамический ИИ-Автопилот (Dynamic Autopilot Sibling Router)

### 1.1 Что это делает:
Позволяет пользователю выбрать виртуальную модель `Autopilot` в UI. Система сама переключает модели на лету: планирование и цензура идут на `deepseek-reasoner` (или `glm-5.2`), а кодинг и рутина — на бесплатной `glm-4.7-flash` (или локальной `Qwen`).

### 1.2 Пошаговый план внедрения:

#### Шаг 1. Регистрация виртуальной модели в `server/modelKnowledge.js`
Откройте файл `server/modelKnowledge.js` и добавьте виртуальную модель `Autopilot` в массив `RULES`:
```javascript
// Дописать в массив RULES:
{ match: /autopilot/i, ctx: 128_000, tier: 'expensive', vision: true, price: [0, 0] }
```

#### Шаг 2. Реализация логики переключения в `server/architectEditor.js`
Допишите в `server/architectEditor.js` функцию, которая определяет, на каком шаге мы находимся, и возвращает релевантную физическую модель:
```javascript
export function getAutopilotModelForTurn({ step = 1, recentToolHistory = [], activeKeyList = [] }) {
  // 1. На первом шаге (планирование) или при рефлексии (Код-Ревью) — используем сильную модель
  const isReflectionTurn = recentToolHistory.slice(-1).some(h => h.ok && h.semantic?.isVerify);
  
  if (step === 1 || isReflectionTurn) {
    // Ищем доступный DeepSeek R1 или GLM-5.2
    const hasR1 = activeKeyList.some(k => k.model.includes('reasoner') || k.model.includes('r1'));
    if (hasR1) return { model: 'deepseek-reasoner', providerId: 'deepseek' };
    return { model: 'glm-5.2', providerId: 'z_ai_official' };
  }
  
  // 2. На шагах механического кодинга — используем бесплатный Flash или локальный Qwen
  const hasFlash = activeKeyList.some(k => k.model.includes('flash'));
  if (hasFlash) return { model: 'glm-4.7-flash', providerId: 'z_ai_official' };
  return { model: 'qwen2.5-coder:1.5b', providerId: 'ollama_local' };
}
```

#### Шаг 3. Интеграция в основной цикл `server/agentLoop.js`
Внутри `runAgentInner` перед вызовом ИИ проверяем, выбрана ли модель `Autopilot`. Если да — динамически подменяем провайдера:
```javascript
if (provider.model === 'autopilot') {
  const activeKeys = listKeys(); // Получаем все ключи из бд
  const autoModel = getAutopilotModelForTurn({ step, recentToolHistory, activeKeyList: activeKeys });
  provider = getKeyByIdDecrypted(autoModel.providerId);
  provider.model = autoModel.model;
}
```

---

## 🛠️ Часть 2. Контекстно-зависимый пул инструментов (Context-Aware Tooling)

### 2.1 Что это делает:
Анализирует текст задачи и загружает в системный промпт только те инструменты, которые нужны для текущего сценария. Это уменьшает контекст на 10 000 токенов и защищает ИИ от путаницы.

### 2.2 Пошаговый план внедрения:

#### Шаг 1. Переписание функции выбора профиля в `server/toolAllowlist.js`
Откройте `server/toolAllowlist.js` и реализуйте интеллектуальное сопоставление ключевых слов в цели задачи с профилями инструментов:
```javascript
export function toolProfileForTask(task = {}) {
  const goal = String(task.goal || '').toLowerCase();
  
  // 1. Профиль администрирования и деплоя (Ops)
  if (/(deploy|restart|docker|nginx|service|systemctl|postgres|db_query|database|база данных)/i.test(goal)) {
    return 'ops';
  }
  // 2. Профиль браузерной автоматизации (Browser)
  if (/(browser|open url|screenshot|click|type|кукловод|скриншот|веб-просмотр)/i.test(goal)) {
    return 'browser';
  }
  // 3. Профиль легкого исследования интернета (Research)
  if (/(search|find|news|weather|погода|курс|поищи в интернете|гугл|google)/i.test(goal)) {
    return 'research';
  }
  // 4. Профиль разработки кода по умолчанию (Code)
  return 'code';
}
```

#### Шаг 2. Динамическое ограничение в `server/agentPrompt.js`
Обновите функцию сборки промпта `buildAgentSystemPrompt` в `server/agentPrompt.js`:
* Передавайте туда текущий профиль `toolProfile = toolProfileForTask(task)`.
* Вызывайте генератор промпта инструментов только для разрешенных имен:
  ```javascript
  const allowedTools = profileToolNames(toolProfile);
  // Вставляем в промпт только разрешенные инструменты!
  const toolsBlock = renderToolsForPrompt(extraTools, { toolNames: allowedTools });
  ```

---

## 🛠️ Часть 3. Самолечение ошибок рантайма (Failure Playbooks v2)

### 3.1 Что это делает:
При падении любой консольной команды (тесты, сборка, запуск сервера) система анализирует ошибку и автоматически отправляет агенту скрытую команду исправления (например, освободить порт или установить npm-пакет).

### 3.2 Пошаговый план внедрения:

#### Шаг 1. Расширение классификатора в `server/failurePlaybooks.js`
Откройте `server/failurePlaybooks.js` и добавьте новые паттерны системных ошибок в `classifyToolFailure`:
```javascript
// Дописать в классификатор:
if (/EADDRINUSE|port already in use|address already in use/i.test(raw)) add('port_conflict', 'high', 'Port is already in use by another process');
if (/ENOENT: no such file or directory/i.test(raw) && /\b(node|python|npm|npx|pip)\b/i.test(raw)) add('missing_binary', 'high', 'Required runtime binary is not installed');
```

#### Шаг 2. Определение лечащих команд в `buildFailurePlaybook`
Для каждого нового ID ошибки пропишем автоматический шаг исправления:
```javascript
  if (ids.has('port_conflict')) {
    // Парсим номер порта из ошибки (например, 8080)
    const portMatch = classification.rawPreview.match(/:(\d{4,5})\b/);
    const port = portMatch ? portMatch[1] : '3000';
    add('bash', { command: `fuser -k ${port}/tcp || true`, timeout_sec: 30 }, `Forcefully kill the process hanging on port ${port} to free it up`);
  }
  if (ids.has('missing_binary')) {
    const bin = classification.rawPreview.match(/command not found:\s*(\w+)/i)?.[1] || 'bash';
    add('bash', { command: `apk add --no-cache ${bin} || apt-get install -y ${bin}`, timeout_sec: 120 }, `Automatically install the missing runtime binary: ${bin}`);
  }
```

---

## 🛠️ Часть 4. Одноразовые чистые песочницы (Ephemeral Sandboxes)

### 4.1 Что это делает:
Рантайм создаёт абсолютно изолированный, чистый Docker-контейнер песочницы под каждый отдельный чат, и полностью стирает его при удалении чата. Это предотвращает накопление кэшей и зомби-процессов.

### 4.2 Пошаговый план внедрения:

#### Шаг 1. Динамическое имя контейнера в `server/agentSandbox.js`
Перепишем функцию `getSandboxContainer()` в `server/agentSandbox.js`, чтобы она возвращала уникальное имя контейнера для текущей сессии чата:
```javascript
export async function getSandboxContainer(chatId) {
  if (!chatId) return process.env.AGENT_SANDBOX_CONTAINER || 'agent-sandbox';
  return `agent-sandbox-${chatId}`;
}
```

#### Шаг 2. Авто-запуск контейнера песочницы в `server/agentLoop.js`
При старте выполнения `runAgentInner`, если уникальный контейнер для этого чата ещё не запущен, NodeJS обращается к докер-демону хоста и поднимает чистую песочницу:
```javascript
const sandboxName = `agent-sandbox-${chatId}`;
const containerCheck = await runHostCommand(`docker ps -a --format "{{.Names}}"`);

if (!containerCheck.stdout.includes(sandboxName)) {
  sse(wrappedRes, 'thought', { text: `🐳 [Sandbox] Запуск чистой одноразовой песочницы Linux для этого чата...` });
  
  // Запускаем абсолютно чистый контейнер, монтируя только папку этого чата в /workspace!
  await runHostCommand(`docker run -d --name ${sandboxName} \
    --network browserai_default \
    -v /opt/browserai-data/workspace/chats/${chatId}:/workspace \
    browserai-agent-sandbox:latest tail -f /dev/null`);
}
```

#### Шаг 3. Удаление песочницы при закрытии/удалении чата
Внутри `server/routes/workspace.js` при обработке удаления чата `router.delete('/chats/:id')` дописываем команду очистки Docker:
```javascript
router.delete('/chats/:id', requireAuth, async (req, res) => {
  const chatId = req.params.id;
  // Стираем файлы с диска
  await deleteWorkspaceScope(chatId);
  // Полностью гасим и удаляем Docker-контейнер песочницы этого чата!
  await runHostCommand(`docker rm -f agent-sandbox-${chatId} || true`);
  res.json({ ok: true });
});
```

---

## 🏁 Алгоритм тестирования внедрения (Definition of Done)

После выполнения каждого шага обязательно запускаем цепочку тестов:
1. **Синтаксический контроль проекта:**
   `npm run build` и `npm test` должны проходить без ошибок.
2. **Верификация песочниц:**
   Запускаем новый чат, проверяем через `docker ps`, что создался контейнер `agent-sandbox-XXXX`, а при удалении чата — он стирается.
3. **Верификация автопилота:**
   Запускаем чат в режиме `Autopilot`, пишем «Привет» и смотрим в логах, что запрос обработан бесплатной моделью без запуска инструментов.
