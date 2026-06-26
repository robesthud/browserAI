import express from 'express'
import { requireAuth } from '../authz.js'
import { safeErrorMessage } from '../errorSanitizer.js'
import { listActiveAgentRuns, clearActiveAgentRun } from '../agentLoop.js'
import { runAgentWithPiCore } from '../agentEngine.js'

async function runAgent(opts) {
  return runAgentWithPiCore({
    providerInput: opts.provider,
    history: opts.history,
    extraSystem: opts.extraSystem,
    res: opts.res,
    userId: opts.userId,
    workspaceScope: opts.workspaceScope,
    maxSteps: opts.maxSteps,
  })
}
import { isDeepSeekWebUrl, handleDeepSeekWebChat } from '../deepseekWeb.js'
import { resolveProviderFromInput } from '../providerResolution.js'
import { buildSessionHeaders, applyBodyDefaults, getChatUrl } from '../stealthHeaders.js'
import { callLLM, callLLMStream, isAnthropicOfficialUrl, isGoogleGenerativeNativeUrl, normalizeProviderError } from '../llmClient.js'
import { getActiveBearer, getCookieHeader } from '../deepseekTokenRefresher.js'
import { isBlockedHost } from '../ssrf.js'
import { getAgentTask, latestAgentTask, listAgentTasks } from '../agentTasks.js'
import { listJobs as _listJobsFn } from '../jobs.js'
import { answerQuestion, cancelQuestion, listPendingQuestions, getPendingQuestion } from '../askUserRegistry.js'
import { sandboxHealth } from '../agentSandbox.js'
import { browserHealth } from '../browserTools.js'
import { listRunsByChat as _listRunsByChat, getLastRun as _getLastRun, getReplayForRun as _getReplayForRun, summarizeForResume as _summarizeForResume } from '../runResume.js'
import { getSessionState as getDeepSeekState } from '../deepseekTokenRefresher.js'
import { agentChatLimiter } from '../securityHardening.js'

const router = express.Router()

router.use((req, res, next) => {
  if (req.path === '/health') return next()
  return requireAuth(req, res, next)
})

function buildAgentProvider(reqBody = {}) {
  return resolveProviderFromInput(reqBody, { requireBearer: false })
}

router.post('/chat', agentChatLimiter, async (req, res) => {
  // Important: this router is mounted both at /api and /api/agent.
  // Therefore POST /api/agent/chat lands here with req.baseUrl === '/api/agent'.
  // In that case we must run the Agent SSE endpoint, not the plain /api/chat proxy.
  if (req.baseUrl === '/api/agent') {
    try {
      // Пробрасываем maxSteps из тела запроса в runAgent — раньше оно терялось.
      // UI-слайдер (DB params) имеет приоритет, но API-вызовы теперь работают явно.
      const reqMaxSteps = Math.max(0, Number(req.body?.maxSteps || 0))
      await runAgent({
        history: req.body?.history || [],
        extraSystem: req.body?.extraSystem || '',
        provider: buildAgentProvider(req.body || {}),
        res,
        userId: req.user?.id,
        workspaceScope: req.body?.chatId,
        maxSteps: reqMaxSteps || undefined,
      })
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: safeErrorMessage(e, 'agent route failed') })
      } else {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: safeErrorMessage(e, 'agent route failed') })}\n\n`)
          res.write(`event: done\ndata: ${JSON.stringify({ reason: 'route-crash', tokens: { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 } })}\n\n`)
        } catch {}
        try { res.end() } catch {}
      }
    }
    return
  }

  let {
    messages,
    temperature = 0.7,
    stream = false,
  } = req.body || {}

  let provider
  try {
    provider = resolveProviderFromInput(req.body || {}, { requireBearer: true })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message })
  }

  const {
    baseUrl,
    apiKey,
    authType = 'bearer',
    authHeader = '',
    extraHeaders = {},
    model,
  } = provider || {}

  if (!baseUrl || !apiKey || !model) return res.status(400).json({ error: 'Missing params' })

  if (isDeepSeekWebUrl(baseUrl)) {
    return handleDeepSeekWebChat({ reqBody: { ...req.body, baseUrl, apiKey, authType, authHeader, extraHeaders, model }, res })
  }

  if (isAnthropicOfficialUrl(baseUrl) || isGoogleGenerativeNativeUrl(baseUrl)) {
    try {
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream')
        return callLLMStream({ ...req.body, baseUrl, apiKey, authType, authHeader, extraHeaders, model, onTextDelta: (chunk) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`) })
      }
      return res.json(await callLLM({ ...req.body, baseUrl, apiKey, authType, authHeader, extraHeaders, model }))
    } catch (e) { return res.status(502).json({ error: safeErrorMessage(e) }) }
  }

  const targetUrl = getChatUrl(baseUrl)

  // A — SSRF guard: reject private/loopback upstream targets for plain proxy
  if (isBlockedHost(targetUrl)) return res.status(400).json({ error: 'Blocked upstream host (SSRF guard).' })

  const headers = buildSessionHeaders({ baseUrl, apiKey, authType, authHeader, extraHeaders })
  const body = applyBodyDefaults({ model, messages, temperature, stream }, baseUrl)

  // C — Abort controller: enforce 2-minute timeout so a slow upstream can't exhaust workers
  const proxyAbort = new AbortController()
  const proxyTimer = setTimeout(() => proxyAbort.abort(), 120_000)

  try {
    const upstream = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: proxyAbort.signal })
    clearTimeout(proxyTimer)
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      // C — Guard against null body (some fetch polyfills may return null)
      if (!upstream.body) { res.status(502).json({ error: 'Upstream returned no body.' }); return }
      const reader = upstream.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      } catch (streamErr) {
        // B — Cancel reader on client disconnect / write error to free upstream resources
        try { reader.cancel() } catch { /* best-effort */ }
        if (!res.headersSent) res.status(502).json({ error: safeErrorMessage(streamErr) })
        else try { res.end() } catch { /* best-effort */ }
      }
    } else {
      res.json(await upstream.json())
    }
  } catch (e) {
    clearTimeout(proxyTimer)
    res.status(502).json({ error: safeErrorMessage(e) })
  }
})

router.post('/agent/chat', agentChatLimiter, async (req, res) => {
  try {
    const reqMaxSteps = Math.max(0, Number(req.body?.maxSteps || 0))
    await runAgent({
      history: req.body?.history || [],
      extraSystem: req.body?.extraSystem || '',
      provider: buildAgentProvider(req.body || {}),
      res,
      userId: req.user?.id,
      workspaceScope: req.body?.chatId,
      maxSteps: reqMaxSteps || undefined,
    })
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: safeErrorMessage(e, 'agent route failed') })
    } else {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: safeErrorMessage(e, 'agent route failed') })}\n\n`)
        res.write(`event: done\ndata: ${JSON.stringify({ reason: 'route-crash', tokens: { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 } })}\n\n`)
      } catch {}
      try { res.end() } catch {}
    }
  }
})

router.get('/tasks', (req, res) => {
  res.json({ tasks: listAgentTasks({ chatId: req.query.chatId, userId: req.user?.id }) })
})

router.get('/tasks/latest', (req, res) => {
  res.json({ task: latestAgentTask({ chatId: req.query.chatId, userId: req.user?.id, includeDone: true }) })
})

router.post('/runs/:chatId/reset', (req, res) => {
  res.json({ ok: true, cleared: clearActiveAgentRun(req.params.chatId) })
})

router.get('/questions', (req, res) => {
  res.json({ questions: listPendingQuestions({ userId: req.user?.id, chatId: req.query.chatId }) })
})

router.post('/answer', (req, res) => {
  const ok = answerQuestion(req.body.question_id, req.body.answer, { userId: req.user?.id })
  res.json({ ok })
})

router.get('/runs/:chatId', (req, res) => {
  try {
    const chatId = String(req.params.chatId || '')
    const runs = _listRunsByChat(chatId, { limit: Math.max(1, Math.min(50, Number(req.query.limit) || 10)) })
    res.json({ schema: 'browserai.chat_runs.v1', chatId, count: runs.length, runs })
  } catch (e) {
    res.status(500).json({ error: 'runs_list_failed', message: safeErrorMessage(e) })
  }
})

router.get('/runs/:chatId/last', (req, res) => {
  try {
    const chatId = String(req.params.chatId || '')
    const last = _getLastRun(chatId)
    if (!last) { res.status(404).json({ error: 'no_runs', chatId }); return }
    res.json({ schema: 'browserai.chat_last_run.v1', ...last })
  } catch (e) {
    res.status(500).json({ error: 'last_run_failed', message: safeErrorMessage(e) })
  }
})

router.post('/runs/:chatId/resume', (req, res) => {
  try {
    const chatId = String(req.params.chatId || '')
    const runId = String(req.body?.runId || req.query?.runId || _getLastRun(chatId)?.runId || '')
    if (!runId) { res.status(404).json({ error: 'no_runs', chatId }); return }
    const summary = _summarizeForResume(runId)
    if (!summary) { res.status(404).json({ error: 'not_found', runId }); return }
    const replay = _getReplayForRun(runId)
    res.json({
      schema: 'browserai.chat_resume.v1',
      runId,
      summary,
      replay: replay || null,
    })
  } catch (e) {
    res.status(500).json({ error: 'resume_failed', message: safeErrorMessage(e) })
  }
})

// 4C — sub-agent polling endpoint
router.get('/jobs/:parentJobId/children', (req, res) => {
  try {
    const parentId = String(req.params.parentJobId || '')
    const kids = _listJobsFn({ parentJobId: parentId, limit: 20 })
    // S4-A1: filter by userId so users can't enumerate other users' sub-agents
    const userId = req.user?.id || ''
    const role = req.user?.role || 'user'
    const filtered = role === 'owner'
      ? kids
      : kids.filter(j => !j.userId || j.userId === userId)
    res.json({ jobs: filtered })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/health', async (req, res) => {
  res.json({
    deepseekManaged: Boolean(getDeepSeekState().alive),
    sandbox: await sandboxHealth(),
    browser: await browserHealth(),
  })
})

export default router

// ── Arena.ai pi-agent-core engine route ──
router.post("/chat-pi", agentChatLimiter, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const isOH = process.env.USE_OPENHANDS === '1' || req.body?.engine === 'openhands';
    let openhandsOk = false;
    if (isOH) {
      try {
        const r = await fetch('http://openhands:3000/api/health', { signal: AbortSignal.timeout(1500) });
        openhandsOk = r.ok;
      } catch { openhandsOk = false; }
    }

    if (openhandsOk) {
      console.log("[Agent Route] Forwarding request to OpenHands engine at http://openhands:3000");
      const ohRes = await fetch('http://openhands:3000/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
      });
      ohRes.body.pipeTo(new WritableStream({
        write(chunk) { res.write(chunk); },
        close() { res.end(); }
      }));
      return;
    }

    const { runAgentWithPiCore } = await import("../agentEngine.js");
    await runAgentWithPiCore({
      history: req.body?.history || [],
      extraSystem: req.body?.extraSystem || "",
      providerInput: req.body || {},
      res,
      userId: req.user?.id,
      workspaceScope: req.body?.chatId,
      maxSteps: Math.max(0, Number(req.body?.maxSteps || 0)),
    });
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      try { res.write("event: error\ndata: " + JSON.stringify({ message: e.message }) + "\n\n"); } catch {}
      try { res.write("event: done\ndata: " + JSON.stringify({ reason: "crash", tokens: {} }) + "\n\n"); } catch {}
      try { res.end(); } catch {}
    }
  }
});
