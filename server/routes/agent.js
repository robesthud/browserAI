import express from 'express'
import { requireAuth } from '../authz.js'
import { safeErrorMessage } from '../errorSanitizer.js'
import { proxyAgentChat, interruptConversation } from '../openhandsBridge.js'
import { sandboxHealth } from '../agentSandbox.js'
import { browserHealth } from '../browserTools.js'
import { getSessionState as getDeepSeekState } from '../deepseekTokenRefresher.js'
import { agentChatLimiter } from '../securityHardening.js'

const router = express.Router()

router.use((req, res, next) => {
  if (req.path === '/health') return next()
  return requireAuth(req, res, next)
})

router.post('/chat', agentChatLimiter, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  await proxyAgentChat({ req, res });
})

router.post('/agent/chat', agentChatLimiter, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  await proxyAgentChat({ req, res });
})

router.post('/chat-pi', agentChatLimiter, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  await proxyAgentChat({ req, res });
})

router.post('/chat/stop', async (req, res) => {
  const id = req.body?.chatId || req.body?.id || "";
  if (!id) return res.status(400).json({ error: "chatId required" });
  const ok = await interruptConversation(id).catch(() => false);
  res.json({ ok });
})

router.post('/agent/chat/stop', async (req, res) => {
  const id = req.body?.chatId || req.body?.id || "";
  if (!id) return res.status(400).json({ error: "chatId required" });
  const ok = await interruptConversation(id).catch(() => false);
  res.json({ ok });
})

router.get('/health', async (req, res) => {
  res.json({
    deepseekManaged: Boolean(getDeepSeekState().alive),
    sandbox: await sandboxHealth(),
    browser: await browserHealth(),
    openhands: true,
  })
})

export default router
