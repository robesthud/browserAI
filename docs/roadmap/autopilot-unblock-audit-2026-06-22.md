# Audit — Agent autopilot unblock

Дата: 2026-06-22

## Что изменено

### 1. Full Agent Loop по умолчанию

Файл: `server/agentLoop.js`

Раньше:

- если router/classifier возвращал `chat` или `web`, запрос уходил в `runLightweightChat`;
- lightweight path не давал модели полный tool loop.

Теперь:

- полный Agent Loop — default runtime;
- lightweight no-tools route оставлен только как explicit opt-in:

```env
BROWSERAI_LIGHTWEIGHT_ROUTE=1
```

По умолчанию `BROWSERAI_LIGHTWEIGHT_ROUTE=0`, то есть даже chat/web-classified turns идут через agent loop.

### 2. Smart router default → agent

Файл: `server/smartRouter.js`

Раньше ambiguous/simple default был:

```js
{ mode: 'chat' }
```

Теперь:

```js
{ mode: 'agent', reason: 'default-agent' }
```

Важно: explicit current-info requests всё ещё могут классифицироваться как `web`, но из-за пункта 1 они всё равно не уходят в lightweight route, если `BROWSERAI_LIGHTWEIGHT_ROUTE` не включён.

### 3. Approval gate: deploy/git/docker больше не hard-block

Файл: `server/approvalGate.js`

Раньше `commandLooksDangerous()` всегда требовал approval для:

- `docker compose up`
- `docker restart`
- `systemctl restart`
- `kubectl apply`
- `deploy.sh`
- `git push`
- `git reset --hard`
- и т.п.

Теперь эти операции идут по user policy. Default policy — `auto`, значит они не блокируются.

Оставлен только catastrophic guard для очевидного уничтожения среды:

- `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`, `rm -rf *`;
- `dd if=...`;
- `mkfs.*`;
- `chmod -R 777 /`;
- `chown -R ... /`;
- `curl|sh`, `wget|bash`.

Его можно отключить только explicit env:

```env
BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=1
```

## Почему не убран catastrophic guard полностью

Это последняя защита от необратимого уничтожения workspace/host. Она не мешает автономным product/deploy операциям:

- deploy;
- restart;
- git push;
- docker compose;
- kubectl apply;
- service restart.

Но защищает от wipe/format/root-destruction команд.

## Tests

Добавлены/обновлены:

- `server/smartRouter.test.js`
- `server/approvalGate.test.js`

Проверено:

- default route для `привет` → `agent`;
- web detection сохраняется;
- `docker compose up`, `git push`, `systemctl restart` не требуют approval при default auto policy;
- `rm -rf /` всё ещё требует approval, если не выставлен `BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=1`.

## Verification

```bash
node --check server/approvalGate.js
node --check server/agentLoop.js
node --check server/smartRouter.js
npm test -- server/approvalGate.test.js server/smartRouter.test.js server/agentLoop.test.js server/agentPolish2.test.js
npm run build
```

Результат targeted:

- 4 test files passed;
- 29 tests passed;
- build OK.

Результат full suite перед пушем:

- 55 test files passed;
- 457 tests passed;
- build OK.

## Remaining note

Production deploy выполняется после push этого слоя.

## Trusted owner deployment toggle

В `docker-compose.yml` добавлены env-переменные для runtime:

```env
BROWSERAI_LIGHTWEIGHT_ROUTE=${BROWSERAI_LIGHTWEIGHT_ROUTE:-0}
BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=${BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL:-1}
```

Для текущего Timeweb owner-only deployment catastrophic approval guard выключается по умолчанию compose-профилем, то есть все bash/deploy/git/docker действия идут без approval. Для переносимых/публичных инсталляций в `.env.example` рекомендовано держать `BROWSERAI_DISABLE_CATASTROPHIC_APPROVAL=0`.
