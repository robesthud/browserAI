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
| 2 | Model Planner / Agent Loop hardening | ✅ Выполнено | см. журнал выполнения |
| 3 | Tool Router hardening | ✅ Выполнено | см. журнал выполнения |
| 4 | Provider adapters 2.0 | ✅ Выполнено | см. журнал выполнения |
| 5 | Streaming Protocol | ✅ Выполнено | см. журнал выполнения |
| 6 | Ask User pause/resume | ✅ Выполнено | см. журнал выполнения |
| 7 | Workspace / Sandbox Policy | ✅ Выполнено | см. журнал выполнения |
| 8 | Context / Memory / Summarization | ✅ Выполнено | см. журнал выполнения |
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

### Цель

Сделать маршрутизацию tools строгой и предсказуемой независимо от модели/провайдера.

### Сделано

Добавлено в `server/agentCore.js`:

- `validateToolCall(...)`
- `makeToolErrorResult(...)`
- argument coercion по schema tools:
  - `string`
  - `number`
  - `boolean`
  - `array`
  - `object`
- проверка обязательных параметров;
- базовая защита path-like аргументов:
  - запрет NUL byte;
  - запрет `../` traversal;
  - запрет encoded traversal `%2e`;
  - запрет absolute paths для workspace-relative path параметров;
- лимит строковых аргументов;
- router-level SSE warning:

```text
event: tool_router
```

В `server/agentLoop.js` tool call теперь проходит этапы:

```text
raw model tool call
  ↓
validateToolCall / coerce args
  ↓
tool_router warning, если были coercions
  ↓
approval gate
  ↓
tool_start
  ↓
invokeTool
  ↓
normalizeToolResult
  ↓
agent_state update
```

Если аргументы tool некорректны, tool не выполняется. Агент получает structured error result и может исправиться на следующем шаге.

Единый structured contract уже есть через:

```js
normalizeToolResult(...)
```

Формат:

```js
{
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

### Осталось после этапа 3

- Добавить более глубокую validation schema для сложных tools.
- Добавить retry policy по типам ошибок.
- Показать `tool_router` warning во фронтенде.
- Синхронизировать категории из `approvalGate.js` с будущим центральным registry.
- Добавить regression tests на bad tool args/path traversal.

---

## Этап 4. Provider adapters 2.0

### Цель

Сделать provider layer явным, диагностируемым и независимым от конкретной модели/провайдера.

### Сделано ранее

Коммит `802665c`:

- OpenAI-compatible transport.
- Anthropic official `/messages` adapter.
- Google Gemini official `generateContent` adapter.
- Streaming для Anthropic/Gemini official.
- Validation official Anthropic/Gemini.

### Сделано сейчас

Добавлено в `server/llmClient.js`:

- `getProviderKind(...)`
- `getProviderCapabilities(...)`
- `normalizeProviderError(...)`

Единый capabilities формат:

```js
{
  schema: "browserai.provider_capabilities.v1",
  kind,
  baseUrl,
  model,
  transport: {
    openaiCompatible,
    officialApi,
    browserSession,
    managed
  },
  features: {
    streaming,
    nativeTools,
    universalTools,
    toolFallback,
    vision,
    reasoning,
    usage,
    systemPrompt,
    multimodalInput
  },
  recommendedToolProtocol
}
```

Единый provider error формат:

```js
{
  schema: "browserai.provider_error.v1",
  phase,
  provider,
  status,
  authError,
  rateLimited,
  timeout,
  serverError,
  retryable,
  message,
  hint
}
```

Добавлены endpoints:

```text
POST /api/agent/provider/capabilities
POST /api/agent/provider/diagnose
```

`/api/agent/provider/diagnose` возвращает:

- capabilities;
- optional probe result;
- normalized providerError при ошибке.

Agent loop теперь отправляет normalized provider error в SSE `error` при LLM failure.

Official Anthropic/Gemini adapter в `/api/chat` теперь также возвращает `providerError` при ошибке.

### Проверки

```bash
node --check server/llmClient.js
node --check server/index.js
node --check server/agentLoop.js
npx eslint server/agentCore.js server/llmClient.js
npm run build
```

### Осталось после этапа 4

- Добавить frontend UI для capabilities/diagnose.
- Добавить regression tests на все adapter kinds.
- Добавить автоматический fallback provider между несколькими ключами.
- Добавить более точную detection vision/reasoning по model registry.

---

## Этап 5. Streaming Protocol

### Цель

Сделать Agent Mode SSE stream стабильным и версионированным, чтобы UI, логи, mobile app и будущие self-tests могли одинаково читать события.

### Сделано

В `server/agentLoop.js` обновлён SSE helper.

Каждое Agent Mode SSE-событие теперь имеет единый envelope:

```js
{
  schema: "browserai.agent_stream_event.v1",
  event,
  seq,
  timestamp,
  ...legacyTopLevelFields,
  payload
}
```

Сохранена обратная совместимость:

- старый UI по-прежнему может читать `step`, `name`, `ok`, `result`, `error` на верхнем уровне;
- новый UI может читать стабильные поля `schema`, `event`, `seq`, `timestamp`, `payload`.

Добавлено первое событие stream metadata:

```text
event: stream_protocol
```

Payload:

```js
{
  version: 1,
  compatibility: "top-level-fields-plus-envelope",
  events: [
    "stream_protocol",
    "agent_context",
    "agent_state",
    "thinking",
    "thinking_delta",
    "assistant_delta",
    "assistant",
    "thought",
    "tool_preview",
    "tool_router",
    "tool_start",
    "tool_progress",
    "tool_result",
    "tool_diagnostic",
    "ask_user",
    "tool_approval",
    "usage",
    "done",
    "error"
  ]
}
```

Теперь каждое событие имеет последовательный номер `seq`, что позволяет UI/логам восстанавливать порядок событий.

### Проверки

```bash
node --check server/agentLoop.js
npx eslint server/agentCore.js server/llmClient.js
npm run build
```

### Осталось после этапа 5

- Обновить фронтенд, чтобы он использовал `payload` и `seq`.
- Добавить визуальное отображение `stream_protocol`/debug mode.
- Добавить e2e-test, который проверяет порядок и shape SSE events.
- Унифицировать `/api/chat` streaming отдельно от Agent Mode streaming.

---

## Этап 6. Ask User pause/resume

### Цель

Сделать интерактивные вопросы агента полноценным lifecycle, как в Arena.ai Agent Mode:

```text
running → waiting_for_user → answered/cancelled/timeout → running/recover
```

### Сделано

Обновлён `server/askUserRegistry.js`:

- pending questions теперь хранят metadata;
- у каждого вопроса есть:
  - `id`
  - `status`
  - `createdAt`
  - `expiresAt`
  - `remainingMs`
  - `meta`
- добавлен timeout через `BROWSERAI_ASK_TIMEOUT_MS`;
- timer теперь корректно очищается при answer/cancel;
- answer/cancel проверяют user scope;
- добавлены public helpers:
  - `listPendingQuestions(...)`
  - `getPendingQuestion(...)`
  - `cancelQuestion(...)`

Agent loop теперь регистрирует metadata для:

- обычных `ask_user`;
- `tool_approval`;
- multi-question Arena-style форм.

SSE `ask_user` и `tool_approval` теперь содержат:

```js
{
  question_id,
  expiresAt,
  ...
}
```

Добавлены API endpoints:

```text
GET  /api/agent/questions
GET  /api/agent/questions/:id
POST /api/agent/questions/:id/cancel
POST /api/agent/answer
```

`POST /api/agent/answer` теперь учитывает user scope и возвращает ошибку, если вопрос:

- не найден;
- истёк;
- уже отвечен;
- принадлежит другому пользователю.

### Проверки

```bash
node --check server/askUserRegistry.js
node --check server/agentLoop.js
node --check server/index.js
npx eslint server/askUserRegistry.js server/agentCore.js server/llmClient.js
npm run build
```

### Осталось после этапа 6

- UI: показывать `expiresAt` / countdown.
- UI: добавить кнопку cancel на question card.
- Persist pending state across process restart — сейчас pending registry in-memory.
- Добавить e2e тест ask_user lifecycle.

---

## Этап 7. Workspace / Sandbox Policy

### Цель

Сделать workspace/sandbox слой явно описанным, безопасным и диагностируемым.

### Сделано

Добавлен файл:

```text
server/sandboxPolicy.js
```

В нём реализовано:

- `redactSecrets(...)` — redaction секретов из sandbox/tool output;
- `publicWorkspacePolicy(...)` — публичная политика workspace/sandbox;
- `WORKSPACE_EXCLUDED_DIRS` — единый список исключаемых директорий.

Redaction покрывает:

- GitHub PAT / `ghp_*` tokens;
- OpenAI-like `sk-*`;
- Anthropic `sk-ant-*`;
- Google `AIza...`;
- Telegram bot tokens;
- JWT;
- Bearer tokens;
- `password=...`, `token=...`, `secret=...`, `api_key=...` patterns.

Обновлён `server/agentSandbox.js`:

- stdout/stderr final output redacted;
- live `tool_progress` stdout/stderr chunks тоже redacted;
- output clipping сохранён.

Обновлён `server/workspace.js`:

- усилена path policy:
  - max path length 1024;
  - запрет encoded traversal `%2e`, `%2f`, `%5c`;
  - дополнительная проверка `/../`;
- добавлена `getWorkspaceMetadata(...)`;
- metadata включает:
  - usedBytes;
  - quotaBytes;
  - maxSingleFileBytes;
  - fileCount;
  - dirCount;
  - public workspace policy;
  - scopedRootHash без раскрытия реального пути.

Добавлен endpoint:

```text
GET /api/workspace/metadata
```

Agent context теперь включает:

```js
workspace.policy
```

### Проверки

```bash
node --check server/sandboxPolicy.js
node --check server/agentSandbox.js
node --check server/workspace.js
node --check server/index.js
node --check server/agentCore.js
npx eslint server/sandboxPolicy.js server/agentSandbox.js server/workspace.js server/agentCore.js server/llmClient.js
npm run build
```

### Осталось после этапа 7

- UI: показать workspace metadata/policy.
- Добавить regression tests path traversal.
- Добавить configurable denylist для bash-команд.
- Persist/replay workspace snapshots beyond `.history` revisions.
- Добавить per-tool output policy в отдельный registry.

---

## Этап 8. Context / Memory / Summarization

### Цель

Сделать память агента многоуровневой, чтобы при длинных задачах и auto-compact агент не терял цель, план, ошибки, затронутые файлы и выполненные действия.

### Уже было

- `contextManager.js` с multi-tier compaction:
  - tier 1: сжатие старых tool outputs;
  - tier 2: digest старых turns;
  - tier 3: emergency drop;
- user facts;
- semantic memory;
- knowledge base;
- project rules injection;
- recent workspace activity note.

### Сделано сейчас

Добавлено в `server/contextManager.js`:

- `renderAgentStateDigest(...)`
- `upsertAgentStateDigest(...)`

Теперь в conversation поддерживается ровно один authoritative task-level memory block:

```text
[agent_state_digest — authoritative task-level memory; keep this when compacting context]
status: ...
goal: ...
currentStep: ...
completedSteps: ...
plan: ...
touchedFiles: ...
lastErrors: ...
openQuestions: ...
nextActions: ...
recentTools: ...
toolStats: ...
[/agent_state_digest]
```

`server/agentLoop.js` теперь перед каждым LLM-вызовом вызывает:

```js
upsertAgentStateDigest(convo, agentState, recentToolHistory)
```

Digest вставляется сразу после system prompt и обновляется на каждом шаге, не копится в истории и не создаёт spam.

Это разделяет память на уровни:

```text
user-level memory      → user facts / semantic memory
project-level context  → project rules / knowledge base / workspace activity
task-level memory      → agent_state_digest
raw short-term context → последние turns/tool results
```

При context compaction агент сохраняет:

- цель задачи;
- текущий статус;
- план и отметки выполнения;
- последние ошибки;
- файлы, которые реально менялись;
- следующие действия;
- последние tools.

### Проверки

```bash
node --check server/contextManager.js
node --check server/agentLoop.js
npx eslint server/contextManager.js server/sandboxPolicy.js server/agentCore.js server/llmClient.js
npm run build
```

### Осталось после этапа 8

- UI: показывать task-level digest/debug trace.
- Добавить более умный final summary renderer на основе agent_state + workspace activity.
- Добавить e2e-тест long context compaction.
- Persist task digest between server restarts if needed.

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
- Выполнен этап 3 — Tool Router hardening:
  - добавлен `validateToolCall`;
  - добавлен `makeToolErrorResult`;
  - добавлена coercion/validation аргументов tools;
  - добавлена path traversal защита на уровне router;
  - добавлено SSE-событие `tool_router`;
  - некорректные tool calls теперь возвращают structured error без выполнения tool.
- Выполнен этап 4 — Provider adapters 2.0:
  - добавлен `getProviderKind`;
  - добавлен `getProviderCapabilities`;
  - добавлен `normalizeProviderError`;
  - добавлены endpoints `/api/agent/provider/capabilities` и `/api/agent/provider/diagnose`;
  - LLM errors в Agent Loop теперь имеют structured `providerError`;
  - official Anthropic/Gemini `/api/chat` errors тоже возвращают `providerError`.
- Выполнен этап 5 — Streaming Protocol:
  - добавлен стабильный envelope для всех Agent Mode SSE events;
  - добавлены поля `schema`, `event`, `seq`, `timestamp`, `payload`;
  - сохранена обратная совместимость с текущим UI;
  - добавлено событие `stream_protocol` со списком поддерживаемых events.
- Выполнен этап 6 — Ask User pause/resume:
  - pending questions получили metadata, expiresAt и remainingMs;
  - answer/cancel теперь scoped по userId;
  - добавлены endpoints для list/get/cancel pending questions;
  - `ask_user` и `tool_approval` SSE теперь содержат `expiresAt`;
  - timeout задаётся через `BROWSERAI_ASK_TIMEOUT_MS`.
- Выполнен этап 7 — Workspace / Sandbox Policy:
  - добавлен `server/sandboxPolicy.js`;
  - добавлен redaction секретов в sandbox stdout/stderr и live progress;
  - усилена path policy workspace;
  - добавлен `getWorkspaceMetadata`;
  - добавлен endpoint `/api/workspace/metadata`;
  - `agent_context.workspace` теперь содержит public policy.
- Выполнен этап 8 — Context / Memory / Summarization:
  - добавлен `renderAgentStateDigest`;
  - добавлен `upsertAgentStateDigest`;
  - agent loop теперь поддерживает task-level memory digest перед каждым LLM call;
  - digest защищает goal/plan/errors/touchedFiles/recentTools от потери при context compaction;
  - memory разделена на user-level, project-level, task-level и raw short-term context.
