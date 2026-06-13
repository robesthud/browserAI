# AGENTS.md

Правила для AI-агентов, работающих с этим репозиторием.

## Главные правила

1. Работай только с реальными инструментами из `server/agentTools.js`.
2. Не добавляй в prompt/tool profiles имена инструментов, которых нет в `TOOLS`.
3. Перед правкой файла: `read_file` → `edit_file`/`write_file` → `verify_code` для JS/JSON → `npm_test` при изменении логики.
4. Для многошаговой задачи используй `plan_set` и отмечай прогресс через `plan_check`.
5. Не заявляй в финальном ответе то, что не подтверждено tool results.
6. Не спрашивай путь к файлу, если его можно найти через `list_files`/`search_files`.
7. Рискованные действия (`delete_file`, deploy/restart через `ops_run_action`, commit/push через `git_commit`) делай только когда задача этого требует и контекст понятен.

## Проверки

Минимум перед коммитом:

```bash
node --check server/agentLoop.js
node --check server/agentTools.js
node --check server/clinePrompt.js
node --check server/llmClient.js
npm test
npm run build
```

## Агентный prompt

`server/clinePrompt.js` должен быть синхронизирован с `server/agentTools.js`:

- если инструмент удалён из registry — удалить его из prompt, quick reference, profiles и документации;
- если prompt требует инструмент — инструмент должен быть зарегистрирован и покрыт тестом;
- `renderToolsForPrompt()` обязан фильтровать каталог по активному профилю (`toolNames`) и lite-режиму.

Регрессия: `tests/agent-tool-registry.test.js`.

## Деплой

Production — Timeweb VPS через `.github/workflows/deploy-timeweb.yml`.

Не хранить секреты в репозитории. GitHub token, SSH key, host/user/app dir — только в GitHub Secrets или локальном окружении.
