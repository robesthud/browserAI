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

---

## 21. Notification Center + Routing

Добавлено:

- `server/notifications.js`
- notifications table
- Notification Center UI
- Sidebar unread badge
- Browser Push routing through existing `push.js`
- Telegram routing by severity
- automatic notifications for incidents, workflows and deploy sessions

API:

- `GET /api/notifications`
- `GET /api/notifications/summary`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/read-all`

---

## 22. Failure Classifier + Auto-Fix Policy

Добавлено:

- `server/failureClassifier.js`
- `server/autonomousFailureRouter.js`
- `FailureAdvisorPanel`
- failure classification categories:
  - `secret_leak`
  - `auth_failure`
  - `disk_failure`
  - `git_lock_failure`
  - `dependency_failure`
  - `test_failure`
  - `build_failure`
  - `ci_failure`
  - `docker_failure`
  - `health_failure`
  - `deploy_failure`
  - `timeout_failure`
  - `unknown_failure`
- auto-fix recommendations and policies
- automatic failure routing for jobs/workflows/deploy sessions

API:

- `POST /api/operator/failure/classify`
- `POST /api/operator/failure/incident`
- `POST /api/operator/failure/execute`

Tools:

- `operator_classify_failure`
- `operator_execute_auto_fix`

---

## Quality rule update

From this point every new package should include:

1. backend implementation;
2. UI if user-facing;
3. Agent tools if useful to the internal agent;
4. tests;
5. docs/runbook updates;
6. deploy + health/log verification.

---

## 23. Autonomous Recovery Supervision

Добавлено:

- recovery chain graph;
- parent recovery id;
- chain depth;
- max chain depth guard;
- recovery supervisor interval;
- recovery outcome evaluation;
- spawned mission/deploy/workflow monitoring;
- auto-resolve incident when linked recovery succeeds;
- UI graph summary and manual `supervise now` button.

API:

- `GET /api/operator/recoveries`
- `GET /api/operator/recoveries/graph`
- `POST /api/operator/recoveries/supervise`

Env:

- `AUTONOMOUS_RECOVERY_ENABLED`
- `AUTONOMOUS_RECOVERY_MAX_PER_HOUR`
- `AUTONOMOUS_RECOVERY_MAX_CHAIN_DEPTH`
- `AUTONOMOUS_RECOVERY_SUPERVISOR_MS`

Purpose:

Prevent uncontrolled recovery loops while letting safe recoveries complete and update incidents/reports automatically.

---

# Grouped execution strategy from this point

Правило разработки дальше: связанные блоки выполняются пакетами, чтобы каждый пакет давал законченный production-ready контур.

## Package quality checklist

Каждый пакет должен включать, когда применимо:

1. Architecture/design note.
2. Backend implementation.
3. API endpoints.
4. Agent tools.
5. UI components.
6. Tests.
7. Documentation/runbook update.
8. `npm test`.
9. `npm run build`.
10. Commit + push.
11. Deploy.
12. Production `/api/health` check.
13. Docker logs check.
14. Short user-facing report.

## Package grouping rule

Allowed:

- 2–4 blocks if they are one domain and produce one end-to-end capability.
- Backend + UI + tests + docs in one package.
- Runtime + observability + report in one package.

Avoid:

- unrelated rewrites in one package;
- multiple core runtime rewrites together;
- production-risk changes without isolated deploy verification;
- UI redesign mixed with auth/deploy core changes.

---

# Remaining roadmap grouped into execution packages

## Package A — Super Operator Workflow v1

Goal: one end-to-end mission that can take a development task from user goal to verified PR and optional deploy.

Blocks:

1. `operator_super_missions` / orchestration layer.
2. `operator_full_dev_cycle` mission type.
3. End-to-end state machine:
   - classify goal;
   - create code task;
   - wait code task verification;
   - review/risk gate;
   - finalize commit/PR;
   - wait CI;
   - auto-fix CI if needed;
   - request/require approval for merge/deploy;
   - merge PR;
   - deploy session;
   - post-deploy health/log verification;
   - unified report.
4. UI controls in Operator Console.
5. Tests for orchestration path with mocked/structural states.
6. Documentation.

Result:

User can ask: “Сделай фичу X и доведи до продакшена”, and BrowserAI has one mission that coordinates the full lifecycle.

---

## Package B — Mission Detail Pages + Timeline UX

Goal: make missions inspectable like a professional operator console.

Blocks:

1. Dedicated mission detail route/panel.
2. Mission timeline with grouped events:
   - workflow;
   - code task;
   - CI;
   - deploy;
   - notifications;
   - incidents.
3. Code task detail section:
   - branch;
   - PR;
   - verification;
   - review;
   - CI;
   - auto-fix attempts.
4. Deploy detail section:
   - deploy session events;
   - logs;
   - health checks;
   - report.
5. Incident/RCA detail section.
6. Copy/save/send report actions.
7. Tests for report/timeline data renderability.

Result:

Every autonomous task has a clear audit trail and UI surface.

---

## Package C — GitHub Issue/PR Comment Automation

Goal: make BrowserAI react to GitHub like a real developer assistant.

Status: implemented in this package.

Blocks:

1. Webhook support for:
   - `issues.opened` / `issues.edited` with BrowserAI command in body;
   - `issue_comment.created` / `issue_comment.edited`;
   - `pull_request_review_comment.created`;
   - `pull_request.opened` / `pull_request.edited` / `pull_request.synchronize` with command in body.
2. Command parser for comments:
   - `/browserai run <task>`;
   - `/browserai review`;
   - `/browserai fix-ci`;
   - `/browserai status`;
   - `/browserai help`;
   - aliases: `/agent ...`, `@browserai ...`.
3. Issue/PR → Operator mission mapping:
   - `run` → `universal_dev_task`;
   - `review` → `code_task`;
   - `fix-ci` → `fix_tests`.
4. GitHub comment reporting:
   - mission-start acknowledgement;
   - status response;
   - help response;
   - manual comment API/tool.
5. Durable automation event log:
   - `github_automation_events` table;
   - API list endpoint;
   - UI panel in Automation tab.
6. API endpoints:
   - `GET /api/operator/github-automation/events`;
   - `POST /api/operator/github-automation/comment`.
7. Agent tools:
   - `operator_list_github_automation_events`;
   - `operator_comment_github_issue`.
8. Tests for command parsing and event action planning.

Runbook notes:

- Configure a GitHub webhook to `/api/webhooks/github` with events: Issues, Issue comments, Pull requests, Pull request review comments, Workflow runs, Push.
- Use `/browserai help` in any issue/PR to see available commands.
- Use `/browserai run <task>` when you want BrowserAI to create an Operator mission from a GitHub discussion.
- Use `/browserai review` on PRs to launch a code-review/check mission.
- If `GITHUB_TOKEN` is missing, automation still records events and can create local missions, but GitHub comments are marked as skipped.

Result:

GitHub becomes a control surface for the personal operator agent: issues and PR comments can start missions, request review/status, and receive automated responses.

---

## Package D — Reviewer Agent v2 + Semantic Diff Review

Goal: improve code quality and safety before merge/deploy.

Status: implemented in this package.

Blocks:

1. LLM reviewer agent for diffs.
2. Deterministic + LLM combined risk score.
3. Review dimensions:
   - correctness;
   - security;
   - test coverage;
   - architecture;
   - UX/accessibility;
   - deploy risk.
4. Review summary stored in code task as `result.review.semantic` with schema `browserai.operator_code_review.v2`.
5. Merge gate blocks deterministic critical risk, failed verification/CI/secrets, semantic blockers, and semantic high/critical risk.
6. Deploy gate requires verification + green CI + non-high combined risk.
7. UI review panel in Mission Detail and semantic-risk badge in Operator Console.
8. Tests for semantic JSON parser, prompt contract, and combined risk gates.

Implementation notes:

- `server/operatorCode.js` now calls the active LLM provider for semantic diff review when a provider/key is configured.
- If the semantic reviewer is unavailable, deterministic gates remain active and the review records a warning instead of crashing the operator flow.
- Semantic review is evidence-based and prompted to return strict JSON only; parser tolerates fenced JSON and rejects malformed output safely.

Result:

The agent reviews its own work before merge with deterministic + semantic checks and stores reviewer evidence in the code task.

---

## Package E — Project Policies v2

Goal: support many projects safely, not only BrowserAI.

Status: implemented in this package.

Blocks:

1. Per-project policy config stored in project `meta.policy`:
   - allowed code/PR/CI auto-fix/merge/deploy/production-write actions;
   - autonomy defaults for finalize, wait CI, auto-fix, auto-merge, auto-deploy;
   - required approvals for merge/deploy/production/high-risk work;
   - max runtime, CI auto-fix attempts, changed-file limit;
   - protected paths and high-risk paths;
   - CI/review risk requirements.
2. Policy presets:
   - Safe;
   - Balanced;
   - Autonomous;
   - Production Critical.
3. Backend policy engine:
   - `server/operatorProjectPolicies.js`;
   - normalization;
   - allow/deny decisions;
   - protected path checks;
   - super-workflow option shaping.
4. API endpoints:
   - `GET /api/operator/project-policy-presets`;
   - `POST /api/operator/project-policy/evaluate`;
   - project upsert normalizes policy.
5. Agent tool:
   - `operator_evaluate_project_policy`.
6. Policy integration in:
   - operator mission routing;
   - code task start;
   - code task review gates;
   - finalize/PR;
   - wait CI;
   - CI auto-fix;
   - merge/deploy;
   - super workflow options.
7. UI in Operator Projects:
   - preset selector;
   - action permission toggles;
   - CI auto-fix attempts;
   - changed-file limit.
8. Tests:
   - preset normalization;
   - allow/deny behavior;
   - approval requirements;
   - protected path blocking;
   - super-workflow policy shaping.

Runbook notes:

- Use **Safe** for newly onboarded or unknown repositories.
- Use **Balanced** for BrowserAI/default projects: code + PR + CI + auto-fix are allowed, merge/deploy require explicit confirmation and green gates.
- Use **Autonomous** only for trusted non-critical projects where low-risk auto-merge is acceptable.
- Use **Production Critical** for services where high-risk changes and production writes must always remain approval-gated.
- Protected path matches block review/merge gates before PR/deploy; high-risk path matches are surfaced as warnings.

Result:

Each project can now have a different safety posture, and Operator Mode respects it across missions, code tasks, PR/CI, merge and deploy.

---

## Package F — Long-running Shell / Command Sessions

Goal: provide robust command execution like an operator terminal, with attach/detach.

Blocks:

1. Persistent command sessions table.
2. Start/read/wait/kill session API.
3. Live stdout/stderr storage.
4. Tool wrappers:
   - `operator_shell_start`;
   - `operator_shell_read`;
   - `operator_shell_wait`;
   - `operator_shell_kill`.
5. UI terminal/log panel.
6. Integration with code/deploy sessions.
7. Tests with short commands.

Result:

Agent can run and monitor long commands like builds, tests, migrations, deploys.

---

## Package G — Multi-project Workspace Manager

Goal: make onboarding and worktree management robust across arbitrary repositories.

Blocks:

1. Project worktree table.
2. Branch/worktree lifecycle:
   - create;
   - reuse;
   - cleanup;
   - lock;
   - status.
3. Repo credentials strategy:
   - public clone;
   - token clone;
   - SSH clone later.
4. Monorepo package detection.
5. Project-specific runbooks and lessons namespacing.
6. UI project/worktree management.
7. Tests for path/branch generation.

Result:

Agent can work across multiple repositories safely.

---

## Package H — Security Hardening Package

Goal: prepare for production-level personal agent use.

Blocks:

1. Rotate exposed credentials checklist.
2. Token/secret upload scanner.
3. Redaction audit across logs/reports/traces.
4. SSH key workflow instead of root password.
5. Vault-only credentials for GitHub/Timeweb.
6. Approval policy UI for dangerous operations.
7. Audit dashboard.
8. Tests for redaction and secret scanning.

Result:

The agent becomes safer to operate with real production access.

---

## Package I — Model Routing / Multi-agent Roles

Goal: improve quality and cost by using different model roles.

Blocks:

1. Planner model.
2. Coder model.
3. Reviewer model.
4. Summarizer/report model.
5. Project-specific preferred models.
6. Fallback model on provider failure.
7. Cost tracking per mission phase.
8. UI for model routing.

Result:

Operator Mode becomes more reliable and cheaper for long tasks.

---

## Package J — Full Product Navigation

Goal: move from `/admin/agent` lab to polished product sections.

Blocks:

1. `/operator` overview.
2. `/operator/missions`.
3. `/operator/projects`.
4. `/operator/incidents`.
5. `/operator/deploys`.
6. `/operator/runbooks`.
7. `/operator/settings`.
8. Sidebar/global navigation.
9. Mobile responsive layouts.

Result:

BrowserAI becomes a real Operator Console product instead of a single admin lab page.

---

## Package Runtime-5 — Failure Playbooks + Tool Strategy + Safety Rails

Goal: make Agent Mode recover from common failures more like a senior developer and avoid dangerous shell actions without approval.

Status: implemented in this package.

Blocks:

1. Added `server/failurePlaybooks.js`:
   - classifies tool/command failures;
   - builds recovery playbooks;
   - provides a tool strategy directive for non-trivial tasks.
2. Failure categories include:
   - missing module/import;
   - syntax/type error;
   - test failure;
   - build failure;
   - lint failure;
   - git failure;
   - credentials/permissions;
   - deploy/runtime failure;
   - timeout/long command;
   - path not found.
3. Recovery engine now returns structured playbook instructions for bash/npm/shell failures, timeout, and classified recoverable errors.
4. Agent loop injects `[tool_strategy]` guidance:
   - project_profile/read_project_rules/list_files/search_files before broad edits;
   - shell_session_run for stateful terminal work;
   - focused checks then broader verification;
   - git status/diff + secret_scan before commit/push/deploy;
   - health/logs after ops.
5. Approval safety rails now categorize persistent/background shell tools as bash and force approval for dangerous shell commands even if bash policy is relaxed.
6. Tests cover failure classification, recovery playbooks, tool strategy and dangerous command approval.

Runbook notes:

- On failed tests/builds, the model should inspect stderr/stdout, locate referenced files/symbols, fix, and rerun verification.
- Long commands should be moved to shell background sessions when they timeout/block.
- Dangerous shell commands such as git push, deploy, docker compose up, rm -rf and system restarts require approval.

Result:

BrowserAI now has a stronger recovery and safety layer: failures produce actionable next steps, and risky shell operations are gated.

---

## Package UX-2 — Minimal Agent Chat Output

Goal: keep the main chat as minimal and readable as Arena-style Agent Mode while preserving access to all technical evidence.

Status: implemented in this package.

Blocks:

1. Normal users no longer see every narration/tool card expanded directly in the chat.
2. Agent activity is collapsed into a compact `Ход работы агента` fold with status/count/last action summary.
3. Tool details, command output and plan remain available inside the fold when needed.
4. Runtime evidence appended by the backend is split out of the assistant answer and placed into a collapsed `Технический отчёт и evidence` section.
5. Devtools mode keeps the old fully expanded technical view for debugging.

Runbook notes:

- Main UX rule: concise assistant answer first; technical trace/evidence is available on demand.
- Use `localStorage.browserai.devtools = '1'` for expanded diagnostics.

Result:

BrowserAI keeps the functional agent trace, but the chat again feels lightweight: task, short progress summary, final answer, optional evidence.

---

## Package Runtime-4 — Guided Git/PR/Deploy Rails + Runtime Report Builder

Goal: make full-cycle tasks deterministic enough that “сделай, проверь, запушь, задеплой” follows reliable rails and ends with runtime evidence instead of a purely model-written memory report.

Status: implemented in this package.

Blocks:

1. Added `buildGuidedRailsDirective()` with full-cycle staged guidance:
   - inspect;
   - change;
   - verify;
   - git/secret scan/commit/push/PR;
   - deploy;
   - health;
   - logs;
   - final report.
2. Agent loop injects guided rails whenever obligations are detected.
3. Runtime final-answer layer now appends a structured evidence report from actual tool history:
   - changed/read files;
   - commands;
   - checks;
   - git evidence;
   - deploy/ops/health/log evidence;
   - errors/recovery;
   - obligation status.
4. Commit gate now accepts real verification evidence from `verify_task`, `verify_code`, `npm_test`, `run_tests`, or bash/shell test/build commands instead of only `verify_code`.
5. Obligation report status is stored in `agentState.obligationStatus` before final output.
6. Tests cover guided rails generation.

Runbook notes:

- For full-cycle tasks, the model is still free to choose tools, but runtime now provides a reliable ordered checklist and appends objective evidence.
- Final reports should not rely only on model memory; the runtime evidence block is built from successful/failed tool history.
- Commit/push/deploy should happen only after verification/secret checks and approval/policy gates where applicable.

Result:

BrowserAI now has stronger rails for the core user story: one natural-language task can lead through implementation, verification, git/deploy steps, health/log checks, and an evidence-backed final report.

---

## Package Runtime-3 — Persistent Shell Sessions + Command Autopilot

Goal: give Agent Mode a real terminal-like execution layer for long and stateful work, instead of only one-shot bash commands.

Status: implemented in this package.

Blocks:

1. Existing `server/shellSession.js` persistent shell engine is now connected to Agent Mode tools.
2. New agent tools:
   - `shell_session_run` — persistent per-chat bash session; cwd/env/export/cd persist across calls;
   - `shell_session_reset` — reset a stuck/polluted shell session;
   - `shell_background_start` — start long-running commands without blocking the agent;
   - `shell_background_read` — poll stdout/stderr/status;
   - `shell_background_stop` — stop a background command;
   - `shell_background_list` — list running/recent background tasks.
3. Shell tools are allowed in general/code/ops tool profiles.
4. Agent runtime directive now tells the model to prefer:
   - `shell_session_run` for multi-step commands needing cwd/env persistence;
   - `shell_background_start/read/stop` for dev servers, watchers, tail logs and long builds.
5. Main UI tool cards understand shell-session/background tools and expose stdout/stderr like bash.
6. API endpoints for Dev Lab/UI:
   - `GET /api/agent/shell/background`;
   - `GET /api/agent/shell/background/:id`;
   - `POST /api/agent/shell/background/:id/stop`;
   - `POST /api/agent/shell/sessions/:chatId/reset`.
7. Tests cover tool registry exposure, prompt catalog, allowlist profiles and runtime guidance.

Runbook notes:

- Use `bash` for short stateless commands.
- Use `shell_session_run` when the next command depends on `cd`, exported env, activated virtualenv, installed context, or terminal state.
- Use `shell_background_start` for long commands that should not block the LLM loop; inspect them with `shell_background_read` and stop them with `shell_background_stop`.
- Long-running shell is still subject to policy/approval gates for risky production actions.

Result:

Agent Mode now has a proper persistent command layer: it can run stateful terminal work, keep long commands alive, poll logs, and continue working more like a real developer/operator.

---

## Package Runtime-2 — Mission Autopilot / One-Task Full Cycle

Goal: make BrowserAI keep track of what the user actually asked for — verify, commit, push, PR, deploy, health/log checks — and prevent early final answers when those obligations are still unsatisfied.

Status: implemented in this package.

Blocks:

1. Goal obligation detector in `agentCore`:
   - inspect;
   - codeChange;
   - verify;
   - commit;
   - push;
   - PR;
   - deploy;
   - healthCheck;
   - logsCheck;
   - finalReport.
2. Agent context/state now carries inferred `task.obligations`, `state.obligations`, and live `state.obligationStatus`.
3. Autonomous runtime directive now lists active obligations and tells the agent to complete them or report evidence-backed blockers.
4. Final-answer gate in `agentLoop` checks obligations before allowing completion:
   - requested push must show git push / pushed result;
   - requested deploy must show deploy action;
   - deploy requires health/log checks;
   - requested commit/PR/verify must be satisfied or explicitly blocked.
5. Obligation enforcement emits visible narration and pushes the model back into tool execution instead of silently finishing too early.
6. Git/ops/bash summaries enriched so obligation checks can identify push/deploy/health/log evidence.
7. Tests cover full-cycle obligation inference and directive behavior.

Runbook notes:

- If the user says “сделай, запушь и задеплой”, the runtime now treats push/deploy/health/log checks as obligations, not optional niceties.
- If credentials/approval/policy prevent an obligation, the final report must say so explicitly with tool evidence.
- This does not remove approval gates: risky production actions still need policy/approval where configured.

Result:

Agent Mode is less likely to stop after partial work: it keeps a checklist of the user’s requested full-cycle outcomes and pushes itself to finish or report a real blocker.

---

## Package Runtime-Agent — Automated Bash Execution Loop

Goal: make the main Agent Mode behave closer to Arena-style work: the user gives a task, the agent explains each step, calls bash/files/git/deploy tools itself, verifies, recovers from errors, and reports evidence.

Status: implemented in this package.

Blocks:

1. Added `buildAutonomousRuntimeDirective()` to the agent runtime core.
2. Real-work tasks now receive an explicit autonomous mode directive:
   - user only provides the task;
   - agent chooses tools;
   - safe bash is expected for inspection and verification;
   - agent must not ask the user to run commands manually;
   - errors should trigger diagnostic/fix attempts instead of immediate surrender;
   - final answer must include evidence.
3. Agent loop now emits generated narration before every tool call, e.g.:
   - project inspection;
   - file read/edit;
   - bash test/build/git/docker/curl checks;
   - verification;
   - secret scan;
   - ops actions.
4. UI narration cards were changed from hidden “thoughts” into visible “agent step” explanations.
5. Bash/verification tool cards now expose command output to normal users when opened, while still keeping advanced internals behind devtools.
6. Tests cover the new autonomous runtime directive.

Runbook notes:

- Product behavior rule: never ask the user to run safe commands; call bash/tools directly.
- After code/config edits, verify via bash/verify tools before final success.
- After deploy/ops actions, verify health/logs before final success.
- Tool narration should remain short, factual and user-facing — not hidden chain-of-thought.

Result:

Agent Mode now better matches the desired behavior: one task from the user, visible step-by-step explanations, automatic bash/tool execution, verification and evidence-based reporting.

---

## Package UX-Restore — Chat + Workspace Agent Mode

Goal: return the main BrowserAI experience to a clean Arena-like agent surface: the user gives one task, while bash/files/git/deploy/operator machinery stays under the hood or in Dev Lab.

Status: implemented in this package.

Blocks:

1. Main UI restored to chat + workspace as the primary product surface.
2. Agent Mode is now the default behavior for regular users; the old manual agent toggle is a devtools-only override.
3. Sidebar decluttered:
   - regular users see New Chat, chat history and Settings;
   - Agent Lab, job trays, notification/debug trays, push toggle, Web AI toggle and UI debug prefs are hidden behind `localStorage.browserai.devtools = '1'`.
4. Manual/background execution controls moved out of the normal composer and kept for devtools only.
5. Empty-state copy now explains the intended workflow: describe a task, the agent reads files, calls bash, edits, verifies and explains progress.
6. Workspace remains the main right-side work area for files/preview/artifacts.
7. `/admin/agent` remains available as Dev Lab for operator panels, policies, deploys, GitHub automation, recovery and diagnostics.

Runbook notes:

- Main product path is the normal BrowserAI chat.
- Dev Lab path is `/admin/agent`; enable visible debug entry points with `localStorage.browserai.devtools = '1'`.
- Product rule going forward: do not add manual operator panels to the main chat surface; put advanced controls in Dev Lab and expose only task-centric agent behavior in chat.

Result:

The main interface is again a pleasant task-first Agent Mode: chat + workspace, not a crowded operator/admin console.

---

# Recommended execution order

0. Package UX-Restore — Chat + Workspace Agent Mode. **Done**
0.1. Package Runtime-Agent — Automated Bash Execution Loop. **Done**
0.2. Package Runtime-2 — Mission Autopilot / One-Task Full Cycle. **Done**
0.3. Package Runtime-3 — Persistent Shell Sessions + Command Autopilot. **Done**
0.4. Package Runtime-4 — Guided Git/PR/Deploy Rails + Runtime Report Builder. **Done**
0.5. Package UX-2 — Minimal Agent Chat Output. **Done**
0.6. Package Runtime-5 — Failure Playbooks + Tool Strategy + Safety Rails. **Done**
1. Package A — Super Operator Workflow v1.
2. Package B — Mission Detail Pages + Timeline UX.
3. Package D — Reviewer Agent v2 + Semantic Diff Review.
4. Package E — Project Policies v2.
5. Package C — GitHub Issue/PR Comment Automation.
6. Package F — Long-running Shell / Command Sessions.
7. Package G — Multi-project Workspace Manager.
8. Package H — Security Hardening Package.
9. Package I — Model Routing / Multi-agent Roles.
10. Package J — Full Product Navigation.

This order prioritizes end-to-end operator capability first, then UX, safety, integrations, and scalability.
