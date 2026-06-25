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

export const memoryTools = {
  recall_facts: {
    description: 'List remembered cross-session facts for this user.',
    params: {},
    handler: async ({ _userId } = {}) => {
      try { return ok({ facts: listFacts(_userId || '') }) } catch (e) { return err(e.message) }
    },
  },

  remember_fact: {

    description: 'Remember a stable key/value fact about the user or project for future chats.',
    params: {
      key: { type: 'string', required: true, description: 'Short stable key.' },
      value: { type: 'string', required: true, description: 'Fact value, max 1KB.' },
    },
    handler: async ({ key, value, _userId } = {}) => {
      try { return ok(upsertFact(_userId || '', key, value)) } catch (e) { return err(e.message) }
    },
  },

  forget_fact: {
    description: 'Forget a remembered fact by key.',
    params: { key: { type: 'string', required: true, description: 'Fact key to delete.' } },
    handler: async ({ key, _userId } = {}) => {
      try { return ok(forgetFact(_userId || '', key)) } catch (e) { return err(e.message) }
    },
  },

  kb_search: {
    description: 'Search the personal knowledge base.',
    params: {
      query: { type: 'string', required: true, description: 'Search query.' },
      topK: { type: 'number', optional: true, description: 'Max passages, default 5.' },
    },
    handler: async ({ query, topK = 5, _userId } = {}) => {
      try { return ok({ results: searchKnowledge(_userId || '', query, { topK }) }) } catch (e) { return err(e.message) }
    },
  },

  kb_list: {
    description: 'List documents in the personal knowledge base.',
    params: {},
    handler: async ({ _userId } = {}) => {
      try { return ok({ documents: listDocuments(_userId || '') }) } catch (e) { return err(e.message) }
    },
  },

  kb_add: {
    description: 'Add a document to the personal knowledge base.',
    params: {
      title: { type: 'string', required: true, description: 'Document title.' },
      text: { type: 'string', required: true, description: 'Document text.' },
      source: { type: 'string', optional: true, description: 'Optional source URL/path.' },
    },
    handler: async ({ title, text, source = '', _userId } = {}) => {
      try { return ok(addDocument(_userId || '', { title, text, source })) } catch (e) { return err(e.message) }
    },
  },

  kb_delete: {
    description: 'Delete a document from the personal knowledge base by id.',
    params: { id: { type: 'string', required: true, description: 'Document id.' } },
    handler: async ({ id, _userId } = {}) => {
      try { return ok(deleteDocument(_userId || '', id)) } catch (e) { return err(e.message) }
    },
  },

};
