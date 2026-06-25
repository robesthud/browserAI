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

export const gitTools = {
  git_status: {
    description: 'Check git status to see what files changed. Useful before committing.',
    params: {},
    handler: async () => {
      try {
        const r = await runWorkspaceCommand('git status --short', { timeoutMs: 30_000 })
        return ok({ status: truncate(r.stdout, 2000), exitCode: r.exitCode })
      } catch (e) { return err(e.message) }
    },
  },

  git_clone: {
    description: 'Clone a Git repository into the current chat workspace. If the destination already exists and is a git repo, fetch/pull instead of failing.',
    params: {
      url: { type: 'string', required: true, description: 'Repository URL, e.g. https://github.com/owner/repo.git' },
      dest: { type: 'string', optional: true, description: 'Destination folder name. Default: repo name from URL.' },
    },
    handler: async ({ url, dest } = {}) => {
      if (!url) return err('url is required')
      // Убираем .., ./ и ведущие слэши — защита от path traversal
      const target = String(dest || defaultCloneDir(url))
        .replace(/\.\./g, '')
        .replace(/^[/\\.]+/, '')
        .replace(/[/\\]+$/, '')
        || defaultCloneDir(url)
      try {
        const qUrl = shQuote(String(url))
        const qTarget = shQuote(target)
        const r = await runWorkspaceCommand(`if [ -d ${qTarget}/.git ]; then cd ${qTarget} && git fetch --all --prune && git pull --ff-only; elif [ -e ${qTarget} ]; then echo "Destination exists but is not a git repository: "${qTarget} >&2; exit 2; else git clone ${qUrl} ${qTarget}; fi`, { timeoutMs: 120_000 })
        if (r.exitCode !== 0) return err(`git clone failed (${r.exitCode}): ${truncate(r.stderr || r.stdout, 3000)}`)
        return ok({ path: target, containerPath: `${scopedContainerRoot()}/${target}`, stdout: truncate(r.stdout, 4000), stderr: truncate(r.stderr, 1000), updated: /Already up to date|Updating |Fast-forward|From /i.test(r.stdout + r.stderr) })
      } catch (e) { return err(e.message) }
    },
  },

  git_commit: {
    description: "Direct privileged commit+push (Privileged Agent Runtime Platform).",
    params: { message: { type: "string", required: true } },
    handler: async ({ message }) => PRIVILEGED_TOOLS.host_git_push.handler({ message, token: process.env.GITHUB_TOKEN || "" }),
  },

};
