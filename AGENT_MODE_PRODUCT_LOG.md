# BrowserAI Agent/Operator Mode Product Log

Дата: 2026-06-13

## Цель

Сделать BrowserAI личным AI developer/operator agent, максимально близким по практическим возможностям к Arena.ai Agent Mode: понимать любые задачи разработки, читать и менять проект, запускать проверки, создавать PR, ждать CI, чинить ошибки, деплоить, смотреть логи, вести инциденты и давать отчёты.

---

## Уже сделано

### 1. Background Agent Jobs

Добавлено:

- кнопка/режим запуска агента в фоне;
- background `agent_run` jobs;
- восстановление queued/running background agent jobs после restart;
- structured trace для SSE/tool events;
- отображение structured trace в job card;
- ссылка открытия job в чат.

Ключевые файлы:

- `server/jobs.js`
- `src/lib/useChats.js`
- `src/components/Composer.jsx`
- `src/components/JobCard.jsx`
- `src/components/JobsTray.jsx`

---

### 2. Automation Center

Добавлен Automation Center в `/admin/agent`.

Recipes:

- `production_health_check`
- `browserai_deploy_safe`
- `production_self_heal_restart`
- `workspace_security_audit`
- `github_ci_status`
- `browserai_full_diagnostic`

Ключевые файлы:

- `server/agentWorkflows.js`
- `src/components/AutomationCenter.jsx`

---

### 3. Durable Workflows

Добавлен workflow engine v1.

Таблицы:

- `agent_workflows`
- `agent_workflow_steps`
- `agent_tool_ledger`

Возможности:

- persistent workflows;
- step statuses;
- resume after restart;
- idempotency ledger для safe steps;
- retry/cancel;
- workflow reports.

Ключевой файл:

- `server/agentWorkflows.js`

---

### 4. Policy Engine

Добавлен `automationPolicy`.

Политика контролирует:

- scheduled safe-only workflows;
- production-write confirmation;
- max running workflows per user;
- max production writes per hour;
- denied recipes;
- audit events.

Ключевой файл:

- `server/automationPolicy.js`

API:

- `GET /api/agent/policy`

---

### 5. Scheduled Automations

Cron теперь умеет запускать workflow recipes.

Добавлено:

- trigger `workflow`;
- UI создания scheduled automation;
- список schedules;
- pause/enable;
- delete;
- run now;
- policy check для scheduled workflows.

Ключевые файлы:

- `server/cron.js`
- `src/components/AutomationCenter.jsx`

---

### 6. Agent Inbox

Добавлена единая очередь внимания.

Показывает:

- incidents;
- approvals/questions;
- workflows;
- jobs.

Позволяет:

- answer approvals;
- retry/cancel workflows;
- resolve incidents;
- diagnose incidents.

Ключевой файл:

- `src/components/AgentInbox.jsx`

---

### 7. Incidents

Добавлен incident engine.

Таблица:

- `incidents`

Возможности:

- create incident;
- dedupe by fingerprint;
- link workflow;
- resolve;
- list/get;
- global incidents visible to users.

Ключевой файл:

- `server/incidents.js`

API:

- `GET /api/incidents`
- `GET /api/incidents/:id`
- `POST /api/incidents/:id/resolve`
- `POST /api/incidents/:id/diagnose`

---

### 8. RCA Reports

Добавлен Root Cause Analysis для incidents.

Категории:

- `health_check_failure`
- `github_ci_failure`
- `docker_or_compose_failure`
- `build_failure`
- `auth_or_secret_failure`
- `unknown`

RCA содержит:

- primary category;
- summary;
- evidence;
- recommended actions.

Ключевой файл:

- `server/incidents.js`

---

### 9. GitHub Webhooks

Добавлен public webhook endpoint:

- `POST /api/webhooks/github`

Поддерживает:

- `workflow_run completed` with non-success conclusion;
- `push` to `main`.

Добавлено:

- signature verification via `X-Hub-Signature-256`;
- DB/env webhook secret;
- webhook setup UI;
- auto-create webhook via GitHub API.

Ключевые файлы:

- `server/index.js`
- `src/components/AutomationCenter.jsx`
- `server/ops.js`

API:

- `GET /api/webhooks/github/config`
- `POST /api/webhooks/github/secret`

---

### 10. Production Watchdog

Добавлен watchdog.

Делает:

- periodic health check;
- incident on repeated failure;
- diagnostic workflow;
- auto-resolve after recovery.

Ключевой файл:

- `server/productionWatchdog.js`

Env:

- `PRODUCTION_WATCHDOG_ENABLED`
- `PRODUCTION_WATCHDOG_URL`
- `PRODUCTION_WATCHDOG_INTERVAL_MS`
- `PRODUCTION_WATCHDOG_TIMEOUT_MS`
- `PRODUCTION_WATCHDOG_FAIL_THRESHOLD`
- `PRODUCTION_WATCHDOG_WORKFLOW_COOLDOWN_MS`

---

### 11. Deploy/Backup Hardening

Исправлено:

- stale `*_browserai` compose replacement containers;
- stale deploy helper containers;
- stale git locks;
- false health failures due host `localhost:8080` check;
- backup recursion;
- BusyBox tar incompatibility.

Ключевые файлы:

- `deploy.sh`
- `server/ops.js`
- `server/backup.js`

---

### 12. Agent Control Plane

Добавлен верхнеуровневый статус агентного контура.

Показывает:

- open incidents;
- failed/running workflows;
- failed/running jobs;
- pending approvals;
- schedules;
- recipes;
- webhook configured;
- policy limits.

Ключевые файлы:

- `server/agentControlPlane.js`
- `src/components/AgentControlPlanePanel.jsx`

API:

- `GET /api/agent/control-plane`

---

### 13. Operator Mode v1

Добавлен личный developer/operator mode.

Ключевые сущности:

- `operator_projects`
- `operator_missions`

Mission types:

- `universal_dev_task`
- `code_task`
- `fix_tests`
- `full_diagnostic`
- `fix_deploy`
- `safe_deploy`
- `self_heal_restart`
- `custom_agent`

Ключевые файлы:

- `server/operatorMode.js`
- `src/components/OperatorConsole.jsx`

API:

- `GET /api/operator/status`
- `GET /api/operator/projects`
- `POST /api/operator/projects`
- `GET /api/operator/missions`
- `GET /api/operator/missions/:id`
- `POST /api/operator/missions`

---

### 14. Universal Operator Routing

Добавлена классификация любой задачи пользователя:

- deploy failure → `fix_deploy`
- production deploy → `safe_deploy`
- restart/self-heal → `self_heal_restart`
- CI/GitHub → `full_diagnostic`
- coding/dev task → `code_task`
- unknown/general → `custom_agent`

Ключевой файл:

- `server/operatorMode.js`

---

### 15. Operator Mode Tools inside Agent Mode

Добавлены tools:

- `operator_status`
- `operator_project_profile`
- `operator_start_mission`
- `operator_list_missions`
- `operator_get_mission`
- `operator_finalize_code_task`
- `operator_wait_code_task_ci`
- `operator_auto_fix_code_task_ci`
- `operator_merge_code_task_pr`

Теперь обычный Agent Mode может запускать Operator Mode.

Ключевые файлы:

- `server/agentTools.js`
- `server/toolAllowlist.js`
- `server/taskStateMachine.js`

---

### 16. Code Operator Execution Pipeline v1

Добавлен Code Operator pipeline.

Таблица:

- `operator_code_tasks`

Pipeline:

1. checkout/clone repo;
2. create operator branch;
3. run background code agent;
4. deterministic verification;
5. `npm test`;
6. `npm run build`;
7. `secret_scan`;
8. report.

Ключевой файл:

- `server/operatorCode.js`

API:

- `GET /api/operator/code-tasks`
- `GET /api/operator/code-tasks/:id`

---

### 17. Code Operator PR Finalization

Добавлено:

- verification before finalize;
- secret scan before commit;
- git commit;
- push branch;
- create GitHub PR;
- PR link in UI;
- tool `operator_finalize_code_task`.

API:

- `POST /api/operator/code-tasks/:id/finalize`

---

### 18. PR/CI Loop

Добавлено:

- wait GitHub Actions CI for operator branch/PR;
- fetch failed workflow logs;
- summarize CI logs;
- create incident on failed CI;
- tool `operator_wait_code_task_ci`;
- UI button `wait CI`.

API:

- `POST /api/operator/code-tasks/:id/wait-ci`

---

### 19. CI Auto-Fix Loop

Добавлено:

- start CI auto-fix from failed CI logs;
- run new code agent on same branch;
- verify;
- commit;
- push same branch;
- wait CI again;
- repeat max N attempts;
- tool `operator_auto_fix_code_task_ci`;
- UI button `auto-fix CI`.

API:

- `POST /api/operator/code-tasks/:id/auto-fix-ci`

---

### 20. PR Merge + Safe Deploy Flow

Добавлено:

- merge PR only if CI green;
- block merge before CI;
- block draft PR;
- merge methods: `merge`, `squash`, `rebase`;
- optional safe deploy after merge;
- deploy workflow link;
- tool `operator_merge_code_task_pr`;
- UI buttons `merge`, `merge+deploy`.

API:

- `POST /api/operator/code-tasks/:id/merge`

---

## Тестовое покрытие

Добавлены/обновлены тесты:

- `tests/automation-control-plane.test.js`
- `tests/operator-mode.test.js`
- `tests/operator-code.test.js`
- `tests/agent-tool-registry.test.js`

Текущее состояние:

- 20 test files passed
- 72 tests passed
- 5 skipped

---

## Текущий общий статус

BrowserAI уже имеет:

- Agent Mode;
- Background jobs;
- Durable workflows;
- Policy Engine;
- Automation Center;
- Agent Inbox;
- Incidents;
- RCA;
- GitHub webhooks;
- Production watchdog;
- Control Plane;
- Operator Mode;
- Code Operator;
- PR/CI loop;
- CI auto-fix;
- PR merge + safe deploy.

---

# План до полного завершения

## Фаза 1. Operator Core Hardening

Цель: сделать Operator Mode центральным и надёжным runtime.

- [x] Operator Mode v1
- [x] Universal task routing
- [x] Code Operator pipeline
- [x] PR/CI loop
- [x] CI auto-fix
- [x] PR merge + safe deploy
- [ ] Mission timeline events
- [ ] Persistent mission events table
- [ ] Unified mission report renderer
- [ ] Mission cancellation/resume per phase
- [ ] Mission dependency graph

## Фаза 2. Mission Timeline + Observability

- [ ] `operator_mission_events`
- [ ] timeline for jobs/workflows/code/deploy/CI
- [ ] UI component `OperatorMissionTimeline`
- [ ] live event polling
- [ ] event severity: info/warn/error/success
- [ ] export mission report

## Фаза 3. Runbook Memory / Lessons Learned

- [ ] `.browserai/runbooks/deploy.md`
- [ ] `.browserai/runbooks/ci.md`
- [ ] `.browserai/runbooks/incidents.md`
- [ ] auto-save lessons from RCA
- [ ] operator reads runbooks before mission
- [ ] UI for runbooks

## Фаза 4. Deploy Sessions

- [ ] `deploy_sessions`
- [ ] `deploy_events`
- [ ] deploy follow live logs
- [ ] deploy session UI
- [ ] rollback session report
- [ ] attach deploy session to mission

## Фаза 5. Full Auto-Fix Loop

- [ ] generic `operator_auto_fix` loop
- [ ] max iteration policy
- [ ] failure classifier
- [ ] automatic next action recommendation
- [ ] production approval gates
- [ ] auto-close incident after green health

## Фаза 6. Project Registry v2

- [ ] multiple projects
- [ ] project test/build/deploy commands
- [ ] project health URL
- [ ] project secrets policy
- [ ] project branch policy
- [ ] project runbooks
- [ ] project-specific memory

## Фаза 7. GitHub Deep Integration

- [ ] auto-create webhook UI done, improve status
- [ ] GitHub App mode / fine-grained token support
- [ ] issue-to-mission
- [ ] PR review comments
- [ ] CI rerun
- [ ] branch cleanup
- [ ] release automation

## Фаза 8. Strong Safety

- [ ] policy editor UI
- [ ] role-based approvals
- [ ] budget limits per mission
- [ ] tool risk scoring
- [ ] production write cooldowns
- [ ] audit dashboard

## Фаза 9. Agent Quality

- [ ] planner/editor/reviewer model routing
- [ ] reviewer sub-agent
- [ ] automatic diff review
- [ ] hallucination/fabrication gates for reports
- [ ] stronger context compression
- [ ] persistent project map

## Фаза 10. Product UI

- [ ] split `/admin/agent` into tabs or routes
- [ ] `/operator`
- [ ] `/operator/missions`
- [ ] `/operator/incidents`
- [ ] `/operator/deploys`
- [ ] `/operator/runbooks`
- [ ] global inbox badge
- [ ] browser push notifications

## Фаза 11. Documentation

- [ ] user guide
- [ ] operator guide
- [ ] setup guide for GitHub webhook
- [ ] setup guide for Telegram
- [ ] runbook examples
- [ ] security guide

---

# Следующий рекомендуемый блок

## Mission Timeline + Runbook Memory

Почему следующим:

1. Сейчас много подсистем уже работают, но нет единой chronological timeline.
2. Чтобы агент был как личный разработчик, он должен помнить, что сделал, почему и чему научился.
3. Timeline нужен для UI, debugging, RCA, reports, auto-fix loops.
4. Runbooks позволят агенту становиться лучше после каждой ошибки.

План блока:

- добавить `operator_mission_events`;
- добавить API events/list/add;
- писать events из operator missions/code tasks;
- добавить `OperatorMissionTimeline` в UI;
- добавить `.browserai/runbooks/*` generation/update;
- сохранять lessons from RCA/code task/deploy;
- добавить tests.
