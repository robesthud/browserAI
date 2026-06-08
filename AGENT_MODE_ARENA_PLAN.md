# BrowserAI Agent Mode — план развития до режима уровня Arena.ai

Документ фиксирует целевую архитектуру Agent Mode, порядок внедрения и фактический прогресс. После каждого этапа этот файл нужно обновлять: что сделано, что осталось, какие коммиты/проверки выполнены.

Дата старта плана: 2026-06-09.

---

## Цель

Сделать в BrowserAI agent mode максимально близкий по поведению к Arena.ai Agent Mode:

```text
User request
  ↓
Context Builder
  ↓
Model Planner
  ↓
Agent Loop
  ↓
Tool Router
  ↓
Sandboxed Tool Execution
  ↓
Structured Tool Result
  ↓
State / Memory / UI Events
  ↓
Final Answer or Ask User / Resume
```

Главные требования:

1. Работать с разными ИИ без привязки к одному провайдеру.
2. Иметь строгие слои: контекст, планирование, цикл агента, tools, sandbox, результат.
3. Не ломаться на complex задачах: код, деплой, аудит, исследование, browser/computer use.
4. Честно показывать пользователю состояние: что агент делает, какие tools вызвал, что получилось, что осталось.
5. Не выдавать «готово», если задача не проверена.
6. Уметь задавать уточняющие вопросы и продолжать после ответа.
7. Иметь безопасный workspace/sandbox и структурированный вывод tools.

---

## Статус по этапам

| # | Этап | Статус | Коммит / заметка |
|---|---|---|---|
| 1 | Жёсткие базовые слои Agent Runtime | ✅ Выполнено | `6f44b85` |
| 2 | Model Planner / Agent Loop hardening | ✅ Выполнено | `3cb9ec2` |
| 3 | Tool Router hardening | ⬜ Не начато | — |
| 4 | Provider adapters 2.0 | частично ✅ | `802665c`, требуется расширение |
| 5 | Настоящий streaming protocol | частично ✅ | есть SSE, нужно унифицировать события |
| 6 | Ask User pause/resume | частично ✅ | есть promise registry, нужно усилить state |
| 7 | Workspace / sandbox policy | частично ✅ | есть workspace scope/sandbox, нужен audit |
| 8 | Context memory / summarization | частично ✅ | есть contextManager, нужен agent state digest |
| 9 | UI parity с Arena Agent Mode | частично ✅ | есть tool cards/thoughts, нужно показывать agent_context/state |
| 10 | Self-test / regression suite | ⬜ Не начато | — |
| 11 | GitHub Actions deploy secrets / CI | ⚠️ Требует настройки secrets | workflow падает без TIMEWEB_* |

---

## Этап 1. Жёсткие базовые слои Agent Runtime

### Цель

Разделить монолитную логику агента на явные runtime-слои.

### Сделано

Файл:

```text
server/agentCore.js
```

Добавлено:

- `buildAgentContext(...)`
- `inferProviderKind(...)`
- `classifyAgentTask(...)`
- `normalizeToolResult(...)`

Agent Mode теперь строит безопасный runtime context:

```js
{
  schema: "browserai.agent_context.v1",
  locale: "ru-RU",
  timezone: "Europe/Volgograd",
  workspace: {...},
  model: {...},
  task: {...},
  runtime: {...}
}
```

Добавлено SSE-событие:

```text
event: agent_context
```

Tool result теперь дополнительно содержит:

```js
structured: {
  schema: "browserai.tool_result.v1",
  ok,
  type,
  tool,
  data,
  error,
  display,
  meta
}
```

### Проверки

```bash
node --check server/agentCore.js
node --check server/agentLoop.js
npx eslint server/agentCore.js server/llmClient.js
npm run build
```

Продакшен:

```text
http://186.246.31.78/api/health → {"ok":true}
```

### Осталось после этапа 1

- Подключить отображение `agent_context` во фронтенде.
- Использовать context в дальнейших policy gates.
- Добавить сохранение context/state в историю чата или telemetry.

---

## Этап 2. Model Planner / Agent Loop hardening

### Цель

Сделать цикл агента более дисциплинированным: агент должен явно понимать цель, план, текущий шаг, ошибки, затронутые файлы и условия завершения.

### Что нужно внедрить

- `agent_state` runtime object:
  - `goal`
  - `status`
  - `plan`
  - `completedSteps`
  - `currentStep`
  - `openQuestions`
  - `touchedFiles`
  - `lastErrors`
  - `nextActions`
  - `toolStats`
- SSE-событие:

```text
event: agent_state
```

- Программная planning directive для medium/high задач.
- Автообновление state после tool results.
- Более строгие условия финального ответа.
- Resume после `ask_user` должен обновлять state.

### Сделано

Добавлено в `server/agentCore.js`:

- `createAgentState(...)`
- `buildPlanningDirective(...)`
- `updateAgentStateFromTool(...)`

Agent loop теперь создаёт runtime state и отправляет его во фронтенд:

```text
event: agent_state
```

Для medium/high задач автоматически добавляется внутренняя planning directive:

```text
[agent_runtime_directive]
Task classification: ...
Before doing substantial work, call plan_set...
...
[/agent_runtime_directive]
```

State обновляется после tool calls:

- `plan_set` создаёт план.
- `plan_check` отмечает шаги выполненными.
- `ask_user` переводит состояние в `waiting_for_user`, после ответа — обратно в `running`.
- write/edit/delete tools попадают в `touchedFiles`.
- failed tools попадают в `lastErrors`.
- `verify_code` / `run_tests` обновляют шаг верификации.

Формат state:

```js
{
  schema: "browserai.agent_state.v1",
  status,
  goal,
  plan,
  completedSteps,
  currentStep,
  openQuestions,
  touchedFiles,
  lastErrors,
  nextActions,
  toolStats,
  updatedAt
}
```

### Проверки

```bash
node --check server/agentCore.js
node --check server/agentLoop.js
npx eslint server/agentCore.js server/llmClient.js
npm run build
```

### Осталось после этапа 2

- Показать `agent_state` красиво во фронтенде.
- Добавить сохранение state в историю/telemetry.
- Добавить отдельный final-verification gate перед финальным ответом для deploy/code задач.
- На следующем этапе усилить Tool Router и policy gates.

---

## Этап 3. Tool Router hardening

### Нужно

- Единый contract всех tools:

```js
{
  ok,
  type,
  data,
  error,
  display,
  meta
}
```

- Tool categories:
  - read
  - write
  - command
  - web
  - browser
  - computer
  - ops
  - memory
  - git
- Permission gates по категориям.
- Structured retries.
- Better validation arguments.
- Защита от tool hallucination.

---

## Этап 4. Provider adapters 2.0

### Уже сделано

Коммит `802665c`:

- OpenAI-compatible transport.
- Anthropic official `/messages` adapter.
- Google Gemini official `generateContent` adapter.
- Streaming для Anthropic/Gemini official.
- Validation official Anthropic/Gemini.

### Осталось

- Нормализовать provider errors.
- Добавить adapter metadata endpoint.
- Добавить тесты на:
  - OpenAI-compatible
  - Anthropic official
  - Gemini official
  - DeepSeek managed
  - session/web-token models

---

## Этап 5. Streaming Protocol

### Нужно

Унифицировать события:

```text
agent_context
agent_state
thinking
thinking_delta
assistant_delta
assistant
tool_preview
tool_start
tool_progress
tool_result
tool_diagnostic
ask_user
tool_approval
usage
done
error
```

Каждое событие должно иметь стабильный shape.

---

## Этап 6. Ask User pause/resume

### Уже есть

- `askUserRegistry.js`
- `/api/agent/answer`
- SSE `ask_user`
- UI card

### Осталось

- State transition:

```text
running → waiting_for_user → running
```

- Timeout/cancel.
- Сохранение pending question в state.
- Поддержка нескольких вопросов как в Arena.

---

## Этап 7. Workspace / Sandbox Policy

### Уже есть

- workspace scope per chat
- sandbox command execution
- persistent shell sessions
- background tasks
- file history/checkpoints

### Осталось

- Полный audit path traversal.
- Explicit workspace snapshot metadata.
- Tool output size policy по типу tool.
- Безопасная политика секретов.

---

## Этап 8. Context / Memory / Summarization

### Уже есть

- `contextManager.js`
- user facts
- semantic memory
- knowledge base
- project rules injection

### Осталось

- Agent state digest.
- Summary of completed actions.
- Использовать state при auto-compact.
- Отдельная память task-level vs user-level.

---

## Этап 9. UI parity с Arena Agent Mode

### Нужно

- Отображать agent context.
- Отображать agent state.
- Отдельные блоки:
  - plan
  - current step
  - tool timeline
  - pending approvals
  - final verification
- Кнопки:
  - stop
  - approve/deny
  - retry failed tool
  - continue from state

---

## Этап 10. Self-test / Regression Suite

### Нужно

Добавить:

```text
/api/agent/self-test
```

Проверять:

- provider health
- streaming
- tool protocol
- read/write workspace
- bash
- ask_user
- final answer
- error handling

---

## Этап 11. CI/CD

### Сейчас

GitHub Actions deploy падает, потому что не заданы secrets:

```text
TIMEWEB_SSH_KEY
TIMEWEB_HOST
TIMEWEB_USER
TIMEWEB_APP_DIR
```

### Нужно

- Либо добавить secrets в GitHub.
- Либо изменить workflow под временный token/SSH method.
- Либо сделать отдельный manual deploy script.

---

## Журнал выполнения

### 2026-06-09

- Создан документ плана.
- Этап 1 уже выполнен ранее: `6f44b85`.
- Выполнен этап 2 — Model Planner / Agent Loop hardening:
  - добавлен `agent_state`;
  - добавлена planning directive;
  - state обновляется после tool results;
  - `ask_user` переводит state в `waiting_for_user` и обратно в `running`;
  - подготовлен следующий этап: Tool Router hardening.
