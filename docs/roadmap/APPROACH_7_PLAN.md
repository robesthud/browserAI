# План: реализация Подхода 7 — Trust UX + Prod Readiness

Дата: 2026-06-20
Контекст: HEAD = `8eb9c19` (Подход 6 завершён, оценка ~8.9/10)
Цель: 8.9 → 9.0 / 10

---

## A. Trust-oriented UI (7.1)

Server уже отдаёт `finalStatus` в `done` event (schema browserai.final_status.v1). UI должен рендерить это структурно, а не сырым текстом.

**A.1 Новый компонент `src/components/AgentEvidenceBlock.jsx`:**
- Секции: changed files / commands run / tests / blockers / obligations
- Цветовое кодирование: success (зелёный), partial (жёлтый), blocked (красный)
- Сворачиваемый (по умолчанию раскрыт, если есть blockers)
- Не перегружает minimalist UI — показывает только когда `done.finalStatus` присутствует

**A.2 Wire-up в `src/lib/useChats.js`:**
- При получении `done` event сохранить `finalStatus` в message
- При рендере assistant message проверять `message.finalStatus` и вставлять `<AgentEvidenceBlock>` после текста

---

## B. Stream resilience UX (7.2)

**B.1 Server endpoint `GET /api/chats/:chatId/last-run`:**
- Возвращает `{ runId, reason, taskCompleted, verified, blockers, startedAt, finishedAt, durationMs }` — последний завершённый или прерванный run для chat
- Ищет в `${DATA_DIR}/runs/` по `task.chatId === chatId`
- 404 если run не найден

**B.2 Server endpoint `POST /api/chats/:chatId/resume`:**
- Принимает `{ runId }` — возвращает replay artifact для возобновления UI state
- Это нужно для кнопки "Continue from where it stopped"

**B.3 Frontend:**
- При получении stream без `done` в течение N секунд (timeout) — показать "interrupted / partial / blocked" card
- Кнопка "Resume last run" — POST на resume endpoint, восстанавливает evidence block + история
- Обновлённый `useChats.js` обработчик stream-cut

---

## C. Release discipline (7.3)

**C.1 Documentation:**
- `docs/release/release-checklist.md` — pre-deploy checks, post-deploy verification, rollback triggers
- `docs/release/rollback-checklist.md` — step-by-step rollback procedure, communication channels
- `docs/release/backup-policy.md` — backup schedule, retention, restore procedure

**C.2 Server helper `server/releaseSafety.js`:**
- `computeReleaseSafety()` — disk usage, secrets presence, last health, last deploy status
- `getRollbackTargets()` — list of last N deploys with rollback commands

**C.3 Operator endpoint `GET /api/operator/release-safety`:**
- `{ diskUsedPct, secretsPresent, lastHealth, lastDeployAt, lastDeployStatus }`
- Включить `rollbackTargets: [{commit, ts, status}]`

---

## D. Provider support policy (7.4)

**D.1 Server `server/providerSupport.js`:**
- Canonical provider matrix: { providerId, tier, knownLimitations[], testedAt, sampleRunId }
- Tier: `certified | experimental | unsupported | legacy`
- Certified providers: managed_deepseek, gemini_official (production-tested)
- Experimental: openrouter, anthropic, groq, zhipu
- Unsupported: anything not in matrix

**D.2 Operator endpoint `GET /api/operator/provider-support`:**
- Returns full matrix with tiers, last verified date, known limitations
- Used by UI to surface "experimental" badge for non-certified providers

**D.3 Frontend:**
- В `AgentSettingsSection.jsx` показать tier badge рядом с каждым provider
- Предупреждение при выборе `experimental` provider

---

## E. Tests

- `server/providerSupport.test.js` — tier lookup, limitations, matrix integrity
- `server/releaseSafety.test.js` — disk check, secrets check, deploy age, rollback list
- `src/components/AgentEvidenceBlock.test.jsx` (если есть vitest для UI)
- update `agentLoop.test.js` для resume path

---

## F. Roadmap + commit + deploy

Структура коммитов:
1. `feat(ui): agent evidence block + finalStatus rendering`
2. `feat(server): last-run + resume endpoints for stream resilience`
3. `docs(release): release + rollback + backup checklists`
4. `feat(server): provider support matrix with certified/experimental tiers`
5. `feat(tests): approach 7 regression suite`
6. `docs(roadmap): mark approach 7 complete and target 9.0`
