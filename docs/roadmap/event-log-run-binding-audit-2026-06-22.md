# Audit — Event-log rotation + runId binding + replay artifact integration

Дата: 2026-06-22

## Что добавлено

### 1. Workspace event-log rotation / tail reading

Файл: `server/workspaceEventLog.js`

- Добавлен лимит размера event-log:
  - `WORKSPACE_EVENT_LOG_MAX_BYTES`, default `2 MB`.
- При превышении лимита `.browserai/events.jsonl` ротируется в `.browserai/events.jsonl.1`.
- Чтение events больше не читает весь файл целиком:
  - читается tail chunk;
  - default `WORKSPACE_EVENT_LOG_READ_TAIL_BYTES=768 KB`.

### 2. runId binding

Workspace events теперь содержат:

```json
{
  "runId": "run-..."
}
```

Также `runId` дублируется в `meta.runId` для обратной совместимости metadata consumers.

Подключено в `server/agentLoop.js`:

- `recordToolWorkspaceEvents(..., runId: runLog.runId)`;
- SSE `file_change` теперь отдаёт `runId`.

### 3. Workspace API фильтры

Файл: `server/routes/workspace.js`

- `GET /api/workspace/events?runId=...&path=...&limit=...`
- `GET /api/workspace/diff?runId=...&path=...&limit=...`

Теперь можно фильтровать event-log/diffs по запуску и файлу.

### 4. Frontend API support

Файл: `src/lib/workspace.js`

- `workspaceApi.getEvents(limit, { runId, path })`
- `workspaceApi.getDiffs(path, limit, { runId })`

### 5. Replay artifact integration

Файл: `server/replayArtifact.js`

Replay artifact теперь содержит:

```json
{
  "workspaceChanges": {
    "eventCount": 1,
    "changedFileCount": 1,
    "paths": ["src/a.js"],
    "diffCount": 1,
    "diffs": [
      {
        "runId": "run-...",
        "path": "src/a.js",
        "type": "file_modified",
        "tool": "edit_file",
        "patch": "--- a/src/a.js\n+++ b/src/a.js\n..."
      }
    ]
  }
}
```

Источник — SSE trace `file_change` events, поэтому replay остаётся самодостаточным.

## Аудит рисков

### 1. Event-log бесконечно растёт

Статус: исправлено для MVP.

- Есть ротация по размеру.
- Хранится один rotated файл `.1`.
- Следующий слой: retention policy по количеству rotated файлов.

### 2. Чтение большого event-log блокирует request

Статус: снижено.

- Читается tail chunk, а не весь файл.
- `limit` ограничен до 1000.

### 3. runId path traversal

Статус: OK.

- `safeRunId()` удаляет `/`, `\\`, `\0`.
- runId не используется как путь в workspace event API.

### 4. Смешивание событий разных запусков

Статус: исправлено.

- Events имеют top-level `runId`.
- API поддерживает `runId` filter.
- Replay artifact извлекает run-scoped data из SSE текущего run.

### 5. Replay artifact размер

Статус: ограничено.

- В artifact diff patch режется до 16k символов на item.
- Сохраняется максимум 30 diff records.

### 6. Backward compatibility

Статус: OK.

- Старые events без `runId` продолжают читаться.
- `/diff` продолжает работать без `runId`.
- `workspaceChanges` — additive поле в replay artifact.

## Проверки

```bash
node --check server/routes/workspace.js
node --check server/agentLoop.js
node --check server/agentTools.js
node --check server/workspaceDiff.js
node --check server/workspaceChangeTracker.js
node --check server/workspaceEventLog.js
node --check server/replayArtifact.js
node --check server/agentFinalComposer.js
node --check server/agentCliRunner.js
npm test
npm run build
```

Ожидаемый критерий:

- syntax checks — OK;
- full tests — OK: 54 files, 454 tests passed;
- build — OK;
- deploy healthcheck — OK.

## Следующий слой

1. Run-specific diff viewer: открыть diff конкретного run из replay/resume.
2. Event-log retention: N rotated files + admin cleanup.
3. Связать `workspaceChanges` с `AgentEvidenceBlock`.
4. Добавить export/download replay artifact с diff patches.
