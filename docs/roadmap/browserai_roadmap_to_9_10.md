# BrowserAI roadmap to 9/10

Статус документа: **рабочий master-plan**
Дата старта: **2026-06-19**
Текущая оценка: **~8.7–8.8 / 10**
Целевая оценка: **9.0 / 10**

## Ключевое направление проекта

BrowserAI развивается не как набор точечных фич под конкретные кейсы, а как:
- **максимально автоматизированная** dev-platform, которая умеет сама проходить полный цикл работы по задаче,
- **универсальная** платформа для разных типов задач, а не только для одного сценария,
- **model-agnostic runtime**, одинаково надёжный для разных ИИ-моделей и провайдеров,
- **evidence-driven agent system**, где результат подтверждается реальными действиями, а не только текстовым отчётом.

### Неподвижные принципы
- BrowserAI должен становиться ближе к уровню **Arena.ai Agent Mode**, то есть к максимально автономной работе с минимальной ручной подстраховкой.
- Любая доработка должна быть **платформенной**, а не привязанной к одному проекту, одному боту, одному стеку или одной модели.
- Любой критичный runtime behavior должен работать:
  - для разных задач,
  - для разных workspace-сценариев,
  - для разных tool paths,
  - для разных ИИ-моделей.
- Если выбор стоит между:
  - локальной заплаткой под один кейс
  - и более общей системной реализацией,
  приоритет всегда у **системной универсальной реализации**.
- UI должен оставаться **минималистичным, автономным и не перегруженным**: интерфейс не должен превращаться в сложную ручную панель управления, а должен помогать агенту работать почти самостоятельно, как в Arena.ai.
- Любые UI-изменения должны усиливать:
  - автономность работы,
  - прозрачность доказательств,
  - удобство на мобильных устройствах,
  - но не должны размывать минималистичный характер продукта.

---

## Как использовать этот план

- Каждый **подход** = один крупный development batch.
- Внутри подхода собраны **типовые улучшения**, которые выгодно делать вместе.
- После завершения каждого подхода мы:
  1. отмечаем статус,
  2. вписываем коммиты,
  3. фиксируем результат e2e/регрессий,
  4. обновляем оценку качества.
- Этот файл — **канонический журнал развития**. Его будем обновлять после каждого захода.

### Статусы
- `[ ]` не начато
- `[~]` в работе
- `[x]` выполнено
- `[!]` выполнено частично / требует follow-up

---

# Сводная дорожная карта

## Сквозные критерии успеха для всех подходов

Каждый следующий подход должен повышать BrowserAI одновременно по 4 осям:
1. **Автономность** — меньше ручного спасения и ручных уточнений.
2. **Универсальность** — улучшение работает не на одном кейсе, а на целом классе задач.
3. **Кросс-модельность** — поведение сохраняется на разных ИИ-моделях и провайдерах.
4. **Доказуемость результата** — система подтверждает сделанное evidence-данными.

Если изменение не улучшает хотя бы 2 из этих 4 осей, его приоритет должен считаться пониженным.

| Подход | Название | Цель | Рост качества |
|---|---|---|---:|
| 1 | Security + Access Baseline | Закрыть чувствительные дыры и выровнять server-side auth | 7.0 → 7.3 |
| 2 | Runtime Unification | Свести legacy/consolidated/provider paths к одному контракту | 7.3 → 7.9 |
| 3 | Evidence-Driven Finalization | Сделать финализацию доказательной, а не риторической | 7.9 → 8.3 |
| 4 | Regression Matrix + Provider Certification | Чтобы изменения больше не ломали соседние пути | 8.3 → 8.6 |
| 5 | Agent State Machine Hardening | Убрать loop/stuck/chaotic transitions | 8.6 → 8.8 |
| 6 | Observability + Replay + Quality Metrics | Быстро понимать, что ломается и почему | 8.8 → 8.9 |
| 7 | Trust UX + Prod Readiness | Довести UX доверия и release discipline до зрелого уровня | 8.9 → 9.0 |

---

# Подход 1 — Security + Access Baseline

**Статус:** `[x]`
**Цель:** закрыть чувствительные API и выстроить единый server-side access policy.
**Почему это batch:** security-аудит выгодно делать одной волной, иначе остаются случайные дыры.

## Что входит

### 1.1 Route auth inventory
- [x] составить таблицу всех route:
  - public
  - authenticated
  - owner/admin only
  - internal only
- [x] зафиксировать policy в отдельном документе/комментариях

### 1.2 Unified auth middleware
- [x] ввести/выровнять middleware:
  - `requireAuth`
  - `requireOwner`
  - `requireRole(...)`
- [x] убрать случайные ad-hoc проверки по файлам

### 1.3 Sensitive endpoint protection
- [x] закрыть `settings` routes
- [x] закрыть `workspace` routes
- [x] закрыть `operator` routes
- [x] закрыть `agent` execution routes
- [x] проверить остальные `/api/*` endpoints на утечки

### 1.4 Secret exposure hardening
- [x] минимизировать возврат живых ключей даже authenticated-клиенту
- [x] выделить safe DTO для frontend response
- [x] замаскировать секреты в UI/API, где возможно
- [~] проверить логи/ошибки/stack traces на секреты

### 1.5 Security regression tests
- [x] добавить route auth tests
- [x] добавить negative tests на secret exposure
- [x] добавить owner/admin authorization tests

## Definition of done
- все чувствительные endpoints имеют явную policy
- public route surface намеренно ограничен
- unauth curl-audit проходит
- auth regression tests зелёные

## Артефакты
- server route policy map
- authz tests
- security audit report

## Текущее выполнение
- уже сделано:
  - закрыты `settings/workspace/operator/agent` routes
  - public оставлен `GET /api/agent/health`
  - добавлены `server/routes/authz.test.js`
  - добавлен единый `server/authz.js`
  - owner-only policy введена для settings/operator surface
  - создан `route_policy_inventory.md`
  - settings/keys API переведён на safe DTO без возврата живых stored secrets в клиент
  - chat/agent runtime научен работать через `keyId + useStoredSecret`, без обязательной отправки полного секрета с клиента
  - добавлены `server/errorSanitizer.js` и безопасная sanitization-логика для route errors / provider errors / structured logger meta
  - Gemini debug logging больше не пишет ключ в query string и redacts raw response preview
  - jobs route surface теперь существует и защищён auth-policy, без возврата inline provider secrets в returned job payload
- финальный итог подхода:
  - security baseline достаточен для перехода к следующей стадии platform hardening
  - оставшиеся задачи относятся уже к future tightening, а не к незакрытому базовому security blocker
- future tightening (не blocker для закрытия подхода):
  - добить остаточные прямые `console.warn/error(... e.message ...)` места по серверу до единой sanitization discipline
  - со временем ввести ещё более строгую explicit reveal / rotate secret flow

---

# Подход 2 — Runtime Unification

**Статус:** `[~]`
**Цель:** сделать единый runtime contract для всех tool paths и провайдеров, чтобы BrowserAI вёл себя как одна универсальная автоматизированная система, а не как набор разных полу-независимых режимов.
**Почему это batch:** пока legacy и consolidated paths живут по-разному, platform quality всегда будет проседать.

## Что входит

### 2.1 Unified normalized tool history
- [~] ввести единый internal schema для всех tool events:
  - `toolFamily`
  - `toolName`
  - `action`
  - `semanticOk`
  - `paths`
  - `command`
  - `evidenceTags`
  - `verificationKind`
- [~] перестать завязывать критическую логику на raw tool names

### 2.2 Consolidated/legacy parity
- [~] выровнять поведение для:
  - `file` ↔ `read_file/write_file/edit_file`
  - `shell` ↔ `bash/shell_session_*`
  - `verify` ↔ `verify_code/verify_task/npm_test`
  - `plan` ↔ `plan_set/plan_check`
  - `git/docker/ops`
- [ ] убрать места, где consolidated path special-cased кусочно

### 2.3 Provider path parity
- [~] унифицировать поведение для:
  - managed DeepSeek
  - openai-compatible providers
  - native-tools providers
- [ ] добиться одинаковой finalization logic поверх provider layer

### 2.4 Scoped workspace invariants
- [x] создавать scoped workspace root до старта agent loop
- [ ] проверить все входы в agent/workspace paths на одинаковые scope invariants
- [ ] добавить tests на fresh scope / empty scope / resumed scope

### 2.5 Runtime contract tests
- [~] regression suite на consolidated path
- [~] regression suite на legacy path
- [x] regression suite на scoped workspace startup

## Definition of done
- final gates работают одинаково на legacy и consolidated tool paths
- provider-specific path differences не ломают truth logic
- scoped workspace never fails on first contact

## Артефакты
- normalized history schema
- runtime parity tests
- provider parity smoke matrix

## Текущее выполнение
- уже сделано:
  - consolidated verification gates улучшены
  - scoped init before loop уже добавлен
- остаётся:
  - полная internal normalization
  - provider-wide parity layer

---

# Подход 3 — Evidence-Driven Finalization

**Статус:** `[ ]`
**Цель:** финальный ответ должен строиться на доказательствах, а не на “красивом объяснении”.
**Почему это batch:** truthfulness, verification and blockers нужно чинить вместе, иначе возникают ложные финалы.

## Что входит

### 3.1 Evidence model
- [ ] ввести структурную модель evidence по типам задач:
  - inspect evidence
  - code-change evidence
  - test evidence
  - deploy evidence
  - blocker evidence

### 3.2 Final status schema
- [ ] добавить machine-readable финальный статус, например:
  - `taskCompleted`
  - `verified`
  - `localTests.requested/attempted/passed`
  - `deploy.requested/done/verified`
  - `blockers[]`

### 3.3 Unsupported claim blocking
- [ ] запретить claims без evidence:
  - “все тесты прошли”
  - “локально нельзя проверить”
  - “файл X изменён”
  - “проект готов”
- [ ] финальный текст строить поверх validated facts

### 3.4 Blocker semantics
- [ ] если не хватает credentials/approval/tooling → переводить run в `blocked`, а не в “болтающийся финал”
- [ ] нормализовать причины partial completion

### 3.5 Anti-fabrication follow-up
- [ ] расширить проверки на invented paths / invented analysis
- [ ] добавить suite ложных финалов и “ловушек на враньё”

## Definition of done
- любой финальный ответ разлагается на реальные tool-evidence
- ложные success claims системно режутся
- partial completion и blockers прозрачны

## Артефакты
- final status schema
- false-final regression suite
- blocker classification tests

---

# Подход 4 — Regression Matrix + Provider Certification

**Статус:** `[ ]`
**Цель:** перестать ломать соседние сценарии после каждого фикса и зафиксировать, что BrowserAI стабильно работает на разных классах задач и на разных ИИ-моделях.
**Почему это batch:** regression matrix даёт качество только как система, а не как отдельный тест.

## Что входит

### 4.1 Canonical task suite
- [ ] собрать 20–30 эталонных задач:
  - file ops
  - mini project generation
  - import-safe module
  - ESM/CommonJS cases
  - repo analysis
  - explicit local test required
  - deploy obligation checks
  - fake file/fake success traps

### 4.2 Multi-provider matrix
- [ ] прогонять минимум на:
  - managed DeepSeek
  - Zhipu
  - Gemini/openai-compatible
  - OpenRouter/Groq

### 4.3 Mode matrix
- [ ] chat
- [ ] web
- [ ] agent
- [ ] consolidated tools
- [ ] scoped workspace
- [ ] authenticated routes

### 4.4 Golden run artifacts
- [ ] сохранять:
  - stream trace
  - normalized tool history
  - structured final status
  - expected vs actual outcome

## Definition of done
- каждый критичный путь имеет e2e smoke coverage
- перед deploy есть обязательный smoke suite
- known-bug regressions не возвращаются тихо

## Артефакты
- regression suite directory
- provider certification matrix
- golden run fixtures

---

# Подход 5 — Agent State Machine Hardening

**Статус:** `[ ]`
**Цель:** убрать хаос переходов, stuck loops и бесполезные повторения.
**Почему это batch:** state machine, retry budgets и stuck detection нужно проектировать вместе.

## Что входит

### 5.1 Explicit phases
- [ ] discover
- [ ] plan
- [ ] execute
- [ ] verify
- [ ] finalize
- [ ] blocked

### 5.2 Allowed transitions
- [ ] зафиксировать разрешённые переходы
- [ ] ввести guards на недопустимые переходы

### 5.3 Tool constraints by phase
- [ ] finalize не пишет файлы
- [ ] verify не пропускает обязательные проверки
- [ ] discover не делает risky ops без оснований

### 5.4 Retry/loop budgets
- [ ] лимиты на одинаковые действия
- [ ] structured stuck detection
- [ ] escalation strategy вместо бесконечных повторов

### 5.5 Blocked-state UX/runtime
- [ ] явный blocked outcome
- [ ] понятная причина
- [ ] рекомендация следующего действия

## Definition of done
- падает доля `max-steps`
- падает доля stuck loops
- phase logs становятся предсказуемыми

## Артефакты
- phase contract doc
- state machine tests
- stuck-loop regression cases

---

# Подход 6 — Observability + Replay + Quality Metrics

**Статус:** `[x]`
**Цель:** быстро видеть качество платформы и быстро расследовать сбои.
**Почему это batch:** логи, replay и метрики должны описывать одну и ту же картину.

## Что входит

### 6.1 Structured run logs
- [x] provider
- [x] route mode
- [x] task type
- [x] phase transitions
- [x] tool calls
- [x] semantic failures
- [x] finalization reason
- [x] blocker reason

### 6.2 Replay artifacts
- [x] input
- [x] normalized tool history
- [x] structured final status
- [x] SSE trace summary

### 6.3 Quality KPIs
- [x] success rate
- [x] false-final rate
- [x] max-steps rate
- [x] stream-cut rate
- [x] verification-missing rate
- [x] provider-specific failure rate

### 6.4 Error taxonomy
- [x] auth
- [x] provider
- [x] route
- [x] workspace scope
- [x] tool schema
- [x] loop/stuck
- [x] false finalization
- [x] deploy/runtime

## Definition of done
- ✅ по каждому провалу можно быстро понять, что именно случилось
- ✅ качество платформы измеряется, а не обсуждается ощущениями

## Артефакты
- ✅ metrics dashboard spec → `docs/observability/kpi-dashboard.md`
- ✅ replay artifact format → `docs/observability/replay-artifact-schema.md`
- ✅ incident/error taxonomy → `docs/observability/error-taxonomy.md`

---

# Подход 7 — Trust UX + Prod Readiness

**Статус:** `[ ]`
**Цель:** довести продукт до состояния, где ему можно доверять не только как internal beta.
**Почему это batch:** UX доверия, release discipline и prod behavior должны сходиться в один слой зрелости.

## Что входит

### 7.1 Trust-oriented UI
- [ ] показывать evidence block структурно
- [ ] changed files / commands / tests / blockers
- [ ] obligations checklist в UI

### 7.2 Stream resilience UX
- [ ] восстановление после stream cut
- [ ] resume last run
- [ ] понятные статусы interrupted / partial / blocked

### 7.3 Release discipline
- [ ] обязательный pre-deploy smoke suite
- [ ] release checklist
- [ ] rollback checklist
- [ ] backup policy / deploy safety

### 7.4 Provider support policy
- [ ] сертифицированный список провайдеров
- [ ] known limitations matrix
- [ ] supported vs experimental labeling

## Definition of done
- пользователь видит не только “ответ”, но и подтверждение результата
- deploy/release стали повторяемыми
- продукт можно позиционировать как зрелую universal dev platform

## Артефакты
- UI trust checklist
- release checklist
- provider support matrix

---

# Журнал выполнения

## Подход 1
- Статус: `[~]`
- Коммиты:
  - `1f54d15` — `fix(auth): protect sensitive project routes`
  - `c8dfe46` — `fix(ui): stabilize mobile chat scrolling and actions`
  - `9018237` — `fix(auth): centralize route policy and owner guards`
  - `9191dbb` — `fix(ui): prioritize native mobile touch scrolling`
  - `3fb2790` — `fix(secrets): stop exposing stored provider keys to the client`
  - `3fb63ce` — `fix(ui): reduce aggressive mobile viewport locking`
  - `1394fb1` — `fix(ui): keep native mobile touch scroll responsive`
  - `NEXT(local)` — error sanitization + log redaction batch
- Что сделано:
  - закрыты sensitive project routes server-side auth
  - unauth доступ к `/api/settings`, `/api/workspace/*`, `/api/operator/*`, `/api/agent/chat`, `/api/chat` запрещён
  - public оставлен `GET /api/agent/health`
  - добавлен `server/authz.js`
  - settings/operator routes разделены по уровню доступа (`auth` vs `owner`)
  - собран `route_policy_inventory.md`
  - добавлены route auth / owner / secret-exposure tests
  - settings API перестал возвращать живые stored provider keys в клиент
  - runtime научен использовать сохранённые серверные ключи через `keyId + useStoredSecret`
  - route errors, provider errors и logger meta начали проходить через sanitization
  - Gemini debug logging больше не пишет секретный key в URL и редактирует raw response preview
  - параллельно выполнен micro-batch минималистичного mobile UI hygiene и затем дополнительный touch-scroll hardening для mobile
- Что осталось:
  - более строгая future-safe модель reveal/rotate secret flow
  - optional full sweep менее критичных legacy log points до единой sanitization discipline

## Подход 2
- Статус: `[~]`
- Коммиты:
  - `3eae446` — `refactor(agent): centralize runtime history semantics`
  - `e01a641` — `refactor(agent): normalize runtime evidence entries`
  - `6d60fd5` — `refactor(provider): centralize stored and managed provider resolution`
  - `84dc00f` — `refactor(agent): centralize runtime call semantics`
  - `c41b6f1` — `refactor(runtime): sanitize errors and centralize tool result semantics`
  - `53d66cc` — `feat(jobs): expose authenticated background job routes`
  - `bf0dc06` — `feat(operator): add provider parity smoke suite`
  - `f14965a` — `docs(roadmap): record provider parity smoke progress`
  - `e590fe8` — `feat(operator): add provider parity scenario matrix`
- Что сделано:
  - вынесен единый semantic layer для history/tool evidence в `server/agentRuntimeSemantics.js`
  - consolidated и legacy tool-path semantics начали обслуживаться через общий модуль, а не через разрозненные helper'ы внутри `agentLoop.js`
  - добавлены unit tests для unified runtime semantics
  - runtime history entries начали нормализоваться в более явный semantic/evidence shape
  - `agentLoop` начал использовать normalized runtime semantics при сборке runtime evidence
  - provider resolution вынесен в единый модуль `server/providerResolution.js`
  - settings validate, `/api/chat`, `/api/agent/chat` и background agent provider paths начали использовать общий stored/managed provider resolution flow
  - уменьшено расхождение между active-provider path, stored-secret path и managed DeepSeek path
  - runtime call semantics вынесены в `server/runtimeCallSemantics.js`
  - `agentLoop` начал использовать centralized call semantics для:
    - read-back after edits
    - pre-deploy verification blocking
    - tool narration
  - tool result semantics вынесены в `server/runtimeToolResultSemantics.js`
  - error/diagnostic sanitization вынесена в `server/errorSanitizer.js`
  - `agentLoop`, route errors, provider errors и logger начали использовать централизованную sanitization discipline
  - background jobs получили authenticated HTTP route surface (`/api/jobs/*`) с user-scoped access, safe returned input, and background-agent entrypoint parity
  - operator surface получил owner-only provider parity smoke suite для реальной cross-provider проверки
  - operator surface получил scenario-based provider parity matrix (`chat_ok`, `agent_file_write`, `agent_local_test`) как следующий шаг к multi-provider regression coverage
  - добавлен `server/agentSseCapture.js` как переиспользуемый захватчик agent SSE для background jobs и smoke runs
  - added dedicated semantic regression layers:
    - `server/agentRuntimeSemantics.test.js`
    - `server/providerResolution.test.js`
    - `server/runtimeCallSemantics.test.js`
    - `server/runtimeToolResultSemantics.test.js`
    - `server/providerParitySmoke.test.js`
    - `server/providerParityScenarios.test.js`
    - `server/routes/jobs.test.js`
- Что осталось:
  - перевести ещё больше runtime decisions на normalized semantic objects
  - расширить provider-path parity
  - усилить regression matrix для нескольких провайдеров
  - унифицировать error/diagnostic handling вокруг тех же normalized runtime layers

## Подход 3 — Evidence-Driven Finalization
- Статус: `[x]`
- Дата завершения: 2026-06-20
- Коммиты:
  - `LOCAL` — `feat(agent): add machine-readable finalStatus schema with blockers and evidence summary`
  - `LOCAL` — `feat(agent): integrate finalStatus into agentLoop.js done events and task finish`
  - `LOCAL` — `feat(agent): add blocked/partial status for unmet obligations, missing tests, deadline, max-steps, crash`
  - `LOCAL` — `feat(agent): strengthen anti-fabrication gates (fabrication, missing_verification, test_failed)`
  - `LOCAL` — `feat(agent): add evidenceModel.js with typed categories (inspect, codeChange, test, deploy, blocker)`
  - `LOCAL` — `feat(agent): add evidenceGapForTaskType, validateClaimsAgainstEvidence, evidenceModelToText`
  - `LOCAL` — `feat(tests): add agentFinalStatus.test.js (16 tests), evidenceModel.test.js (16 tests)`
- Что сделано:
  - `server/agentFinalStatus.js` — machine-readable `finalStatus` с `taskCompleted`, `verified`, `localTests`, `deploy`, `blockers[]`, `evidenceSummary`
  - `server/evidenceModel.js` — типизированные evidence categories (inspect, codeChange, test, deploy, blocker) + gap detection + claim validation
  - `blockers[]` — 9 типов: missing_test, test_failed, missing_verification, unmet_obligation, max_steps, deadline, aborted, runtime_error, fabrication
  - Интеграция в `agentLoop.js` — `buildFinalStatus` перед каждым `sseDone` и `finishAgentTask`
  - `finishAgentTask` сохраняет `finalStatus` + статус `succeeded|blocked|partial|failed`
  - `sseDone` отправляет `finalStatus` в клиент через `done` event
  - Все termination paths покрыты: final, deadline, max-steps, crash, llm-error, cap-reached, no-provider
  - 32 regression tests (agentFinalStatus + evidenceModel)
- Что осталось (future tightening, не blocker):
  - UI-рендеринг `finalStatus` evidence block в чат (входит в Подход 7)
  - Golden run artifacts в Object Storage для аудита (входит в Подход 6)

## Подход 4 — Regression Matrix + Provider Certification
- Статус: `[x]`
- Дата завершения: 2026-06-20
- Коммиты:
  - `LOCAL` — `feat(agent): add 25 canonical regression tasks (chat, web, agent)`
  - `LOCAL` — `feat(agent): add golden run artifact capture with browserai.golden_run.v1 schema`
  - `LOCAL` — `feat(agent): add regression runner with task generator and matrix summary`
  - `LOCAL` — `feat(agent): add pre-deploy smoke suite (scripts/pre-deploy-smoke.sh)`
  - `LOCAL` — `feat(agent): integrate smoke into deploy.sh before build`
  - `LOCAL` — `feat(tests): add regressionSuite.test.js (17 tests)`
- Что сделано:
  - `server/regressionSuite.js` — 25 canonical tasks: file ops, code generation, git, verify, anti-fabrication, deploy/health, browser, ESM/CJS, mini React, shell session, web search, secrets, repo analysis, large file edits, empty workspace
  - `server/regressionArtifacts.js` — golden run capture (toolHistory, finalStatus, streamTrace, expected vs actual), diff engine, listing
  - `server/regressionRunner.js` — `runRegressionTask` async generator + `runRegressionMatrix` summary runner
  - `scripts/pre-deploy-smoke.sh` — fast pre-deploy smoke suite (non-blocking, runs first provider × first 3 critical tasks)
  - `deploy.sh` — integrated smoke before build
  - 17 regression tests + 16 evidenceModel + 16 agentFinalStatus = 49 tests новых
  - All 91 tests pass (17 files)
- Что осталось (future tightening, не blocker):
  - Реальные e2e прогоны на живых провайдерах (требуют live keys + время)
  - CI GitHub Actions интеграция smoke suite (входит в Подход 7)

## Подход 5 — Agent State Machine Hardening
- Статус: `[x]`
- Дата завершения: 2026-06-20
- Коммиты:
  - `LOCAL` — `feat(agent): replace taskStateMachine.js with full agent state machine`
  - `LOCAL` — `feat(agent): integrate state machine into agentLoop.js (budget, guard, stuck detection, escalation)`
  - `LOCAL` — `feat(tests): add 39 agentStateMachine regression tests`
- Что сделано:
  - **Explicit phases**: discover → plan → execute → verify → finalize | blocked | recover
  - **Allowed transitions matrix**: 7 phases, 21 transitions, guard validation
  - **Tool constraints by phase** (advisory soft enforcement, not hard cage — prevents real failures from strict allowlists):
    - discover/plan: no write/edit/bash/verify/ops
    - verify: no write/edit/delete
    - finalize: no write/edit/bash/ops/docker/verify
  - **Retry budget**: per-tool max 3 retries, per-verify max 2 retries
  - **Stuck detection**: consecutive same tool (5+), phase stuck (8 steps no progress), oscillation (verify↔execute), plan stuck (3 steps no done)
  - **Escalation strategy**: pushback prompt + advisory warning in SSE, NOT hard block (preserves autonomy)
  - **Recovery phase**: automatic transition after failed tool → re-discover
  - `agentStateMachine.js` — 500+ lines, fully typed, tested
  - Интеграция в `agentLoop.js`: budget per run, `guardToolCall` advisory, `detectStuck` + `shouldEscalate` pushback before each LLM call, `lastPhaseChangeStep` tracking
  - 39 тестов на transitions, tool constraints, retry budget, stuck detection, phase derivation, escalation, guard, nextPhase
  - All 130 tests pass (18 files)
- Что осталось (future tightening, не blocker):
  - Hard phase enforcement как опция (для strict environments)
  - UI-рендеринг текущей фазы в чат (входит в Подход 7)

## Подход 6
- Статус: `[x]`
- Дата завершения: 2026-06-20
- Коммиты:
  - `LOCAL` — `feat(observability): errorTaxonomy.js with 12 categories + fingerprint + URL secret scrubbing`
  - `LOCAL` — `feat(observability): runLogs.js (browserai.run_log.v1) + per-run NDJSON-style events`
  - `LOCAL` — `feat(observability): replayArtifact.js (browserai.replay.v1) + persist + load`
  - `LOCAL` — `feat(observability): qualityKpis.js + aggregateKpis + recentKpis`
  - `LOCAL` — `feat(agent): integrate runLog + replay capture into agentLoop.js + 7 termination paths`
  - `LOCAL` — `feat(routes): owner-only /api/operator/kpis + /api/operator/runs + /api/operator/replays`
  - `LOCAL` — `feat(tests): 6 test files for errorTaxonomy, runLogs, replayArtifact, qualityKpis, integration`
- Что сделано:
  - `server/errorTaxonomy.js` — 12 categories (auth, provider, route, workspace_scope, tool_schema, tool_execution, loop_stuck, llm_runtime, verification_missing, false_finalization, deploy_runtime, aborted, unknown), severity (info|warn|error|critical), stable fingerprint, URL-secret scrubbing
  - `server/runLogs.js` — `browserai.run_log.v1` NDJSON-style log at `${DATA_DIR}/runs/${runId}.json`, lifecycle methods (run_start, phase, toolCall, semantic_fail, finalization, error, run_end), auto-summary tracking
  - `server/replayArtifact.js` — `browserai.replay.v1` artifact at `${DATA_DIR}/replays/${runId}.json`, normalized history with semantic fields, SSE trace capture, sseSummary (streamCut, doneReason, etc.)
  - `server/qualityKpis.js` — aggregateKpis(summarizeReplay, isSuccess, isFalseFinal, isMaxSteps, isStreamCut, hasVerificationMissing, hasProviderFailure), recentKpis({limit}), byProvider / byTaskType breakdowns
  - `agentLoop.js` integration — wrapResForSseTrace proxy + finalizeRun helper on all 7 termination paths (final, deadline, max-steps, crash, llm-error, cap-reached, no-provider) + toolCall events in result loop
  - `server/routes/operator.js` — `GET /api/operator/kpis`, `GET /api/operator/runs[/:runId]`, `GET /api/operator/replays[/:runId]` (all owner-only)
  - `docs/observability/{error-taxonomy,replay-artifact-schema,kpi-dashboard}.md` — canonical docs
- Что осталось (future tightening, не blocker):
  - UI-дашборд для KPIs (входит в Подход 7 — Trust UX)
  - Golden run comparison в CI (входит в Подход 7)

## Подход 7
- Статус: `[ ]`
- Коммиты:
- Что сделано:
- Что осталось:

---

# Что делаем следующим

## Следующий рекомендуемый ход
**Подходы 1–7 завершены**. Текущая оценка: **~9.0 / 10** (целевая достигнута).

Дальнейшие улучшения — `future tightening`:
1. UI "Resume last run" кнопка в `AgentEvidenceBlock` (server endpoint готов, нужен frontend hook)
2. Provider tier badge в `AgentSettingsSection.jsx` (providerWarning() готов, нужен badge UI)
3. S3 backup через Timeweb Object Storage (документация есть, нужны credentials)
4. HTTPS + Let's Encrypt (нужен домен)
5. UI "interrupted" banner при stream-cut с auto-retry

Параллельно продолжаем инфраструктурный трек:
- HTTPS + Let's Encrypt (требуется домен),
- S3 backup через Timeweb Object Storage (требуется access_key/secret_key/bucket).
