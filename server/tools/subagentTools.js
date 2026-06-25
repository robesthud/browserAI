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

export const subagentTools = {
  spawn_agent: {
    description: 'Запустить СУБ-АГЕНТА для ЛЁГКОЙ подзадачи (однофайловый скрипт, простая правка, исследование одного вопроса). Это НЕ для сложных миссий — для них используй operator:start_mission. Возвращает job_id. wait:true ждёт завершения (синхронный режим), wait:false запускает в фоне и сразу возвращает job_id для опроса через get_agent_result.',
    params: {
      goal: { type: 'string', required: true, description: 'Задача для суб-агента. Будь конкретным: что создать/проверить, какой результат ожидается.' },
      context: { type: 'string', optional: true, description: 'Дополнительный контекст: имена файлов, требования, формат ответа.' },
      wait: { type: 'boolean', optional: true, description: 'true = ждать результата до timeout_sec (синхронный). false = фон, вернуть job_id для опроса через get_agent_result.' },
      timeout_sec: { type: 'number', optional: true, description: 'Макс. время ожидания при wait:true (сек). По умолч. 300. НЕ больше 600.' },
    },
    handler: async ({ goal, context = '', wait = false, timeout_sec = 300, _userId, _chatId, _provider, _parentJobId = '' } = {}) => {
      if (!goal) return err('goal is required')
      try {
        const { createJob, registerRuntimeInput, startJob } = await import('./jobs.js')
        const content = context ? `Контекст от главного агента:\n${context}\n\nЗадача:\n${goal}` : goal
        const job = createJob({
          userId: _userId || '', chatId: _chatId || '',
          type: 'agent_run', title: `🤖 ${String(goal).slice(0, 70)}`,
          parentJobId: String(_parentJobId || ''),  // S4-D1: link to parent for SubAgentsPanel
          input: {
            prompt: content, history: [{ role: 'user', content }],
            provider: _provider || {},
            extraSystem: '[sub-agent] You are a sub-agent spawned by a parent agent. Complete the task concisely. Do not ask the user for input.',
          },
        })
        if (_provider) registerRuntimeInput(job.id, { provider: _provider })
        startJob(job.id)
        if (!wait) return ok({ job_id: job.id, status: 'running', goal: String(goal).slice(0, 100) })
        const deadline = Date.now() + Math.min(600, Math.max(10, Number(timeout_sec) || 300)) * 1000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 2500))
          const { getJob } = await import('./jobs.js')
          const j = getJob(job.id)
          if (!j) return err('sub-agent job disappeared')
          if (['succeeded', 'failed', 'cancelled'].includes(j.status)) {
            return ok({ job_id: j.id, status: j.status, result: j.result?.content || j.result || null, error: j.error || null })
          }
        }
        return ok({ job_id: job.id, status: 'timeout', message: `Суб-агент работает дольше ${timeout_sec}с. Проверь позже через get_agent_result.` })
      } catch (e) { return err(e.message) }
    },
  },

  get_agent_result: {
    description: 'Получить статус и результат суб-агента по job_id. Используй после spawn_agent с wait:false.',
    params: {
      job_id: { type: 'string', required: true, description: 'ID суб-агента из spawn_agent.' },
    },
    handler: async ({ job_id } = {}) => {
      if (!job_id) return err('job_id is required')
      try {
        const { getJob } = await import('./jobs.js')
        const j = getJob(job_id)
        if (!j) return err(`Job not found: ${job_id}`)
        return ok({ job_id: j.id, status: j.status, progress: j.progress || 0,
          result: j.result?.content || j.result || null, error: j.error || null,
          title: j.title, running: !['succeeded', 'failed', 'cancelled'].includes(j.status) })
      } catch (e) { return err(e.message) }
    },
  },
};
