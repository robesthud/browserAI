# Rollback Checklist — Approach 7

When something goes wrong after a deploy, follow these steps **in order**.
Time is critical — a bad release degrades user trust fast.

## T+0 (immediate, < 1 minute)

- [ ] **Acknowledge the alert** in the operator channel (Telegram if
      configured).
- [ ] **Capture the broken commit hash**: `git -C /opt/browserai log -1
      --oneline` from the server.
- [ ] **Capture the previous known-good hash** from
      `GET /api/operator/release-safety` → `rollbackTargets[0]`.

## T+1 (initial triage, 1–5 minutes)

- [ ] Run `GET /api/operator/release-safety` to confirm the broken state.
- [ ] Identify the failure category from the `checks` block:
  - `disk` → free up `/data/` (prune runs/replays) before any other action
  - `secrets` → DO NOT rollback, fix env vars first
  - `dataDir` → check disk + permissions
  - `gitClean` → expected after rollback, do not investigate
  - `appHealthy` → the actual problem
- [ ] If `appHealthy.ok === false`, check `docker logs browserai --tail=200`
  for the specific error.
- [ ] If the failure is a `reason: 'crash'` in a recent run, the
    `runLog.error.fingerprint` points to the exact classified cause
    (`auth` / `provider` / `tool_schema` / etc.) via `/api/operator/runs/:runId`.

## T+5 (rollback decision, 5–10 minutes)

Decision matrix:

| Failure type | Action |
|---|---|
| Single agent crash, no user impact | Hotfix forward, no rollback |
| All agents failing consistently | Rollback NOW |
| Health endpoint failing | Rollback NOW |
| Security regression | Rollback NOW + audit |
| Cosmetic UI bug | Fix forward, defer |
| Provider-specific (e.g. Gemini quota) | Switch provider, defer rollback |

## T+10 (execute rollback, 10–15 minutes)

If rolling back:

```bash
# From /opt/browserai on the server:
PREVIOUS=$(git log --pretty=format:"%H" -n 2 | tail -1)
echo "Rolling back from $(git log -1 --pretty=format:%H) to $PREVIOUS"

# 1. Pin to the known-good commit
git fetch origin main
git reset --hard "$PREVIOUS"

# 2. Redeploy (rebuilds image, recreates containers)
bash deploy.sh

# 3. Wait for health
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    echo "Health OK after ${i}x2s"
    break
  fi
  sleep 2
done
```

Or, from the operator UI, use the `GET /api/operator/release-safety`
`rollbackTargets[N].commit` value and feed it to
`rollbackCommandFor(commitHash)` from `server/releaseSafety.js` to get
the exact command block.

## T+15 (post-rollback verification)

- [ ] `/api/health` returns 200
- [ ] `/api/agent/health` returns 200 + DeepSeek managed OK
- [ ] Run a single test agent run, verify `done` event with
      `finalStatus.taskCompleted=true`
- [ ] Check that the rolled-back commit is now HEAD on origin/main AND on
      the server: `git -C /opt/browserai log -1 --oneline` matches
      `origin/main`
- [ ] Owner login: `/api/operator/release-safety` reports `ready=true`
- [ ] If users were impacted, send a brief status update

## T+30 (post-mortem)

- [ ] File a post-mortem in `docs/observability/postmortems/YYYY-MM-DD.md`
      with: trigger, timeline, root cause, rollback reason, prevention
      for next time
- [ ] If the rolled-back commit caused the failure, decide whether to
      revert that commit or hotfix forward
- [ ] Update the regression matrix if a missing case is identified
