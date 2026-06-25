# Audit — DeepSeek direct tool tag parser

Дата: 2026-06-22

## Проблема

DeepSeek Chat может выдавать tool calls не как:

```xml
<xai:function_call>...</xai:function_call>
```

а напрямую:

```xml
<plan_set title="Игра">[{"idx":1,"title":"..."}]
<file_write path="index.html">...</file_write>
```

Иногда direct tags вообще не закрываются. Старый parser ждал только `xai:function_call/tool_use/function_call`, поэтому такие вызовы уходили как обычный assistant text и tools не выполнялись.

## Что исправлено

### `server/agentDecision.js`

Добавлено:

- `DIRECT_TOOL_NAMES` — список model-emitted direct tool tag names;
- `isDirectToolTag()`;
- parsing direct tool tags в `parseXmlFunctionCalls()`;
- parsing unclosed direct tags — блок заканчивается на следующем direct tool tag или на конце текста;
- parsing attributes:
  - `<file_write path="a.txt" content="hello">`;
- parsing body:
  - JSON object → args;
  - JSON array → `steps` для plan-like payload;
  - raw body для `file_write` → `content`.

### `server/agentLoop.js`

Стрим-парсер теперь:

- видит direct tags как opening tool blocks;
- не сливает их в `assistant_delta`;
- auto-closes unclosed direct tag при следующем direct tag;
- flush-ит незакрытый direct tag в конце stream как tool call;
- добавлены aliases:
  - `file_write` → `write_file`;
  - `file_read` → `read_file`;
  - `file_edit` → `edit_file`;
  - `file_delete` → `delete_file`;
  - `file_list` → `list_files`;
  - `file_search` → `search_files`.

## Tests

Обновлён:

- `server/agentDecision.test.js`

Покрыто:

- стандартный `<xai:function_call>`;
- direct unclosed tags:

```xml
<plan_set title="Игра">[{"idx":1,"title":"Сделать"}]
<file_write path="index.html">hello</file_write>
```

- direct attributes-only tag:

```xml
<file_write path="a.txt" content="hello">
```

## Verification

```bash
node --check server/agentDecision.js
node --check server/agentLoop.js
npm test -- server/agentDecision.test.js server/agentTurnOrchestrator.test.js server/agentLoop.test.js
npm run build
```

Результат:

- syntax checks — OK;
- targeted tests — OK: 3 files, 15 tests passed;
- full tests — OK: 55 files, 459 tests passed;
- build — OK.

## Риски

### False-positive на HTML/XML

Снижено: parser ищет только names из `DIRECT_TOOL_NAMES`, не любой HTML tag.

### Незакрытый tag съедает обычный текст

Снижено: direct tool body ограничивается следующим direct tool tag или концом ответа. Это ожидаемо для model-emitted tool blocks.

### Алиасы расходятся с registry

Частично закрыто: aliases добавлены в `TOOL_NAME_ALIASES` agent loop. Следующий слой — вынести aliases в общий registry module.

## Следующий слой

- Унифицировать aliases между `agentDecision`, `agentLoop`, `toolConsolidation`.
- Добавить regression scenario с mock DeepSeek direct tags end-to-end.
