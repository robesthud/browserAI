import {
  ok, err, truncate, shQuote, scopedContainerRoot, rewriteWorkspacePaths, runWorkspaceCommand, defaultCloneDir, addPathToZip, isCodeLikePath, ensureParentDirs,
  getWorkspaceTree, readWorkspaceFile, createFile, createFolder, writeFileContent, renameItem, deleteItem, searchWorkspaceContent, getContainerWorkspaceRoot, safePath, makeAgentWritable,
  searchWeb, fetchWebPage, runSandboxCommand, upsertFact, forgetFact, listFacts, addDocument, deleteDocument, listDocuments, searchKnowledge, fetchViaProxy, isGoogleGenerativeNativeUrl, callLLM, getActiveKeyDecrypted,
  fsWriteFile, fsReadFile, fsMkdir, fsReaddir, fsStat,
  browserOpen, browserScreenshot, browserClick, browserType, browserClose,
  computerScreenshot, computerClick, computerType, computerOpenApp, computerStatus,
  listOpsServices, runOpsAction, buildProjectProfile, buildVerificationPlan, scanSecrets,
  createWorkspaceSnapshot, listWorkspaceSnapshots, restoreWorkspaceSnapshot,
  runInSession, resetSession, startBackgroundTask, readBackgroundLogs, stopBackgroundTask, listBackgroundTasks, detectWorkspaceChangesAround, createUnifiedDiff,
  PRIVILEGED_TOOLS, AdmZip, path
} from './helpers.js'

export const verifyTools = {
  plan_set: {
    description: 'Publish or replace the visible task plan. Use for multi-step work.',
    params: {
      plan: { type: 'string', optional: true, description: 'Markdown checklist, one step per line.' },
      steps: { type: 'array', optional: true, description: 'Steps as [{idx, title, detail?}] array or JSON-string (preferred format).' },
      title: { type: 'string', optional: true, description: 'Plan title.' },
    },
    handler: async ({ plan, steps, title } = {}) => {
      let normalized = []
      // 1. Принимаем steps как JSON-массив [{idx, title, detail}]
      if (typeof steps === 'string') {
        try { steps = JSON.parse(steps) } catch { steps = null }
      }
      if (Array.isArray(steps)) {
        normalized = steps.map((p, i) => ({
          idx: Number(p?.idx ?? (i + 1)),
          text: String(p?.text || p?.title || p?.detail || ''),
          done: Boolean(p?.done),
        })).filter((s) => s.text)
      }
      // 2. Принимаем plan как markdown-чеклист (старый формат)
      if (!normalized.length && typeof plan === 'string' && plan.trim()) {
        const lines = plan.split('\n').map((l) => l.trim()).filter(Boolean)
        normalized = lines.map((line, i) => ({
          idx: i + 1,
          text: line.replace(/^[-*]\s*\[[ x]\]\s*/i, '').replace(/^[-*]\s*/, ''),
          done: false,
        }))
      }
      return ok({ title: title || 'Plan', steps: normalized })
    },
  },

  plan_check: {
    description: 'Mark one or more visible plan steps as done.',
    params: {
      steps: { type: 'array', optional: true, description: 'Step indexes to mark done.' },
      step: { type: 'number', optional: true, description: 'Single step index to mark done.' },
      indices: { type: 'array', optional: true, description: 'Alias for steps (some providers send "indices").' },
    },
    handler: async ({ steps, step, indices } = {}) => {
      let arr = []
      // Приоритет: steps > indices > step
      if (Array.isArray(steps)) arr = steps
      else if (Array.isArray(indices)) arr = indices
      else if (typeof indices === 'string') {
        try { arr = JSON.parse(indices) } catch {
          arr = indices.split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n))
        }
      }
      else if (typeof steps === 'string') {
        try { arr = JSON.parse(steps) } catch { arr = [] }
      }
      else if (step != null) arr = [step]
      return ok({ checked: arr.map(Number).filter((n) => Number.isFinite(n)) })
    },
  },

  ask_user: {
    description: 'Ask the user a focused question in the UI. Use only when blocked or before risky/destructive operations.',
    params: {
      question: { type: 'string', optional: true, description: 'Single question text.' },
      options: { type: 'array', optional: true, description: 'Options for single-question mode.' },
      questions: { type: 'array', optional: true, description: 'Array of question cards.' },
    },
    handler: async () => ok({ queued: true }),
  },

  secret_scan: {
    description: 'Scan workspace files for secrets/tokens before archiving, committing or deploying.',
    params: {
      root: { type: 'string', optional: true, description: 'Folder to scan, relative to workspace root. Empty = whole workspace.' },
    },
    handler: async ({ root = '' } = {}) => {
      try { return ok(await scanSecrets({ root })) } catch (e) { return err(e.message) }
    },
  },

  workspace_snapshot_create: {
    description: 'Create a rollback snapshot of the current workspace before risky edits.',
    params: { label: { type: 'string', optional: true, description: 'Snapshot label.' } },
    handler: async ({ label = 'manual' } = {}) => {
      try { return ok(await createWorkspaceSnapshot({ label })) } catch (e) { return err(e.message) }
    },
  },

  workspace_snapshot_list: {
    description: 'List rollback snapshots for the current workspace.',
    params: {},
    handler: async () => {
      try { return ok({ snapshots: await listWorkspaceSnapshots() }) } catch (e) { return err(e.message) }
    },
  },

  workspace_snapshot_restore: {
    description: 'Restore a previous workspace snapshot by id. Destructive: current files are replaced.',
    params: { id: { type: 'string', required: true, description: 'Snapshot id.' } },
    handler: async ({ id } = {}) => {
      try { return ok(await restoreWorkspaceSnapshot({ id })) } catch (e) { return err(e.message) }
    },
  },

  project_profile: {
    description: 'Inspect the current workspace and detect project root, stack, package manager, scripts, entrypoints and deploy files.',
    params: {
      root: { type: 'string', optional: true, description: 'Preferred project root relative to workspace.' },
    },
    handler: async ({ root = '' } = {}) => {
      try { return ok(await buildProjectProfile({ preferredRoot: root })) } catch (e) { return err(e.message) }
    },
  },

  verify_task: {
    description: 'Run an automatic verification plan based on touched files and project profile. Use after code/config changes instead of guessing which checks to run.',
    params: {
      touched_files: { type: 'array', optional: true, description: 'Touched file paths relative to workspace root.' },
      task_type: { type: 'string', optional: true, description: 'Task type, e.g. coding_change or deploy_ops.' },
      root: { type: 'string', optional: true, description: 'Preferred project root.' },
    },
    handler: async ({ touched_files = [], task_type = '', root = '' } = {}) => {
      try {
        const profile = await buildProjectProfile({ preferredRoot: root })
        const plan = buildVerificationPlan({ profile, touchedFiles: Array.isArray(touched_files) ? touched_files : [], taskType: task_type })
        const results = []
        for (const action of plan.actions) {
          if (action.kind === 'tool' && action.tool === 'verify_code') {
            const pathArg = action.args?.path
            const ext = String(pathArg || '').toLowerCase().split('.').pop()
            let cmd = ''
            if (['js', 'mjs', 'cjs'].includes(ext)) cmd = `node --check ${shQuote(safePath(pathArg))}`
            else if (ext === 'json') cmd = `node -e "JSON.parse(require('fs').readFileSync(${JSON.stringify(safePath(pathArg))}, 'utf8'))"`
            else { results.push({ action, ok: true, skipped: true, message: 'No syntax checker for extension' }); continue }
            const r = await runWorkspaceCommand(cmd, { timeoutMs: 30_000 })
            results.push({ action, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: truncate(r.stdout, 2000), stderr: truncate(r.stderr, 2000) })
          } else if (action.kind === 'tool' && action.tool === 'npm_test') {
            const r = await runWorkspaceCommand('npm test', { timeoutMs: 120_000 })
            results.push({ action, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: truncate(r.stdout, 3000), stderr: truncate(r.stderr, 2000) })
          } else if (action.kind === 'command') {
            const r = await runWorkspaceCommand(action.command, { timeoutMs: Math.max(1, Number(action.timeoutSec || 120)) * 1000 })
            results.push({ action, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: truncate(r.stdout, 3000), stderr: truncate(r.stderr, 2000) })
          } else {
            results.push({ action, ok: true, skipped: true })
          }
        }
        const passed = results.every((r) => r.ok)
        return ok({ profile, plan, results, passed })
      } catch (e) { return err(e.message) }
    },
  },

  npm_test: {
    description: 'Run the test suite (npm test). ALWAYS run this after making changes to verify nothing broke. If tests fail, read the error and fix the code before continuing.',
    params: {
      path: { type: 'string', optional: true, description: 'Optional path to test file, e.g. "tests/auth.test.js". If omitted, runs all tests.' },
      watch: { type: 'boolean', optional: true, description: 'Run in watch mode. Default: false.' },
    },
    handler: async ({ path, watch = false } = {}) => {
      try {
        let cmd = 'npm test'
        if (path) cmd += ` -- ${shQuote(String(path))}`
        // Добавляем --watch без лишнего -- (он уже есть от path или не нужен)
        if (watch) cmd += ' --watch'
        const r = await runWorkspaceCommand(cmd, { timeoutMs: 120_000 })
        return ok({
          stdout: truncate(r.stdout, 6000),
          stderr: truncate(r.stderr, 3000),
          exitCode: r.exitCode,
          passed: r.exitCode === 0,
        })
      } catch (e) { return err(e.message) }
    },
  },

  // ── NEW: git ─────────────────────────────────────────────────────────────,

};
