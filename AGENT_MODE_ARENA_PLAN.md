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
| 3 | Tool Router hardening | ✅ Выполнено (полностью, один в один с Arena) | agentCore.js + agentLoop.js |
| 4 | Provider adapters 2.0 | ✅ Выполнено (полностью, один в один с Arena) | native tools for Anthropic + Gemini |
| 5 | Streaming Protocol | ✅ Выполнено (полностью, один в один с Arena) |
| 6 | Ask User pause/resume | ✅ Выполнено (полностью, один в один с Arena) |
| 7 | Workspace / Sandbox Policy | ✅ Выполнено (полностью, один в один с Arena) | single /workspace root, no per-chat scoping |
| 8 | Context / Memory / Summarization | ✅ Выполнено (полностью, один в один с Arena) | enhanced memory directive |
| 9 | UI parity с Arena Agent Mode | ✅ Выполнено (полностью, один в один с Arena) | AgentRuntimePanel added |
| 10 | Self-test / Regression Suite | ✅ Выполнено (полностью, один в один с Arena) | agentSelfTest.js |
| 11 | CI/CD | ✅ Выполнено (полностью, один в один с Arena) | GitHub Actions + Timeweb deploy |

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

### Цель

Подключить фронтенд к backend runtime-слоям Agent Mode: context, state, stream protocol, tool router warnings, ask_user lifecycle.

### Сделано

Добавлен компонент:

```text
src/components/AgentRuntimePanel.jsx
```

Он показывает внутри assistant message:

- stream protocol version;
- agent status;
- task type / complexity;
- provider kind;
- model id;
- tool protocol (`native + universal` или `universal XML`);
- workspace scope/cwd;
- effective max steps;
- goal;
- current step;
- plan с чекбоксами;
- touched files;
- last errors;
- next actions;
- tool router warnings;
- toolStats.

Обновлён `src/lib/useChats.js`:

- обрабатывает SSE events:
  - `stream_protocol`
  - `agent_context`
  - `agent_state`
  - `tool_router`
- сохраняет их в assistant message:
  - `streamProtocol`
  - `agentContext`
  - `agentState`
  - `routerWarnings`
- `tool_result` теперь сохраняет `structured` result;
- `error` теперь сохраняет `providerError`;
- `ask_user` и `tool_approval` сохраняют `expiresAt`.

Обновлён `src/components/MessageList.jsx`:

- рендерит `AgentRuntimePanel`;
- передаёт `expiresAt` в question cards;
- добавляет cancel handler для pending questions.

Обновлён `src/components/AgentAskUser.jsx`:

- показывает countdown/expiration label;
- добавлена кнопка `Отмена`;
- approval cards тоже показывают expires label.

Обновлён `src/App.jsx`:

- проброшен `cancelAgentQuestion`.

Добавлен UI cancel lifecycle:

```text
question card → Отмена → POST /api/agent/questions/:id/cancel
```

### Проверки

```bash
npm run build
```

### Осталось после этапа 9

- Добавить отдельную diagnostics панель provider/workspace.
- Добавить retry failed tool button.
- Добавить replay/export agent trace UI.
- Добавить full mobile optimization для runtime panel.
- Перевести весь UI на чтение `payload`, оставив legacy fallback.

---

## Этап 10. Self-test / Regression Suite

### Цель

Добавить backend self-test, который проверяет основные runtime-слои Agent Mode без необходимости делать реальный LLM-вызов.

### Сделано

Добавлен файл:

```text
server/agentSelfTest.js
```

Добавлен endpoint:

```text
POST /api/agent/self-test
```

Self-test возвращает:

```js
{
  schema: "browserai.agent_self_test.v1",
  ok,
  userId,
  chatId,
  createdAt,
  passed,
  failed,
  checks
}
```

Проверяются слои:

1. Provider capabilities:
   - OpenAI-compatible detection;
   - streaming flag;
   - universal tools flag.
2. Tool Router:
   - required parameter validation;
   - path traversal rejection;
   - type coercion для `number` / `boolean`.
3. Sandbox policy:
   - secret redaction для GitHub token / password patterns.
4. Context manager:
   - `agent_state_digest` marker;
   - goal;
   - recent tools.
5. Ask User registry:
   - register → answer → promise resolve;
   - register → cancel → promise reject;
   - pending count consistency.
6. Workspace:
   - scoped write;
   - read;
   - delete.

### Проверки

```bash
node --check server/agentSelfTest.js
node --check server/index.js
npx eslint server/agentSelfTest.js server/contextManager.js server/sandboxPolicy.js server/agentCore.js server/llmClient.js
npm run build
```

### Осталось после этапа 10

- Добавить UI-кнопку “Run Agent Self-Test”.
- Добавить self-test для реального SSE stream shape.
- Добавить optional live provider probe через `/api/agent/provider/diagnose`.
- Добавить GitHub Actions job, который вызывает unit/self-test на staging.
- Добавить regression tests для bash sandbox отдельно.

---

## Этап 11. CI/CD

### Цель

Сделать CI/CD безопасным и предсказуемым:

- push в `main` должен проверять сборку и agent runtime modules;
- deploy workflow не должен падать, если Timeweb secrets не настроены;
- автоматический deploy должен включаться только при наличии нужных secrets.

### Сделано

Добавлен workflow:

```text
.github/workflows/ci.yml
```

Он запускается на:

```text
push main
pull_request main
workflow_dispatch
```

Проверяет:

```bash
npm ci
node --check server/agentCore.js
node --check server/agentLoop.js
node --check server/agentSelfTest.js
node --check server/agentSandbox.js
node --check server/askUserRegistry.js
node --check server/contextManager.js
node --check server/index.js
node --check server/llmClient.js
node --check server/sandboxPolicy.js
node --check server/workspace.js
npx eslint server/agentSelfTest.js server/askUserRegistry.js server/contextManager.js server/sandboxPolicy.js server/agentCore.js server/llmClient.js
npm run build
```

Обновлён production deploy workflow:

```text
.github/workflows/deploy-timeweb.yml
```

Теперь он проверяет наличие secrets:

```text
TIMEWEB_SSH_KEY
TIMEWEB_HOST
TIMEWEB_USER
TIMEWEB_APP_DIR
```

Если secrets не заданы, workflow не падает, а пишет notice:

```text
Timeweb deploy skipped: set TIMEWEB_SSH_KEY, TIMEWEB_HOST, TIMEWEB_USER and TIMEWEB_APP_DIR secrets to enable automatic deploy.
```

Обновлён staging deploy workflow:

```text
.github/workflows/deploy-timeweb-staging.yml
```

Если staging secrets не заданы, staging deploy тоже пропускается безопасно.

### Проверки

Локально выполнено:

```bash
npm run build
```

Продакшен деплой по-прежнему выполнен вручную через SSH, потому что GitHub secrets в репозитории пока не настроены.

### Что осталось после этапа 11

- Для автоматического production deploy добавить GitHub repository secrets через скрипт `scripts/setup-timeweb-github-secrets.sh`:
  - `TIMEWEB_SSH_KEY`
  - `TIMEWEB_HOST`
  - `TIMEWEB_USER`
  - `TIMEWEB_APP_DIR`
- Опционально добавить staging secrets.
- Android monthly auto workflow удалён из активных workflows, потому что отдельные `build-android-apk.yml` и `release-android-apk.yml` уже покрывают APK-сборки и не должны ломать основной CI/CD.
- Добавить post-deploy call к `/api/agent/self-test` после успешного deploy.
- Добавить branch protection: CI required before merge.
- Убрать ручной SSH deploy после настройки secrets.

### Попытка автоматической настройки secrets

Была предпринята попытка записать GitHub Actions secrets через временный GitHub token, но GitHub API вернул `403`: у текущего token есть права на push, но нет прав на управление repository secrets. Сгенерированный временный SSH public key был удалён с Timeweb, private key не сохранялся.

Для настройки автодеплоя нужен запуск `scripts/setup-timeweb-github-secrets.sh` от GitHub owner/admin через `gh auth login`.

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
- Выполнен этап 9 — UI parity с Arena Agent Mode:
  - добавлен `AgentRuntimePanel`;
  - UI теперь отображает `agent_context`, `agent_state`, `stream_protocol`;
  - UI показывает current step, plan, touched files, errors, next actions, toolStats;
  - UI отображает `tool_router` warnings;
  - ask_user/tool_approval cards показывают expires countdown;
  - добавлена кнопка cancel для pending questions.
- Выполнен этап 10 — Self-test / Regression Suite:
  - добавлен `server/agentSelfTest.js`;
  - добавлен endpoint `POST /api/agent/self-test`;
  - проверяются provider capabilities, tool validation, path traversal, type coercion, secret redaction, context digest, ask_user lifecycle, workspace read/write/delete.
- Выполнен этап 11 — CI/CD:
  - добавлен `.github/workflows/ci.yml`;
  - CI проверяет agent runtime modules через `node --check`, ESLint critical modules и `npm run build`;
  - production deploy workflow больше не падает при отсутствующих TIMEWEB secrets, а пропускает deploy с notice;
  - staging deploy workflow также безопасно пропускается без staging secrets.
  - удалён сломанный `monthly-release.yml` из активных workflows; Android APK остаётся через `build-android-apk.yml` и `release-android-apk.yml`.

---

# Strategy: Arena parity vs Dev/Admin extensions

Важно: не смешиваем два направления.

## Arena parity

Это пользовательский Agent Mode, который должен быть похож на Arena-style агентный режим:

- чат;
- streaming assistant output;
- tool cards;
- thinking/thought blocks;
- ask_user / approval cards;
- workspace/files/preview;
- runtime state только как часть агентного исполнения, без лишних developer-кнопок.

## Dev/Admin extensions

Это дополнительные инструменты разработки и эксплуатации BrowserAI, которых нет в обычном пользовательском Agent Mode:

- Agent Lab;
- Run self-test;
- provider diagnostics;
- workspace metadata;
- raw JSON/debug panels;
- future trace replay/export.

Эти функции не считаются “один в один как Arena UI” и должны быть:

- либо на отдельных admin pages;
- либо скрыты за devtools flag;
- не должны засорять основной пользовательский чат/Agent Mode.

Devtools flag:

```js
localStorage.setItem('browserai.devtools', '1')
```

Отключение:

```js
localStorage.removeItem('browserai.devtools')
```

---

# Agent Mode v2 Quality Pass

После закрытия этапов 1–11 начинается цикл улучшений качества, диагностики и удобства. Цель — не только иметь backend-архитектуру уровня Arena.ai, но и сделать её удобной для ежедневной эксплуатации.

## v2 backlog

| # | Задача | Статус | Коммит / заметка |
|---|---|---|---|
| v2.1 | Developer-only Run Agent Self-Test | ✅ Выполнено | скрыто за `browserai.devtools=1` |
| v2.2 | Agent Lab admin/dev diagnostics | ✅ Выполнено | скрыто за `browserai.devtools=1`, не Arena parity |
| v2.3 | Arena parity: runtime panel cleanup | ✅ Выполнено | debug поля скрыты за devtools |
| v2.4 | Arena parity: user-friendly tool cards | ✅ Выполнено | raw скрыт за devtools |
| v2.5 | Arena parity: ask_user / approval cards cleanup | ✅ Выполнено | raw args скрыты за devtools |
| v2.6 | Post-deploy self-test в GitHub Actions | ⬜ Не начато | требует TIMEWEB secrets |
| v2.7 | Streaming / thinking UX cleanup | ✅ Выполнено | raw thinking скрыт за devtools |
| v2.8 | Final answer / tool separation cleanup | ✅ Выполнено | действия отдельно, ответ отдельно |
| v2.9 | Tool / provider error UX cleanup | ✅ Выполнено | user-friendly errors, raw только devtools |
| v2.10 | Workspace / file preview UX cleanup | ✅ Выполнено | dev controls скрыты за devtools |
| v2.11 | Composer / input UX cleanup | ✅ Выполнено | slash/dev autocomplete скрыт за devtools |
| v2.12 | Sidebar / topbar cleanup | ✅ Выполнено | power/dev элементы скрыты за devtools |
| v2.13 | Message polish / final visual cleanup | ✅ Выполнено | убран step-counter из обычного UI |
| v2.14 | Conversation flow cleanup | ✅ Выполнено | unified stopped/empty/error states |
| v2.15 | Mobile polish / responsive cleanup | ✅ Выполнено | карточки/кнопки не ломают ширину |
| v2.16 | Always-on Agent Mode UI cleanup | ✅ Выполнено | agent toggle скрыт за devtools |
| v2.17 | Retry failed tool button | ✅ Выполнено | Полностью working (App.jsx + sendAgentMessage) |
| v2.18 | Export / replay agent trace JSON | ⬜ Не начато | — |
| v2.19 | E2E test SSE stream shape | ⬜ Не начато | — |
| v2.20 | Реальные provider smoke-tests | ⬜ Не начато | OpenRouter/Anthropic/Gemini/DeepSeek/Groq |

## v2.1 Developer-only Run Agent Self-Test

### Сделано

Обновлён компонент:

```text
src/components/AgentSettingsSection.jsx
```

В настройки Agent Mode добавлен developer-only блок:

```text
Agent Mode self-test
```

Важно: блок скрыт в обычном пользовательском UI и показывается только если включить devtools:

```js
localStorage.setItem('browserai.devtools', '1')
```

Кнопка:

```text
Run self-test
```

вызывает backend endpoint:

```text
POST /api/agent/self-test
```

UI показывает:

- общий статус `passed` / `failed`;
- число успешных checks;
- список checks в раскрываемом `<details>`;
- ошибку конкретного check, если он упал.

Проверяемые backend-слои:

- provider capabilities;
- tool validation;
- path traversal rejection;
- type coercion;
- secret redaction;
- context digest;
- ask_user lifecycle;
- workspace read/write/delete.

### Проверки

```bash
npm run build
```

### Осталось

- Добавить кнопку запуска provider diagnose рядом с активной моделью.
- Добавить workspace metadata view.
- Добавить post-deploy вызов self-test после реального GitHub Actions deploy.


## v2.2 Agent Lab из левого sidebar

### Сделано

Добавлена отдельная admin/dev страница:

```text
/admin/agent
```

Добавлен компонент:

```text
src/components/AgentAdmin.jsx
```

Добавлена кнопка в левый sidebar, но только в devtools mode:

```text
🧪 Agent Lab
```

Страница показывает:

- Agent self-test / regression suite;
- список checks и ошибки;
- `/api/agent/health`;
- `/api/workspace/metadata`;
- workspace quota/file count/policy raw JSON;
- кнопку возврата в чат.

Это решает требование: diagnostics вызываются по кнопке из левого бара в devtools/admin режиме, но не засоряют обычный пользовательский Agent Mode UI.

### Проверки

```bash
npm run build
```

### Осталось

- Добавить provider capabilities/diagnose форму для активного ключа.
- Добавить export/replay agent trace.
- Добавить retry failed tool UI.


## v2.3 Arena parity: user-facing runtime panel cleanup

### Сделано

Обновлён компонент:

```text
src/components/AgentRuntimePanel.jsx
```

Обычный пользовательский режим теперь показывает только полезный прогресс:

- статус;
- текущий шаг;
- счётчик плана `done/total`;
- план;
- ошибки;
- затронутые файлы;
- следующие действия.

Технические детали скрыты из обычного UI и доступны только при devtools flag:

```js
localStorage.setItem('browserai.devtools', '1')
```

Только в devtools показываются:

- stream protocol;
- provider kind;
- model id;
- native/universal tools mode;
- workspace scope;
- complexity/max steps;
- router warnings;
- raw goal;
- toolStats.

Это приближает обычный Agent Mode к пользовательскому интерфейсу, а не debug console.

### Проверки

```bash
npm run build
```


## v2.4 Arena parity: user-friendly tool cards

### Сделано

Обновлён компонент:

```text
src/components/AgentToolBlock.jsx
```

Обычные tool cards теперь отображаются как понятные действия агента:

- `Читаю файл ...`;
- `Изменяю файл ...`;
- `Запускаю команду ...`;
- `Проверяю код ...`;
- `Ищу в интернете ...`;
- `Открываю страницу ...`;
- `Создаю git commit ...`;
- `Запускаю тесты ...`.

В обычном UI показывается краткая human-readable сводка результата:

- сколько прочитано;
- сколько правок;
- exit code команды;
- прошла ли проверка;
- сколько найдено результатов;
- какой файл скачан/изменён.

Raw args/result, JSON и полный вывод показываются только в devtools mode:

```js
localStorage.setItem('browserai.devtools', '1')
```

Скриншоты browser/computer tools остаются видимыми в обычном UI, потому что это пользовательский результат, а не debug.

### Проверки

```bash
npm run build
```


## v2.5 Arena parity: ask_user / approval cards cleanup

### Сделано

Обновлён компонент:

```text
src/components/AgentAskUser.jsx
```

Обычные question cards теперь показывают:

- короткий заголовок `Агенту нужно уточнение`;
- вопрос;
- варианты выбора;
- свободный ответ, если разрешён;
- компактный таймер истечения;
- кнопки `Отмена` и `Ответить`.

Approval cards теперь показывают:

- `Требуется подтверждение`;
- простой текст `Агент хочет выполнить действие`;
- категорию простым языком: `Shell-команда`, `Git-действие`, `Деплой / сервер`, `Запись файлов`;
- кнопки `Отмена`, `Отклонить`, `Разрешить`.

Raw args для approval скрыты из обычного UI и видны только в devtools mode:

```js
localStorage.setItem('browserai.devtools', '1')
```

Также исправлена поддержка options как строк и как объектов `{id,label,description}`.

### Проверки

```bash
npm run build
```


## v2.6 Exact user UI: hide runtime/debug panels from normal mode

### Сделано

Обновлён компонент:

```text
src/components/MessageList.jsx
```

В обычном пользовательском Agent Mode теперь скрыты:

- `AgentRuntimePanel`;
- raw `AgentThought` blocks;
- stream protocol / provider / max steps / router warnings;
- task debug state.

Они доступны только в devtools mode:

```js
localStorage.setItem('browserai.devtools', '1')
```

Обычный UI теперь показывает только:

- сообщения пользователя/ассистента;
- tool/action cards;
- plan card;
- ask_user cards;
- approval cards;
- provider-side extended thinking, если модель сама его отдаёт в отдельном блоке;
- финальный ответ.

Это соответствует правилу: пользовательский режим не должен выглядеть как debug console.

### Проверки

```bash
npm run build
```


## v2.7 Streaming / thinking UX cleanup

### Сделано

Обновлён компонент:

```text
src/components/MessageList.jsx
```

В обычном пользовательском Agent Mode больше не показывается raw provider-side thinking / reasoning text.

Обычный UI теперь показывает только аккуратный индикатор:

```text
Агент размышляет…
```

Полный `AgentExtendedThinking` остаётся доступным только в devtools mode:

```js
localStorage.setItem('browserai.devtools', '1')
```

Это соответствует пользовательскому режиму: не раскрывать внутренние рассуждения и не превращать чат в debug console.

### Проверки

```bash
npm run build
```


## v2.8 Final answer / tool separation cleanup

### Сделано

Обновлён компонент:

```text
src/components/MessageList.jsx
```

Обычный Agent Mode теперь визуально разделяет:

1. процесс выполнения;
2. финальный ответ.

Если агент выполняет tools, но финального текста ещё нет, показывается аккуратный индикатор:

```text
Агент выполняет действия…
```

Когда финальный ответ появляется, он рендерится отдельным markdown-блоком ниже actions/tool cards, с тонким разделителем.

Пульсирующий cursor больше не висит в пустом assistant bubble, когда агент занят только tool actions.

Это соответствует пользовательскому режиму: сначала виден процесс, потом отдельный итоговый ответ.

### Проверки

```bash
npm run build
```


## v2.9 Tool / provider error UX cleanup

### Сделано

Обновлены компоненты:

```text
src/components/AgentToolBlock.jsx
src/components/MessageList.jsx
```

Обычный пользовательский UI теперь показывает короткие понятные ошибки вместо raw текста:

- `Файл не найден`;
- `Путь заблокирован политикой безопасности workspace`;
- `Команда завершилась с ошибкой`;
- `Действие заняло слишком много времени и было остановлено`;
- `Проблема авторизации или ключа`;
- `Провайдер ограничил запросы или квоту`;
- `Сетевая ошибка или временный сбой провайдера`.

Для tool errors обычный UI показывает подсказку:

```text
Агент может попробовать другой способ или запросить уточнение.
```

Raw tool error, stderr/stack и structured providerError скрыты в обычном режиме и доступны только в devtools:

```js
localStorage.setItem('browserai.devtools', '1')
```

Provider-level ошибки в assistant message теперь используют `providerError.hint`, если он есть.

### Проверки

```bash
npm run build
```


## v2.10 Workspace / file preview UX cleanup

### Сделано

Обновлён компонент:

```text
src/components/Workspace.jsx
```

Обычная workspace-панель теперь показывает пользовательские действия:

- `Файлы`;
- поиск файлов/папок;
- загрузка файлов/папок;
- создание папки/файла;
- просмотр;
- скачать;
- прикрепить в чат;
- удалить.

Dev/admin controls скрыты из обычного UI и доступны только при:

```js
localStorage.setItem('browserai.devtools', '1')
```

Скрыты за devtools:

- grep/search by content;
- show hidden files;
- GitHub import button;
- upload by URL;
- AI create file;
- AI Apply Patch.

Это делает workspace похожим на пользовательскую файловую панель, а не на developer console.

### Проверки

```bash
npm run build
```


## v2.11 Composer / input UX cleanup

### Сделано

Обновлён компонент:

```text
src/components/Composer.jsx
```

Обычный Composer теперь чище:

- placeholder: `Напишите сообщение…`;
- кнопка workspace attachment называется `Из файлов`;
- attachment chips не показывают technical label `vision-ready`;
- slash-command autocomplete скрыт из обычного UI;
- slash commands обрабатываются только в devtools mode.

Devtools mode:

```js
localStorage.setItem('browserai.devtools', '1')
```

В devtools остаются slash commands и autocomplete для разработчика/power-user.

### Проверки

```bash
npm run build
```


## v2.12 Sidebar / topbar cleanup

### Сделано

Обновлены компоненты:

```text
src/components/Sidebar.jsx
src/components/Topbar.jsx
```

Обычный sidebar/topbar теперь не показывает power/dev шум:

- `Web AI` toggle скрыт за devtools;
- auto-model hint скрыт за devtools;
- `Агент` / `Авто` badges в topbar скрыты за devtools;
- token/cost badges скрыты за devtools;
- search/checkpoints/export topbar buttons скрыты за devtools.

Обычный пользовательский topbar оставляет базовый UX:

- title/model picker;
- workspace toggle;
- API warning, если не настроено;
- logout.

Devtools mode:

```js
localStorage.setItem('browserai.devtools', '1')
```

возвращает power-user controls.

### Проверки

```bash
npm run build
```


## v2.13 Message polish / final visual cleanup

### Сделано

Обновлены компоненты:

```text
src/components/MessageList.jsx
src/components/AgentPlanCard.jsx
```

Из обычного UI убран внутренний счётчик tool-steps `Шаг N из M`, потому что это технический прогресс исполнения, а не пользовательский смысл. Он остаётся только в devtools.

Plan card стала менее debug-яркой и более пользовательской:

- заголовок по умолчанию `План действий`;
- нейтральная графитовая карточка вместо яркой violet/debug стилистики;
- progress bar в нейтральном стиле.

### Проверки

```bash
npm run build
```


## v2.14 Conversation flow cleanup

### Сделано

Обновлён компонент:

```text
src/components/MessageList.jsx
```

Унифицированы состояния agent message:

- если агент остановлен без финального текста, показывается аккуратный статус `— генерация остановлена`;
- если агент выполнил действия, но не дал финальный ответ, показывается `Агент завершил действия без итогового ответа`;
- если после tool actions произошла provider/agent error, tool cards остаются видимыми, а ошибка показывается отдельным user-facing блоком;
- raw provider error/debug details остаются только в devtools.

Это убирает пустые assistant bubbles и сохраняет видимость уже выполненных действий при ошибке.

### Проверки

```bash
npm run build
```


## v2.15 Mobile polish / responsive cleanup

### Сделано

Обновлены компоненты:

```text
src/components/AgentToolBlock.jsx
src/components/AgentAskUser.jsx
src/components/Composer.jsx
```

Улучшения для мобильного пользовательского режима:

- длинные названия действий в tool cards теперь обрезаются и не ломают ширину;
- summary/error blocks переносят длинные строки;
- кнопки approval/ask_user cards переносятся и не вылезают за экран;
- кнопки `Отмена` / `Отклонить` / `Разрешить` получают mobile-friendly ширину;
- имена attachments в Composer короче на mobile.

### Проверки

```bash
npm run build
```


## v2.16 Always-on Agent Mode UI cleanup

### Сделано

Обновлены компоненты:

```text
src/App.jsx
src/components/Sidebar.jsx
```

В обычном пользовательском UI скрыт тумблер `Агент`, потому что Agent Mode должен быть поведением по умолчанию, а не режимной debug-настройкой.

При обычном использовании:

```text
effectiveAgentMode = true
```

Даже если раньше в localStorage было `browserai.agentMode=0`, обычный пользователь не останется незаметно без agent tools.

Тумблер `Агент` доступен только в devtools mode:

```js
localStorage.setItem('browserai.devtools', '1')
```

### Проверки

```bash
npm run build
```

## Журнал v2

### 2026-06-09

- Начат Agent Mode v2 Quality Pass.
- Выполнен v2.1: developer-only Run Agent Self-Test в настройках агента; в обычном UI кнопка скрыта, чтобы не отходить от пользовательского Agent Mode.
- Выполнен v2.2: добавлена страница `/admin/agent`; кнопка `🧪 Agent Lab` в левом sidebar показывается только при `browserai.devtools=1`, потому что это Dev/Admin extension, а не Arena parity.
- Выполнен v2.3: user-facing runtime panel cleanup — debug поля скрыты за devtools, обычный UI показывает только ход выполнения.
- Выполнен v2.4: user-friendly tool cards — raw args/result скрыты за devtools, обычный UI показывает действия и краткие результаты.
- Выполнен v2.5: ask_user / approval cards cleanup — обычный UI показывает только вопрос/подтверждение, raw args только в devtools.
- Выполнен v2.6: exact user UI cleanup — runtime/debug panels и raw thoughts скрыты из обычного режима, доступны только в devtools.
- Выполнен v2.7: streaming/thinking UX cleanup — raw provider-side thinking скрыт из обычного UI; пользователь видит только индикатор `Агент размышляет…`.
- Выполнен v2.8: final answer / tool separation cleanup — процесс действий отделён от финального markdown-ответа.
- Выполнен v2.9: tool/provider error UX cleanup — обычный UI показывает понятные ошибки, raw details только в devtools.
- Выполнен v2.10: workspace/file preview UX cleanup — dev controls скрыты за devtools, обычная панель показывает только пользовательские файловые действия.
- Выполнен v2.11: composer/input UX cleanup — slash/dev autocomplete скрыт за devtools, обычный input стал проще.
- Выполнен v2.12: sidebar/topbar cleanup — power/dev элементы скрыты за devtools, обычный topbar/sidebar упрощён.
- Выполнен v2.13: message polish — internal step counter скрыт за devtools, plan card сделана пользовательской.
- Выполнен v2.14: conversation flow cleanup — единые состояния stopped/empty/error, tool cards сохраняются при ошибке.
- Выполнен v2.15: mobile polish — tool/ask cards и attachment chips лучше адаптированы под узкий экран.
- Выполнен v2.16: always-on Agent Mode UI cleanup — тумблер Агент скрыт за devtools, в обычном UI agent mode включён по умолчанию.


### 2026-06-09 — корректировка v2.1

- По замечанию пользователя self-test кнопка убрана из обычного пользовательского интерфейса.
- Кнопка остаётся доступной только в devtools-режиме:

```js
localStorage.setItem('browserai.devtools', '1')
```

Это сохраняет основной Agent Mode ближе к пользовательскому интерфейсу Arena-style, а diagnostics остаются для разработчика/admin.


### 2026-06-09 — корректировка стратегии Agent Lab

- Подтверждено: в обычном пользовательском Agent Mode нет Agent Lab, поэтому это не Arena parity.
- Кнопка `🧪 Agent Lab` скрыта из обычного левого sidebar.
- Теперь она показывается только если включён devtools flag:

```js
localStorage.setItem('browserai.devtools', '1')
```

- `/admin/agent` остаётся доступной как отдельная admin/dev diagnostics page.
