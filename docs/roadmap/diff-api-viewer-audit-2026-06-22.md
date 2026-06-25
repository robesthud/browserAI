# Audit — Diff API + Workspace Diff Viewer

Дата: 2026-06-22

## Добавлено в этом слое

### Backend API

- `GET /api/workspace/events?limit=200`
  - читает `.browserai/events.jsonl` внутри текущего chat workspace scope;
  - возвращает последние workspace events.

- `GET /api/workspace/diff?path=<optional>&limit=500`
  - читает workspace events;
  - вытаскивает только events с `meta.diff.patch`;
  - фильтрует по `path`, если передан;
  - возвращает список diff records.

Файл:

- `server/routes/workspace.js`

### Frontend API client

Добавлено в `src/lib/workspace.js`:

- `workspaceApi.getEvents(limit)`
- `workspaceApi.getDiffs(path, limit)`

### UI

В Workspace panel добавлена кнопка:

```text
Δ
```

Она открывает полноэкранный/модальный diff viewer:

- показывает последние diff events;
- группирует diff по event;
- раскрывает последний diff по умолчанию;
- отображает tool/type/time/path.

Файл:

- `src/components/Workspace.jsx`

### Tests

Добавлен route test:

- `server/routes/workspace.test.js`

Проверяет:

- `/api/workspace/events` отдаёт event-log;
- `/api/workspace/diff?path=...` отдаёт diff preview;
- chat scope работает через `X-BrowserAI-Chat-Id`.

## Максимальный аудит текущего слоя

### 1. Auth / scope isolation

Риск: diff API может показать события другого чата.

Статус: OK.

- endpoints используют общий `scoped()` wrapper;
- scope берётся из `X-BrowserAI-Chat-Id`, query/body `chatId`;
- чтение `.browserai/events.jsonl` идёт внутри текущего workspace scope.

### 2. Path traversal

Риск: `path` в `/diff` может пытаться выйти за workspace.

Статус: OK.

- endpoint не читает произвольный файл по `path`;
- он фильтрует уже записанные event records;
- event-log write normalizes path через `replace(/^\/+/, '')`;
- actual log file path создаётся через `safePath('.browserai/events.jsonl')`.

### 3. Большой event-log

Риск: `.browserai/events.jsonl` может вырасти и чтение будет дорогим.

Статус: acceptable for MVP, нужен следующий слой.

- API ограничивает `limit` до 1000;
- `readWorkspaceEvents()` пока читает весь файл и slice-last;
- следующий шаг: streaming tail / rotation.

### 4. Большой diff

Риск: UI/JSON может быть большим.

Статус: частично закрыт предыдущим слоем.

- diff generation ограничен `WORKSPACE_DIFF_MAX_BYTES` и `WORKSPACE_DIFF_MAX_LINES`;
- viewer показывает уже ограниченные patches;
- следующий шаг: artifact storage / server-side paging.

### 5. Backward compatibility

Риск: старые events без `meta.diff`.

Статус: OK.

- `/events` отдаёт все events;
- `/diff` игнорирует events без `meta.diff.patch`.

### 6. UI failure mode

Риск: если API падает, Workspace panel ломается.

Статус: OK.

- `openDiffViewer()` ловит ошибку;
- пишет ошибку в workspace error state;
- modal показывает пустой список/ошибку через общий error display.

### 7. Preview UX

Риск: diff внутри tool card и отдельный viewer дублируют данные.

Статус: intentional.

- tool card показывает local inline evidence текущего действия;
- `Δ` viewer показывает историю diff events workspace.

## Проверки

Выполнено локально:

```bash
node --check server/routes/workspace.js
node --check server/agentLoop.js
node --check server/agentTools.js
node --check server/workspaceDiff.js
node --check server/workspaceChangeTracker.js
node --check server/workspaceEventLog.js
node --check server/agentFinalComposer.js
node --check server/agentCliRunner.js
npm test
npm run build
```

Результат:

- syntax checks — OK;
- `npm test` — OK: 54 files, 453 tests passed;
- `npm run build` — OK.

## Что осталось на следующий слой

1. Event-log rotation / tail reader без чтения всего файла.
2. Diff artifact integration в run replay.
3. Связать `file_change` events с `runId`.
4. Workspace diff viewer: фильтры по file/tool/run.
5. Добавить отдельный diff viewer для конкретного tool card / final evidence block.
