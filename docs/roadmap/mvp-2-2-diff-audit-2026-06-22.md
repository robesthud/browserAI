# MVP-2.2 audit — Workspace Event Log + Diff Preview

Дата: 2026-06-22

## Что добавлено

### Backend

- `server/workspaceDiff.js`
  - лёгкий unified-style diff generator без внешних зависимостей;
  - compact context для изменённых строк;
  - лимит `WORKSPACE_DIFF_MAX_LINES`.

- `server/workspaceChangeTracker.js`
  - теперь при snapshot workspace сохраняет small text preview для code-like файлов;
  - `diffWorkspaceStates()` возвращает `diffs[]` и `diffCount`;
  - bash/session changes получают diff preview для created/modified/deleted text files.

- `server/workspaceEventLog.js`
  - пишет JSONL events в `.browserai/events.jsonl`;
  - переносит diff в `event.meta.diff`, если он есть в tool result.

- `server/agentTools.js`
  - `write_file` и `edit_file` теперь возвращают:
    - `diffPreview`;
    - `changedFiles.diffs[]`;
    - корректный `codeChanged` только для code-like путей.

- `server/agentLoop.js`
  - protocol содержит `file_change`;
  - после tool result записываются workspace events;
  - `file_change` SSE отправляет события с diff metadata.

- `server/agentFinalComposer.js`
  - финальный Runtime evidence вытаскивает bash-changed paths из shell outcome.

- `server/agentCliRunner.js`
  - CLI выводит `Δ files ...` при `file_change`.

### Frontend

- `src/lib/useChats.js`
  - принимает `file_change`;
  - сохраняет `fileChanges` в assistant message и tool call;
  - обновляет workspace revision.

- `src/components/MessageList.jsx`
  - передаёт `fileChanges` и `fileChangeSummary` в `AgentToolBlock`.

- `src/components/AgentToolBlock.jsx`
  - показывает зелёную плашку `Δ N`;
  - показывает список workspace изменений;
  - показывает раскрываемый `diff preview`.

## Аудит конфликтов/рисков

### 1. Размер diff

Риск: большие файлы могут перегрузить SSE/UI.

Статус: ограничено.

- `WORKSPACE_DIFF_MAX_BYTES`, default `96 KB`;
- `WORKSPACE_DIFF_MAX_LINES`, default `240`;
- UI показывает максимум 3 diff preview внутри одной tool card.

### 2. Binary files

Риск: попытка прочитать binary как UTF-8.

Статус: снижено.

- diff строится только для code-like путей;
- файлы с `\0` не попадают в text snapshot;
- большие файлы не читаются.

### 3. Verification gate для не-code файлов

Риск: `write_file` мог помечать любой файл как `codeChanged=true`.

Исправлено.

- добавлен `isCodeLikePath()` в `server/agentTools.js`;
- `codeChanged=true` только для code-like расширений/Dockerfile.

### 4. Backward compatibility

Риск: старые tool results без `changedFiles.diffs`.

Статус: совместимо.

- UI использует fallback из `result.changedFiles`;
- event-log работает без diff;
- final evidence не требует diff.

### 5. Event-log рост

Риск: `.browserai/events.jsonl` может расти.

Статус: пока приемлемо для MVP.

Следующий слой: ротация/limit и API чтения событий.

## Проверки

```bash
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

Результат локально:

- syntax checks — OK;
- `npm test` — OK: 53 files, 452 tests passed;
- `npm run build` — OK.

## Вывод

MVP-2.2 foundation готов: BrowserAI теперь фиксирует workspace events, строит diff preview для small text/code files и показывает это в CLI/UI. Следующий полезный слой — diff API + полноэкранный diff viewer / artifact integration.
