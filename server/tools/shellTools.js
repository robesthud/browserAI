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

export const shellTools = {
  bash: {
    description: "Run ANY shell command DIRECTLY on the host with full process privileges (Privileged Agent Runtime Platform). Alias to host_bash. Use for git, ssh, docker, rm, build, deploy, etc.",
    params: {
      command: { type: "string", required: true },
      cwd: { type: "string", optional: true },
      timeout_sec: { type: "number", optional: true, default: 120 },
    },
    handler: async ({ command, cwd, timeout_sec = 120 }) => {
      try {
        const { value: r, changes } = await detectWorkspaceChangesAround(() => 
          PRIVILEGED_TOOLS.host_bash.handler({ command, cwd, timeout_sec })
        )
        if (r.ok) {
          const outcome = `codeChanged=${changes.codeChanged ? 'true' : 'false'}`
          return ok({
            ...r.result,
            changedFiles: changes.all,
            outcome,
          })
        }
        return r
      } catch (e) {
        return err(e.message)
      }
    },
  },

  host_bash: {
    description: "Run ANY shell command DIRECTLY on the host with full process privileges (Privileged Agent Runtime Platform). No sandbox. Use for git, ssh, docker, file operations, etc.",
    params: {
      command: { type: "string", required: true },
      cwd: { type: "string", optional: true },
      timeout_sec: { type: "number", optional: true, default: 120 },
    },
    handler: async ({ command, cwd, timeout_sec = 120 }) => {
      try {
        const { value: r, changes } = await detectWorkspaceChangesAround(() => 
          PRIVILEGED_TOOLS.host_bash.handler({ command, cwd, timeout_sec })
        )
        if (r.ok) {
          const outcome = `codeChanged=${changes.codeChanged ? 'true' : 'false'}`
          return ok({
            ...r.result,
            changedFiles: changes.all,
            outcome,
          })
        }
        return r
      } catch (e) {
        return err(e.message)
      }
    },
  },

  shell_session_reset: {
    description: 'Reset/kill the persistent shell session for this chat. Use if the shell is stuck or polluted by bad cwd/env.',
    params: {},
    handler: async ({ _chatId = '' } = {}) => {
      if (!_chatId) return err('chat session id is required')
      return ok({ reset: resetSession(_chatId), sessionId: _chatId })
    },
  },

  shell_background_start: {
    description: 'Start a long-running command in the background and return immediately. Use for dev servers, watchers, tail -F logs, long builds, or commands you need to poll later.',
    params: {
      command: { type: 'string', required: true, description: 'Command to start in background.' },
      name: { type: 'string', optional: true, description: 'Short task name.' },
      cwd: { type: 'string', optional: true, description: 'Container cwd. Default /workspace.' },
    },
    handler: async ({ command, name = '', cwd = '/workspace', _chatId = '' } = {}) => {
      if (!command) return err('command is required')
      try { return ok(startBackgroundTask({ chatId: _chatId, command: rewriteWorkspacePaths(String(command)), name, cwd: rewriteWorkspacePaths(String(cwd || '/workspace')) })) } catch (e) { return err(e.message) }
    },
  },

  shell_background_read: {
    description: 'Read stdout/stderr and status from a background shell task.',
    params: {
      task_id: { type: 'string', required: true, description: 'Background task id from shell_background_start.' },
      tail: { type: 'number', optional: true, description: 'Max chars per stream, default 4000.' },
    },
    handler: async ({ task_id, tail = 4000 } = {}) => {
      const logs = readBackgroundLogs(task_id, { tail: Math.max(500, Math.min(32000, Number(tail) || 4000)) })
      return logs ? ok(logs) : err('background task not found')
    },
  },

  shell_background_stop: {
    description: 'Stop a background shell task by id.',
    params: { task_id: { type: 'string', required: true, description: 'Background task id.' } },
    handler: async ({ task_id } = {}) => ok({ stopped: stopBackgroundTask(task_id), taskId: task_id }),
  },

  shell_background_list: {
    description: 'List recent/running background shell tasks for this chat.',
    params: { all: { type: 'boolean', optional: true, description: 'If true, list tasks for all chats.' } },
    handler: async ({ all = false, _chatId = '' } = {}) => ok({ tasks: listBackgroundTasks(all ? null : (_chatId || null)) }),
  },

  // ── NEW: npm ─────────────────────────────────────────────────────────────,

  npm_install: {
    description: 'Install an npm package into the project. Use this when you need a new dependency. After installing, call verify_code on the file that imports it.',
    params: {
      package: { type: 'string', required: true, description: 'Package name, e.g. "node-telegram-bot-api" or "node-telegram-bot-api@0.66.0"' },
      dev: { type: 'boolean', optional: true, description: 'Install as devDependency. Default: false.' },
    },
    handler: async ({ package: pkg, dev = false } = {}) => {
      if (!pkg) return err('package is required')
      try {
        const flag = dev ? '--save-dev' : '--save'
        const r = await runWorkspaceCommand(`npm install ${flag} ${shQuote(String(pkg))}`, { timeoutMs: 120_000 })
        return ok({
          stdout: truncate(r.stdout, 6000),
          stderr: truncate(r.stderr, 3000),
          exitCode: r.exitCode,
          installed: pkg,
        })
      } catch (e) { return err(e.message) }
    },
  },

};
