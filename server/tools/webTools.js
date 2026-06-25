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

export const webTools = {
  web_search: {
    description: 'Search the public web via DuckDuckGo. Returns up to 5 results with title, url and snippet.',
    params: {
      query: { type: 'string', required: true, description: 'Search query.' },
      limit: { type: 'number', optional: true, description: 'Max results, default 5, max 10.' },
    },
    handler: async ({ query, limit = 5 } = {}) => {
      if (!query) return err('query is required')
      try {
        const data = await searchWeb(String(query), Math.min(10, Math.max(1, Number(limit) || 5)))
        // searchWeb возвращает массив напрямую, не объект {results:[]}
        const results = Array.isArray(data) ? data : (data?.results || [])
        return ok({ query, results })
      } catch (e) { return err(e.message) }
    },
  },

  web_fetch: {
    description: 'Fetch a web page and return its text content (HTML stripped).',
    params: {
      url: { type: 'string', required: true, description: 'Full URL starting with http:// or https://' },
    },
    handler: async ({ url } = {}) => {
      if (!url) return err('url is required')
      try {
        const page = await fetchWebPage(String(url))
        return ok({ url, title: page?.title || '', content: truncate(page?.content || page?.text || '', 12000) })
      } catch (e) { return err(e.message) }
    },
  },

    shell_session_run: {
    description: 'Run a command in a persistent per-chat bash session. cwd/env/export/cd persist across calls. Use for multi-step development work, long installs/tests/builds, and commands where session state matters. Streams stdout/stderr while running.',
    params: {
      command: { type: 'string', required: true, description: 'Shell command to run in the persistent session.' },
      timeout_sec: { type: 'number', optional: true, description: 'Max seconds, default 120, max 900.' },
      cwd: { type: 'string', optional: true, description: 'Container cwd for new session. Default /workspace.' },
    },
    handler: async ({ command, timeout_sec = 120, cwd = '/workspace', _chatId = '', _signal, _onStdout, _onStderr } = {}) => {
      if (!command) return err('command is required')
      if (!_chatId) return err('chat session id is required for persistent shell')
      try {
        const { value: r, changes } = await detectWorkspaceChangesAround(() => runInSession({
          chatId: _chatId,
          command: rewriteWorkspacePaths(String(command)),
          cwd: rewriteWorkspacePaths(String(cwd || '/workspace')),
          timeoutMs: Math.min(900_000, Math.max(1_000, Number(timeout_sec) * 1000 || 120_000)), // вынести в const при рефакторинге
          signal: _signal,
          onStdout: _onStdout,
          onStderr: _onStderr,
        }))
        const _hintSes = r.killed
          ? 'TIMEOUT: команда превысила лимит времени. Используй shell_background_start для долгих операций.'
          : r.cancelled ? 'CANCELLED: команда отменена пользователем. Остановись и уточни следующий шаг.' : null
        return ok({ stdout: truncate(r.stdout, 12000), stderr: truncate(r.stderr, 6000), exitCode: r.exitCode, durationMs: r.durationMs, sessionId: r.sessionId, killed: r.killed, cancelled: r.cancelled, changedFiles: changes, persistent: true, ..._hintSes ? { hint: _hintSes } : {} })
      } catch (e) { return err(e.message) }
    },
  },

};
