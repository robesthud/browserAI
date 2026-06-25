# План полной разработки BrowserAI Agent Mode через bash

Дата: 2026-06-22
Цель: превратить текущий BrowserAI в максимально близкий к Arena.ai Agent Mode автономный агент, где основной runtime — управляемая bash-песочница с workspace, tool-cards, стримингом, проверками, снапшотами и безопасными границами.

---

## 1. Краткий аудит текущего проекта

### Что уже есть

- Web UI на React/Vite и Express backend.
- SSE endpoint `/api/agent/chat`.
- Агентный цикл `server/agentLoop.js`.
- Реестр инструментов `server/agentTools.js`.
- Workspace с per-chat scope: `/workspace/chats/{chatId}`.
- Bash tools:
  - одноразовый `bash` через `docker exec`;
  - persistent `shell_session_run`;
  - background tasks `shell_background_*`.
- Docker sandbox `agent-sandbox`.
- Поддержка OpenAI-compatible, Anthropic, Gemini, DeepSeek managed.
- Tool-cards/stream events на фронтенде.
- Авто-верификация частично: `verify_code`, `npm_test`, `verify_task`.
- Снапшоты workspace частично: `workspace_snapshot_*`, auto snapshot перед file-tools.
- Run logs/replay/task state частично.
- Operator mode, sub-agents, GitHub/ops зачатки.

### Главные проблемы относительно “как Arena Agent Mode”

1. **Слишком монолитный runtime**
   - `agentLoop.js` и `agentTools.js` очень большие.
   - Логику маршрутизации, safety, tools, state machine, provider protocol и UI-stream сложно проверять независимо.

2. **Bash не является единственным источником правды**
   - File tools пишут через Node API, bash пишет внутри контейнера.
   - Нужно унифицировать: все изменения файлов должны иметь единый event-log, snapshots, diff и read-back.

3. **Sandbox недостаточно строгий**
   - В `docker-compose.yml` sandbox имеет Docker socket и `read_only: false`.
   - Это удобно для личного VPS, но не является безопасной агентной песочницей по умолчанию.
   - Нет полноценной политики egress/network allowlist.

4. **Нет полноценного терминального Agent Mode CLI**
   - Проект в первую очередь web-чат.
   - Нужен режим `browserai agent "задача"`, который работает через bash/SSE/JSONL без UI.

5. **Слабая контрактность tools**
   - Tool schemas самописные.
   - Нужно перейти к строгим JSON Schema + Zod-подобной валидации или TypeScript schema generation.

6. **Недостаточно воспроизводимости**
   - Нужен полный `run artifact`: prompt, tool calls, stdout/stderr chunks, touched files, diffs, snapshots, costs, final status.

7. **Проверки не всегда неизбежны**
   - Есть pushback после правок, но bash-команды могут менять файлы без автоматического diff/readback/verify.

8. **Provider/tool parity неполная**
   - Native tool calling для разных провайдеров поддержан, но нужен единый внутренний протокол tool-use и тестовая матрица.

---

## 2. Целевая архитектура

```text
User / CLI / Web UI
        |
        v
Agent API Gateway
  - auth
  - rate limits
  - run creation
  - SSE/JSONL stream
        |
        v
Agent Runtime Orchestrator
  - planner
  - tool loop
  - state machine
  - policy gates
  - evidence collector
        |
        +--> LLM Adapter Layer
        |      - OpenAI-compatible
        |      - Anthropic official
        |      - Gemini official
        |      - DeepSeek managed
        |
        +--> Tool Runtime
               - bash session
               - file ops
               - web tools
               - browser tools
               - image/media tools
               - git/ops tools
        |
        v
Sandbox + Workspace
  - /workspace/chats/{chatId}
  - snapshots
  - event log
  - diffs
  - artifacts
```

Ключевой принцип: **bash/session runtime — главный исполнитель**, а file tools — безопасные обёртки над тем же workspace event-log.

---

## 3. Продуктовые требования к “как Arena Agent Mode”

### 3.1. Bash-first поведение

- Агент должен уметь:
  - запускать команды;
  - сохранять `cd`, env, virtualenv, aliases между командами;
  - держать dev-server/background process;
  - читать stdout/stderr в реальном времени;
  - останавливать команды;
  - продолжать работу после timeout без потери сессии.

### 3.2. Workspace

- Каждый чат/запуск имеет изолированный workspace.
- Все созданные файлы сразу видны в UI и доступны для скачивания.
- Перед изменениями создаётся snapshot.
- После изменений строится diff.
- Большие/секретные/кеш-директории исключаются из preview/snapshot/archive.

### 3.3. Tool stream как в Arena

События должны быть стабильными:

- `run_start`
- `agent_state`
- `thinking_delta`
- `assistant_delta`
- `tool_preview`
- `tool_start`
- `tool_progress`
- `tool_result`
- `file_change`
- `diff`
- `ask_user`
- `approval_request`
- `usage`
- `run_done`
- `run_error`

### 3.4. Автопилот

- Простые задачи — быстрый deterministic router.
- Сложные задачи — plan → inspect → edit → verify → final.
- После любой правки — обязательный read-back/diff/verify.
- При ошибке — recovery playbook.
- При зацикливании — смена стратегии или вопрос пользователю.

### 3.5. Safety

- По умолчанию sandbox без Docker socket.
- Docker/SSH/production actions — только через отдельный `ops` профиль и approval gates.
- Secret scan перед zip/commit/deploy.
- Redaction stdout/stderr и prompt history.
- Сетевой egress policy.

---

## 4. Этапы разработки

## Этап 0 — Базовая стабилизация текущего проекта

**Цель:** убедиться, что текущий код запускается, тестируется и имеет понятную baseline-диагностику.

Задачи:

1. Выполнить локально:
   - `npm ci`
   - `npm test`
   - `npm run build`
   - `node --check server/agentLoop.js`
   - `node --check server/agentTools.js`
2. Зафиксировать текущие падения в `docs/roadmap/baseline-audit.md`.
3. Добавить smoke test `/api/agent/health`.
4. Проверить Docker compose:
   - `browserai` стартует;
   - `agent-sandbox` доступен;
   - workspace общий;
   - bash может писать файлы.

Acceptance criteria:

- Есть baseline-отчёт.
- Известны все текущие failing tests/build errors.
- Health endpoint показывает `sandbox: ok`.

---

## Этап 1 — Terminal/CLI Agent Mode

**Цель:** сделать агентный режим доступным напрямую из bash, без web UI.

Новые файлы:

- `bin/browserai-agent.js`
- `server/agentCliRunner.js`
- `server/agentStreamJsonl.js`

CLI UX:

```bash
browserai agent "скачай github.com/owner/repo и запусти тесты"
browserai agent --chat my-task --cwd ./workspace "сделай лендинг"
browserai agent --jsonl "исправь ошибку"
browserai agent --continue <runId>
```

Задачи:

1. Добавить `package.json` bin:
   - `browserai`
   - `browserai-agent`
2. CLI должен использовать тот же `runAgent`, но писать stream в stdout:
   - human-readable mode;
   - JSONL mode для интеграций.
3. Реализовать локальный provider config:
   - env: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`;
   - `.browserai/providers.json`;
   - CLI flags `--base-url`, `--model`, `--api-key-env`.
4. Поддержать `--workspace` и `--chat`.
5. Добавить tests для CLI stream.

Acceptance criteria:

- Команда `browserai agent "создай hello.js и запусти node hello.js"` создаёт файл, запускает bash и даёт финальный отчёт.
- CLI показывает tool progress как компактные строки.
- JSONL stream содержит машинно-читаемые события.

---

## Этап 2 — Bash runtime 2.0

**Цель:** сделать bash точно таким же надёжным, как у Agent Mode.

Задачи:

1. Вынести shell runtime в отдельный модуль:
   - `server/runtime/shell/ShellSessionManager.js`
   - `server/runtime/shell/BashTool.js`
   - `server/runtime/shell/BackgroundTaskManager.js`
2. Добавить PTY-режим опционально:
   - `node-pty` или fallback на текущий sentinel protocol.
3. Улучшить persistent session:
   - отдельные stdin/stdout ring buffers;
   - корректный Ctrl-C;
   - idle cleanup;
   - command queue visibility;
   - exit-code always reliable.
4. Bash file-change watcher:
   - до команды: workspace snapshot metadata;
   - после команды: touched files, diff, created/deleted files.
5. Авто-readback для файлов, изменённых bash-командой.
6. Tool `bash` должен возвращать:
   - `stdout`, `stderr`, `exitCode`, `durationMs`;
   - `changedFiles`;
   - `diffSummary`;
   - `backgroundTaskId`, если команда ушла в фон.

Acceptance criteria:

- `cd`, `export`, virtualenv сохраняются между вызовами.
- Если bash создал/изменил файл, агент видит это как structured evidence.
- Timeout не убивает всю сессию без необходимости.

---

## Этап 3 — Workspace Evidence Engine

**Цель:** единый источник правды о файлах, изменениях и доказательствах.

Новые модули:

- `server/workspaceEventLog.js`
- `server/workspaceDiff.js`
- `server/workspaceIndex.js`
- `server/artifactStore.js`

Задачи:

1. Каждое изменение файла пишет событие:
   - `file_created`
   - `file_updated`
   - `file_deleted`
   - `snapshot_created`
   - `diff_generated`
2. File tools и bash runtime используют один event-log.
3. Добавить diff API:
   - `GET /api/workspace/diff?runId=...`
4. Добавить artifact API:
   - `GET /api/agent/runs/:runId/artifact`
5. Улучшить snapshot policy:
   - exclude `node_modules`, `.git`, `dist`, `build`, caches;
   - cap по размеру;
   - restore preview.

Acceptance criteria:

- Финальный ответ может ссылаться только на реальные evidence events.
- UI показывает изменённые файлы и diff.
- CLI сохраняет artifact `.browserai/runs/<runId>.json`.

---

## Этап 4 — Tool Registry 2.0

**Цель:** строгие, тестируемые, расширяемые tools.

Задачи:

1. Разбить `server/agentTools.js` на домены:
   - `tools/fileTools.js`
   - `tools/bashTools.js`
   - `tools/webTools.js`
   - `tools/gitTools.js`
   - `tools/mediaTools.js`
   - `tools/opsTools.js`
   - `tools/memoryTools.js`
2. Ввести единый тип Tool:

```js
{
  name,
  description,
  schema,
  risk,
  readOnly,
  handler,
}
```

3. Перейти на JSON Schema как canonical format.
4. Генерировать:
   - native OpenAI tools;
   - Anthropic tools;
   - Gemini tools;
   - prompt markdown docs;
   - frontend tool cards metadata.
5. Regression test:
   - prompt не содержит несуществующих tools;
   - every tool has schema/risk/readOnly;
   - readOnly tools can run parallel.

Acceptance criteria:

- `agentTools.js` становится тонким aggregator.
- Любой новый tool добавляется в одном месте и автоматически попадает в prompt/spec/UI.

---

## Этап 5 — Agent Loop 2.0

**Цель:** сделать agent loop меньше, предсказуемее и ближе к Arena.

Новые модули:

- `agent/orchestrator.js`
- `agent/modelTurn.js`
- `agent/toolExecutor.js`
- `agent/stateMachine.js`
- `agent/finalizer.js`
- `agent/recovery.js`
- `agent/stream.js`

Задачи:

1. Разделить текущий `agentLoop.js` на компоненты.
2. Ввести внутренний Turn Protocol:

```js
{
  thoughtText,
  assistantText,
  toolCalls: [{ id, name, args }],
  usage,
  rawProviderPayload
}
```

3. Поддержать три tool-call протокола:
   - native;
   - XML fallback;
   - fenced JSON fallback.
4. State machine:
   - classify task;
   - inspect;
   - plan;
   - execute;
   - verify;
   - final.
5. Жёсткие done gates:
   - code changed → verify required;
   - bash changed files → readback/diff required;
   - deploy requested → approval + healthcheck;
   - commit requested → secret_scan + git status.
6. Добавить “continue run” после max-steps/deadline.

Acceptance criteria:

- `agentLoop.js` не больше ~300 строк или становится adapter.
- Unit tests покрывают каждый state transition.
- Агент не может финализировать кодовую задачу без evidence verification.

---

## Этап 6 — Prompt parity с Arena Agent Mode

**Цель:** системный prompt должен быть минимальным, точным и инструментально строгим.

Задачи:

1. Собрать prompt из блоков:
   - identity;
   - environment;
   - tool protocol;
   - safety;
   - task policy;
   - workspace state;
   - tool catalog.
2. Prompt должен быть профилирован:
   - chat: минимум;
   - web: web tools only;
   - code: file/bash/git/verify;
   - media: media tools;
   - ops: approval tools.
3. Запретить “фальшивые” операции:
   - нельзя говорить, что тесты прошли без tool evidence;
   - нельзя ссылаться на непрочитанные файлы;
   - нельзя имитировать создание изображения SVG/ASCII вместо real image tool.
4. Добавить prompt snapshot tests.

Acceptance criteria:

- Простое “привет” не отправляет 50k токенов.
- Code task получает только релевантные tools.
- Prompt и tool registry всегда синхронизированы.

---

## Этап 7 — Sandbox Security Profiles

**Цель:** безопасный режим по умолчанию + расширенный режим для личного VPS.

Профили:

1. `safe` — default
   - нет Docker socket;
   - нет SSH mount;
   - egress ограничен;
   - read-only image;
   - только `/workspace` writable.
2. `devops`
   - Docker socket по approval;
   - SSH по approval;
   - GitHub token по approval.
3. `trusted-local`
   - режим владельца, максимум возможностей.

Задачи:

1. Разделить compose services/profiles.
2. Вынести Docker socket из default sandbox.
3. Добавить network policy:
   - allow public internet;
   - block private IP/metadata;
   - опциональный allowlist.
4. Добавить per-tool risk category.
5. Approval UI/CLI:
   - approve once;
   - approve for run;
   - deny.

Acceptance criteria:

- По умолчанию агент не может управлять Docker хоста.
- Ops tools требуют явного подтверждения.
- Все секреты в логах маскируются.

---

## Этап 8 — UI parity

**Цель:** интерфейс максимально похож на Arena Agent Mode.

Задачи:

1. Compact tool cards:
   - bash/read/write/edit/test/web;
   - collapsed by default;
   - live stdout/stderr.
2. Workspace panel:
   - tree;
   - changed files;
   - diff viewer;
   - preview;
   - download artifacts.
3. Run timeline:
   - steps;
   - current phase;
   - blockers;
   - costs/tokens.
4. Ask user / approval cards.
5. Stop/continue/resume buttons.
6. Mobile layout.

Acceptance criteria:

- Пользователь видит каждый bash шаг как tool card.
- После создания файла он сразу появляется в workspace.
- Если поток оборвался, UI не зависает.

---

## Этап 9 — Web/browser/computer tools

**Цель:** добрать возможности Arena-like агента.

Задачи:

1. Web search заменить/расширить провайдером с нормальными citations:
   - SearXNG/Tavily/Brave/SerpAPI опционально;
   - fallback DuckDuckGo.
2. `web_fetch`:
   - markdown extraction;
   - PDF parse;
   - chunking.
3. Browser tools:
   - Playwright с persistent context;
   - screenshot visible in UI;
   - DOM snapshot;
   - click/type/select/wait.
4. Computer use профиль отдельно.
5. Image/media tools capability routing.

Acceptance criteria:

- Агент может проверить локальную web-страницу через browser screenshot.
- Web facts в финальном ответе имеют источники.

---

## Этап 10 — Evaluation and regression suite

**Цель:** доказать, что режим работает “как агент”, а не только на демо.

Тестовые сценарии:

1. `create_file_and_run`
   - создать JS файл;
   - запустить;
   - исправить ошибку;
   - финал с evidence.
2. `clone_repo_and_test`
   - git clone;
   - npm ci;
   - npm test;
   - report.
3. `edit_existing_project`
   - найти компонент;
   - внести правку;
   - build/test.
4. `bash_state_persistence`
   - `cd`, `export`, subsequent command.
5. `background_server`
   - start dev server;
   - poll logs;
   - browser_open localhost.
6. `safety_denies_rm_root`
   - destructive command blocked or requires approval.
7. `stream_cut_recovery`
   - interrupted run resumable.
8. `no_fake_test_claims`
   - модель пытается сказать “tests passed” без теста → pushback.

Acceptance criteria:

- Все сценарии проходят на mock provider + минимум smoke на real provider.
- Replay artifacts сохраняются для каждого regression run.

---

## 5. Приоритетный MVP-план на ближайшую разработку

### MVP-1: CLI + bash-first

1. Добавить `browserai agent` CLI.
2. Подключить CLI к `runAgent` через JSONL stream adapter.
3. Сделать `shell_session_run` основным tool для bash.
4. Добавить post-bash changed files detection.
5. Добавить smoke tests.

### MVP-2: Evidence + verification

1. Workspace event-log.
2. Diff после bash/file tools.
3. Обязательная verify gate после любых changed files.
4. Финальный ответ только с evidence summary.

### MVP-3: Refactor tools/loop

1. Разбить tools по файлам.
2. Разбить agentLoop.
3. Ввести строгий Tool schema.
4. Snapshot tests prompt/tool registry.

### MVP-4: Security profiles

1. Safe sandbox default.
2. Ops profile отдельно.
3. Approval gates для Docker/SSH/deploy/commit push.

---

## 6. Конкретные файлы для изменения первыми

1. `package.json`
   - добавить `bin`, scripts для CLI/smoke.
2. `server/agentLoop.js`
   - вынести stream adapter и tool executor.
3. `server/agentTools.js`
   - выделить bash tools первыми.
4. `server/shellSession.js`
   - улучшить session protocol и changed files detection.
5. `server/workspace.js`
   - добавить event-log hooks.
6. `server/routes/agent.js`
   - добавить run artifact endpoints.
7. `docker-compose.yml`
   - разделить sandbox profiles.
8. `src/lib/agentStream.js`
   - стабилизировать event schema handling.
9. `src/components/AgentToolBlock.jsx`
   - diff/progress cards.
10. `tests/`
   - добавить runtime regression tests.

---

## 7. Definition of Done

Проект можно считать “Agent Mode через bash как Arena-like”, когда:

- CLI и Web используют один agent runtime.
- Bash session persistent и надёжный.
- Все file/bash изменения фиксируются как evidence.
- Агент не может финализировать кодовую задачу без проверки или явного blocker evidence.
- UI/CLI показывают tool progress в реальном времени.
- Run можно остановить, продолжить и воспроизвести по artifact.
- Sandbox безопасен по умолчанию.
- Есть regression suite на ключевые агентные сценарии.

---

## 7.1. Autopilot unblock status

✅ Выполнен отдельный слой снятия runtime-блокеров Agent Mode:

- `server/agentLoop.js` — lightweight chat/web route теперь выключен по умолчанию; полный agent loop является default runtime. Opt-in обратно: `BROWSERAI_LIGHTWEIGHT_ROUTE=1`.
- `server/smartRouter.js` — ambiguous/simple default теперь `agent`, а не `chat`.
- `server/approvalGate.js` — deploy/git/docker/systemctl/kubectl больше не имеют hard approval gate и идут по default `auto` policy. Оставлен только catastrophic guard для wipe/format/root-destruction команд; его можно отключить explicit env `BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=1`.

Аудит: `docs/roadmap/autopilot-unblock-audit-2026-06-22.md`.

## 8. Рекомендуемый порядок выполнения

1. Baseline tests/build audit. ✅ Старт выполнен: `docs/roadmap/baseline-audit-2026-06-22.md`.
2. CLI `browserai agent`. ✅ Первый CLI adapter добавлен: `bin/browserai-agent.js`, `server/agentCliRunner.js`.
3. Bash runtime changed-files detection. ✅ Первый lightweight tracker добавлен: `server/workspaceChangeTracker.js`; `bash`/`shell_session_run` теперь возвращают `changedFiles`.
4. Workspace event-log + diffs. ✅ Event-log + diff foundation выполнены: добавлены `server/workspaceEventLog.js`, `server/workspaceDiff.js`, SSE `file_change`, JSONL event-log `.browserai/events.jsonl`, UI-плашка `Δ files`, раскрываемый `diff preview` в tool cards, `GET /api/workspace/events`, `GET /api/workspace/diff`, Workspace `Δ` diff viewer, event-log rotation, runId binding и replay artifact `workspaceChanges`. Аудиты: `docs/roadmap/mvp-2-2-diff-audit-2026-06-22.md`, `docs/roadmap/diff-api-viewer-audit-2026-06-22.md`, `docs/roadmap/event-log-run-binding-audit-2026-06-22.md`. Следующий подпункт — run-specific diff viewer / evidence block integration.
5. Verification gates для bash changes. 🟡 Частично: shell outcome теперь помечает `codeChanged=true`, и существующий verification pushback учитывает bash-изменения кода.
6. Tool registry split.
7. Agent loop split.
8. Safe sandbox profiles.
9. UI diff/tool polish.
10. Regression/eval suite.

## 7.2. Direct tool tag parser status

✅ Добавлен слой совместимости с DeepSeek direct tool tags:

- `server/agentDecision.js` — batch/parser теперь понимает прямые теги `<plan_set>`, `<file_write>`, unclosed direct tags, attrs/body payload.
- `server/agentLoop.js` — stream parser теперь перехватывает direct tags, auto-closes unclosed blocks при следующем tool tag или конце stream, не сливает tool XML в финальный текст.
- Добавлены aliases `file_write → write_file`, `file_read → read_file`, `file_edit → edit_file`, `file_delete → delete_file`, `file_list → list_files`, `file_search → search_files`.

Аудит: `docs/roadmap/deepseek-direct-tool-parser-audit-2026-06-22.md`.
