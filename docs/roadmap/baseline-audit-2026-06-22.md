# Baseline audit — BrowserAI Agent Mode

Дата: 2026-06-22

## Команды

```bash
npm ci
node --check server/agentLoop.js
node --check server/agentTools.js
node --check server/agentCliRunner.js
node --check server/workspaceChangeTracker.js
node --check bin/browserai-agent.js
npm test
npm run build
```

## Результат

- `npm ci` — OK.
- Syntax checks — OK.
- `npm test` — OK: 50 test files, 449 tests passed.
- `npm run build` — OK.

## Предупреждения

### npm install warnings

Есть deprecated-пакеты в dependency tree:

- `whatwg-encoding`
- `rimraf@2`
- `prebuild-install`
- `lodash.isequal`
- `inflight`
- `glob@7`
- `fstream`

На текущий build/test не влияют.

### Vite build warnings

- Некоторые chunks больше 500 kB.
- Значительная часть времени build уходит на legacy/terser plugins.

Это не блокер для Agent Mode runtime, но позже стоит вынести code splitting.

### Test stderr noise

В тестах есть ожидаемый шум:

- warning миграции `params`: `no such table: params`;
- curl к `127.0.0.1:8080`, когда локальный сервер не запущен;
- `/opt/browserai` отсутствует локально.

Тесты при этом проходят.

## Вывод

Baseline зелёный. Можно продолжать MVP-1/MVP-2: CLI Agent Mode + bash changed-files evidence.
