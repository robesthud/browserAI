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

export const reviewTools = {
  review_code_changes: {
    description: 'Execute an automated Actor-Critic semantic code review on the currently modified files in the workspace. Returns structural feedback, code smell, and security blocker warnings.',
    params: {},
    handler: async () => {
      try {
        const rStatus = await runSandboxCommand({ command: 'git status --short', timeoutMs: 15_000 })
        const rDiff = await runSandboxCommand({ command: 'git diff -- . " :(exclude)package-lock.json" | head -n 400', timeoutMs: 15_000 })
        
        if (!rStatus.stdout.trim()) {
          return ok({ message: 'No modified files to review in the workspace.' })
        }
        
        const provider = getActiveKeyDecrypted(null)
        if (!provider?.baseUrl || !provider?.model || !provider?.apiKey) {
          return ok({ message: 'Semantic review skipped: no active model/key configured in Vault.' })
        }
        
        const prompt = `Please review the following git status and diff. 
Evaluate it for:
1. Code smells or logical bugs.
2. Security issues (secrets, hardcoded credentials, path traversals).
3. Code design and formatting quality.

Git Status:
${rStatus.stdout}

Git Diff:
${rDiff.stdout}

Return a concise list of recommendations, categorized into [BLOCKER], [WARNING], and [SUGGESTION]. Answer in Russian.`

        const reply = await callLLM({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          authType: provider.authType,
          authHeader: provider.authHeader,
          extraHeaders: provider.extraHeaders,
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'You are a senior code reviewer. Give strict, concise, bulleted feedback.' },
            { role: 'user', content: prompt }
          ]
        })
        
        return ok({ review: reply?.text || 'Review could not be generated.' })
      } catch (e) { return err(e.message) }
    }
  },

};
