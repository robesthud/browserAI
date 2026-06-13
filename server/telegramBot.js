/**
 * telegramBot.js — BrowserAI Telegram v2
 *
 * Single-token Telegram interface for BrowserAI:
 *   • admin menu: health/logs/docker/CI/deploy/DeepSeek
 *   • same AI backend as the web app: smart-router → chat/web/agent
 *   • one active run per Telegram chat
 *   • /stop support via fake SSE close
 *   • throttled message edits to avoid Telegram rate limits
 *
 * Env:
 *   TG_BOT_TOKEN       — the single bot token
 *   TG_ADMIN_CHAT_ID   — allowed admin chat id (required for ops/agent)
 *   TELEGRAM_BOT       — set 'off' to disable
 */
import db from './db.js'
import { runAgent } from './agentLoop.js'
import { answerQuestion, cancelQuestion } from './askUserRegistry.js'
import { runOpsAction, listOpsServices } from './ops.js'
import {
  getSessionState as getDeepSeekState,
  getActiveBearer as getDeepSeekBearer,
  getCookieHeader as getDeepSeekCookieHeader,
  refreshNow as refreshDeepSeekNow,
  setSession as setDeepSeekSession,
} from './deepseekTokenRefresher.js'

const TG_TOKEN = process.env.TG_BOT_TOKEN || ''
const ADMIN_CHAT_ID = String(process.env.TG_ADMIN_CHAT_ID || process.env.TG_CHAT_ID || '')
const POLL_TIMEOUT_SEC = 25
const POLL_INTERVAL_MS = 1500
const MAX_TG = 3900
const DEFAULT_BASE_URL = 'https://chat.deepseek.com/api/v0'
const DEFAULT_MODEL = 'deepseek_chat'

let running = false
let offset = 0
const activeRuns = new Map() // chatId -> { stop, startedAt, placeholderId }
const pendingApprovalScope = new Map() // questionId -> { userId, chatId }
const lastLogs = new Map() // chatId -> { stdout, stderr, exitCode }

function log(...a) { console.log('[tg-v2]', ...a) }
function warn(...a) { console.warn('[tg-v2]', ...a) }

function isAdmin(chatId) {
  return ADMIN_CHAT_ID && String(chatId) === ADMIN_CHAT_ID
}

function stripMd(s = '') {
  // We intentionally do not use parse_mode. Keep messages readable and safe.
  return String(s || '')
}

function chunkText(text = '', max = MAX_TG) {
  const s = stripMd(text)
  if (s.length <= max) return [s]
  const out = []
  let rest = s
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

async function tg(method, body = {}) {
  if (!TG_TOKEN) return { ok: false, description: 'TG_BOT_TOKEN not set' }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 10) * 1000),
    })
    return await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))
  } catch (e) {
    return { ok: false, description: e?.message || String(e) }
  }
}

async function sendMessage(chatId, text, extra = {}) {
  const chunks = chunkText(text || ' ') || [' ']
  let last = null
  for (const chunk of chunks) {
    last = await tg('sendMessage', {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
      ...extra,
    })
  }
  return last
}

async function editMessage(chatId, messageId, text, extra = {}) {
  if (!messageId) return sendMessage(chatId, text, extra)
  return tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: String(text || ' ').slice(0, MAX_TG),
    disable_web_page_preview: true,
    ...extra,
  })
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🤖 ИИ Агент', callback_data: 'menu:agent' }, { text: '🖥 Сервер', callback_data: 'ops:health' }],
      [{ text: '📜 Логи', callback_data: 'ops:logs' }, { text: '🐳 Docker', callback_data: 'ops:docker' }],
      [{ text: '🚀 CI/Деплой', callback_data: 'ops:ci' }, { text: '🧠 DeepSeek', callback_data: 'ds:status' }],
      [{ text: '⏹ Stop', callback_data: 'run:stop' }, { text: '🔄 Обновить', callback_data: 'menu:main' }],
    ],
  }
}

function deployKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✅ Deploy safe', callback_data: 'deploy:safe' }, { text: '🩺 Health', callback_data: 'ops:health' }],
      [{ text: '⏳ Ждать CI', callback_data: 'ops:ci_wait' }, { text: '📜 Логи', callback_data: 'ops:logs' }],
      [{ text: '⬅ Назад', callback_data: 'menu:main' }],
    ],
  }
}

function deepSeekKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: 'ds:refresh' }, { text: '📊 Status', callback_data: 'ds:status' }],
      [{ text: '⬅ Назад', callback_data: 'menu:main' }],
    ],
  }
}

async function localHealthCheck() {
  const port = process.env.PORT || 8080
  const urls = [
    `http://127.0.0.1:${port}/api/health`,
    'http://127.0.0.1:8080/api/health',
    'http://localhost:8080/api/health',
  ]
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const text = await r.text().catch(() => '')
      if (r.ok) return { ok: true, url, text }
    } catch { /* try next */ }
  }
  return { ok: false, url: urls[0], text: 'local health failed' }
}

async function removeLegacyReplyKeyboard(chatId) {
  // Old userTelegramBot used a persistent reply keyboard. Telegram clients keep
  // that keyboard until the bot explicitly removes it, even after the code is
  // deleted. Send a tiny cleanup message and try to delete it afterwards.
  const r = await tg('sendMessage', {
    chat_id: chatId,
    text: '⌨️ Убираю старую клавиатуру…',
    reply_markup: { remove_keyboard: true },
  })
  const mid = r?.result?.message_id
  if (mid) setTimeout(() => tg('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {}), 1200).unref?.()
}

function fmtDeepSeek(s = getDeepSeekState()) {
  return [
    '🧠 DeepSeek',
    `Alive: ${s.alive ? '✅' : '❌'}`,
    `Token: ${s.hasToken ? '✅' : '❌'}`,
    `Cookies: ${s.hasCookies ? `✅ (${s.cookieNames?.length || 0})` : '❌'}`,
    `Models: ${s.models?.length || 0}`,
    `User: ${s.user?.email || s.user?.name || '—'}`,
    `Last seen: ${s.lastSeenAt || '—'}`,
    s.lastError ? `Last error: ${s.lastError}` : '',
  ].filter(Boolean).join('\n')
}

function limitString(str, max = 3800) {
  const s = String(str || '')
  return s.length > max ? s.slice(0, max) + '\n...[truncated]' : s
}

function fmtOpsResult(title, r) {
  const out = limitString(r?.stdout || '', 3000)
  const err = limitString(r?.stderr || '', 800)
  return [
    title,
    `exitCode: ${r?.exitCode ?? '—'}`,
    out ? `\n${out}` : '',
    err ? `\nERR:\n${err}` : '',
  ].filter(Boolean).join('\n')
}

async function menu(chatId, messageId = null) {
  const ds = getDeepSeekState()
  const h = await localHealthCheck()
  const health = h.ok ? 'OK' : 'FAIL'
  const text = [
    '🏗 BrowserAI Telegram v2',
    '',
    `Server: ${health === 'OK' ? '🟢' : '🔴'} ${health}`,
    `DeepSeek: ${ds.alive ? '🟢 OK' : '🔴 not ready'}`,
    `Active run: ${activeRuns.has(String(chatId)) ? 'yes' : 'no'}`,
    '',
    'Напишите обычное сообщение — я отправлю его в тот же AI/Agent pipeline, что и сайт.',
  ].join('\n')
  // Always send NEW message for fresh data (do not edit old message to avoid stale data confusion)
  return sendMessage(chatId, text, { reply_markup: mainKeyboard() })
}

function ensureProvider() {
  const bearer = getDeepSeekBearer()
  if (!bearer) throw new Error('DeepSeek managed session is not configured')
  const cookie = getDeepSeekCookieHeader()
  const extraHeaders = {
    Referer: 'https://chat.deepseek.com/',
    Origin: 'https://chat.deepseek.com',
  }
  if (cookie) extraHeaders.Cookie = cookie
  return {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: bearer,
    authType: 'bearer',
    extraHeaders,
    model: DEFAULT_MODEL,
    temperature: 0.4,
  }
}

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_chats_v2 (
      chat_id TEXT PRIMARY KEY,
      history_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `)
}

function loadHistory(chatId) {
  ensureTables()
  const row = db.prepare('SELECT history_json FROM telegram_chats_v2 WHERE chat_id=?').get(String(chatId))
  if (!row) return []
  try { return JSON.parse(row.history_json || '[]') } catch { return [] }
}

function saveHistory(chatId, history = []) {
  ensureTables()
  const compact = history.slice(-20).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 6000) }))
  db.prepare(`INSERT INTO telegram_chats_v2 (chat_id, history_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET history_json=excluded.history_json, updated_at=excluded.updated_at`)
    .run(String(chatId), JSON.stringify(compact), Date.now())
}

function clearHistory(chatId) {
  ensureTables()
  db.prepare('DELETE FROM telegram_chats_v2 WHERE chat_id=?').run(String(chatId))
}

function makeEditQueue(chatId, messageId) {
  let pending = ''
  let lastSent = ''
  let timer = null
  const flush = async () => {
    timer = null
    const text = pending || '…'
    if (text === lastSent) return
    lastSent = text
    await editMessage(chatId, messageId, text).catch(() => {})
  }
  return (text, delayMs = 1500) => {
    pending = String(text || '').slice(0, MAX_TG)
    if (timer) return
    timer = setTimeout(flush, delayMs)
    timer.unref?.()
  }
}

async function runAiForTelegram(chatId, userText) {
  const key = String(chatId)
  if (activeRuns.has(key)) {
    return sendMessage(chatId, 'Я ещё выполняю прошлый запрос. Нажмите /stop или дождитесь завершения.', {
      reply_markup: { inline_keyboard: [[{ text: '⏹ Stop', callback_data: 'run:stop' }]] },
    })
  }

  const placeholder = await sendMessage(chatId, '🤔 Думаю…')
  const messageId = placeholder?.result?.message_id
  const scheduleEdit = makeEditQueue(chatId, messageId)
  const userId = `tg:${chatId}`
  const workspaceScope = `tg-${chatId}`
  const closeHandlers = []
  let stopped = false
  let finalText = ''
  let statusLine = '🤔 Думаю…'

  const history = loadHistory(chatId)
  const nextHistory = [...history, { role: 'user', content: userText }]

  const fakeRes = {
    __browseraiAgentSseSeq: 0,
    headersSent: false,
    setHeader: () => {},
    flushHeaders: () => {},
    on: (event, fn) => {
      if (event === 'close' && typeof fn === 'function') closeHandlers.push(fn)
    },
    write: (chunk) => {
      if (stopped) return
      const text = String(chunk || '')
      let event = 'message'
      for (const block of text.split(/\n\n/)) {
        if (!block.trim() || block.startsWith(':')) continue
        let data = null
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            try { data = JSON.parse(line.slice(5).trim()) } catch { data = null }
          }
        }
        if (!data) continue
        const p = data.payload || data
        if (event === 'agent_context') {
          const mode = p.serverRoute?.mode || p.task?.type || 'agent'
          statusLine = `🤖 Режим: ${mode}`
          scheduleEdit(statusLine, 300)
        } else if (event === 'tool_start') {
          statusLine = `🛠 ${p.name || 'tool'}…`
          scheduleEdit(statusLine, 500)
        } else if (event === 'tool_result') {
          statusLine = `${p.ok ? '✅' : '⚠️'} ${p.name || 'tool'}`
          scheduleEdit(statusLine, 800)
        } else if (event === 'tool_approval') {
          const qid = p.question_id
          if (qid) {
            pendingApprovalScope.set(qid, { userId, chatId: workspaceScope })
            sendMessage(chatId, `🔐 Требуется подтверждение: ${p.tool || 'tool'}\n${JSON.stringify(p.args || {}, null, 2).slice(0, 1500)}`, {
              reply_markup: { inline_keyboard: [[
                { text: '✅ Approve', callback_data: `ap:${qid}:y` },
                { text: '❌ Deny', callback_data: `ap:${qid}:n` },
              ]] },
            }).catch(() => {})
          }
        } else if (event === 'ask_user') {
          const qid = p.question_id
          if (qid) {
            pendingApprovalScope.set(qid, { userId, chatId: workspaceScope })
            sendMessage(chatId, `❓ ${p.question || 'Нужен ответ пользователя'}`, {
              reply_markup: { inline_keyboard: [[
                { text: 'OK', callback_data: `ask:${qid}:ok` },
                { text: 'Cancel', callback_data: `ask:${qid}:cancel` },
              ]] },
            }).catch(() => {})
          }
        } else if (event === 'assistant_delta') {
          finalText += String(p.chunk || '')
          scheduleEdit((statusLine ? `${statusLine}\n\n` : '') + finalText, 900)
        } else if (event === 'assistant') {
          finalText = String(p.text || finalText || '')
          scheduleEdit(finalText || '✅ Готово', 0)
        } else if (event === 'error') {
          finalText = `❌ ${p.message || 'Ошибка агента'}`
          scheduleEdit(finalText, 0)
        }
      }
    },
    end: () => {},
  }

  const stop = () => {
    stopped = true
    for (const fn of closeHandlers.splice(0)) {
      try { fn() } catch { /* ignore */ }
    }
    editMessage(chatId, messageId, '⏹ Остановлено').catch(() => {})
  }

  activeRuns.set(key, { stop, startedAt: Date.now(), placeholderId: messageId })
  try {
    await runAgent({
      provider: ensureProvider(),
      history: nextHistory,
      extraSystem: '',
      userId,
      workspaceScope,
      res: fakeRes,
    })
    if (finalText && !finalText.startsWith('❌')) saveHistory(chatId, [...nextHistory, { role: 'assistant', content: finalText }])
    await editMessage(chatId, messageId, finalText || '✅ Готово').catch(() => {})
    if (finalText.length > MAX_TG) {
      const rest = finalText.slice(MAX_TG)
      for (const part of chunkText(rest)) await sendMessage(chatId, part)
    }
  } catch (e) {
    await editMessage(chatId, messageId, `❌ ${e?.message || String(e)}`).catch(() => {})
  } finally {
    activeRuns.delete(key)
  }
}

async function runOpsAndReply(chatId, messageId, title, service, action, params = {}, confirm = true, keyboard = null) {
  await editMessage(chatId, messageId, `⏳ ${title}…`).catch(() => {})
  try {
    const r = await runOpsAction({ service, action, params, confirm })
    await editMessage(chatId, messageId, fmtOpsResult(title, r), keyboard ? { reply_markup: keyboard } : {}).catch(async () => {
      await sendMessage(chatId, fmtOpsResult(title, r), keyboard ? { reply_markup: keyboard } : {})
    })
  } catch (e) {
    await editMessage(chatId, messageId, `❌ ${title}: ${e?.message || String(e)}`, keyboard ? { reply_markup: keyboard } : {}).catch(() => {})
  }
}

async function handleCommand(msg) {
  const chatId = msg.chat?.id
  const text = String(msg.text || '').trim()
  if (!chatId) return

  if (text === '/id') return sendMessage(chatId, `chat_id: ${chatId}`)
  if (!isAdmin(chatId)) return sendMessage(chatId, `⛔ Access denied. Your chat_id: ${chatId}`)

  const [cmd, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ').trim()
  switch ((cmd || '').replace(/@.*$/, '').toLowerCase()) {
    case '/start':
      await removeLegacyReplyKeyboard(chatId)
      return menu(chatId)
    case '/menu':
      return menu(chatId)
    case '/hidekeyboard':
      await removeLegacyReplyKeyboard(chatId)
      return sendMessage(chatId, '✅ Старая Telegram-клавиатура убрана. Используйте inline-меню в сообщении /menu.')
    case '/help':
      return sendMessage(chatId, [
        'BrowserAI Telegram v2 commands:',
        '/menu — главное меню',
        '/new — новый AI-контекст',
        '/stop — остановить текущий агентский run',
        '/status — статус BrowserAI/DeepSeek',
        '/health — health check',
        '/logs [service] [tail] — docker logs',
        '/docker — docker compose ps',
        '/ci — GitHub Actions status',
        '/deploy — меню деплоя',
        '/deepseek — DeepSeek status',
        '/hidekeyboard — убрать старую нижнюю Telegram-клавиатуру',
        '',
        'Любой обычный текст → тот же AI/Agent pipeline, что на сайте.',
      ].join('\n'))
    case '/new':
      clearHistory(chatId)
      return sendMessage(chatId, '🆕 Новый Telegram AI-контекст начат.')
    case '/stop': {
      const run = activeRuns.get(String(chatId))
      if (!run) return sendMessage(chatId, 'Нет активного запуска.')
      run.stop()
      return
    }
    case '/status':
      return menu(chatId)
    case '/health': {
      const h = await localHealthCheck()
      return sendMessage(chatId, `🩺 BrowserAI health\nstatus: ${h.ok ? 'OK ✅' : 'FAIL ❌'}\nurl: ${h.url}\n${h.text || ''}`)
    }
    case '/docker':
      return runOpsAndReply(chatId, (await sendMessage(chatId, '⏳ Docker…'))?.result?.message_id, 'Docker', 'browserai', 'docker_ps')
    case '/logs': {
      const [service = 'browserai', tail = '160'] = arg.split(/\s+/)
      return runOpsAndReply(chatId, (await sendMessage(chatId, '⏳ Logs…'))?.result?.message_id, 'Logs', 'browserai', 'docker_logs_recent', { service, tail: Number(tail) || 160 })
    }
    case '/ci':
      return runOpsAndReply(chatId, (await sendMessage(chatId, '⏳ CI…'))?.result?.message_id, 'GitHub Actions', 'github', 'actions_status', { limit: 5 })
    case '/deploy':
      return sendMessage(chatId, '🚀 Deploy menu', { reply_markup: deployKeyboard() })
    case '/deepseek':
      return sendMessage(chatId, fmtDeepSeek(), { reply_markup: deepSeekKeyboard() })
    case '/settoken':
      if (!arg) return sendMessage(chatId, 'Использование: /settoken <userToken>')
      await setDeepSeekSession({ userToken: arg, source: 'telegram-v2' })
      try { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }) } catch { /* ignore */ }
      return sendMessage(chatId, '🔐 DeepSeek token updated.\n\n' + fmtDeepSeek())
    case '/setcookie':
    case '/setcookies':
      if (!arg) return sendMessage(chatId, 'Использование: /setcookie <name=value; ...>')
      await setDeepSeekSession({ cookies: arg, source: 'telegram-v2' })
      try { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }) } catch { /* ignore */ }
      return sendMessage(chatId, '🍪 DeepSeek cookies updated.\n\n' + fmtDeepSeek())
    default:
      return runAiForTelegram(chatId, text)
  }
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id
  const messageId = cb.message?.message_id
  const data = String(cb.data || '')
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {})
  if (!chatId) return
  if (!isAdmin(chatId)) return editMessage(chatId, messageId, '⛔ Access denied')

  if (data === 'menu:main') return menu(chatId)
  if (data === 'menu:agent') return editMessage(chatId, messageId, '🤖 Просто напишите задачу текстом. Я сам выберу chat/web/agent режим.\n\nПример: “Проверь логи и скажи, почему сервер тормозит”.', { reply_markup: mainKeyboard() })
  if (data === 'run:stop') {
    const run = activeRuns.get(String(chatId))
    if (!run) return editMessage(chatId, messageId, 'Нет активного запуска.', { reply_markup: mainKeyboard() })
    run.stop()
    return editMessage(chatId, messageId, '⏹ Остановлено.', { reply_markup: mainKeyboard() })
  }

  if (data.startsWith('ap:')) {
    const [, qid, yn] = data.split(':')
    const scope = pendingApprovalScope.get(qid) || {}
    const ok = answerQuestion(qid, { selected: [yn === 'y' ? 'approve' : 'deny'] }, { userId: scope.userId })
    pendingApprovalScope.delete(qid)
    return editMessage(chatId, messageId, ok ? (yn === 'y' ? '✅ Approved' : '❌ Denied') : 'Approval expired')
  }
  if (data.startsWith('ask:')) {
    const [, qid, ans] = data.split(':')
    const scope = pendingApprovalScope.get(qid) || {}
    const ok = ans === 'cancel'
      ? cancelQuestion(qid, 'cancelled from telegram', { userId: scope.userId })
      : answerQuestion(qid, { selected: ['ok'] }, { userId: scope.userId })
    pendingApprovalScope.delete(qid)
    return editMessage(chatId, messageId, ok ? '✅ Answered' : 'Question expired')
  }

  if (data === 'ds:status') return sendMessage(chatId, fmtDeepSeek(), { reply_markup: deepSeekKeyboard() })
  if (data === 'ds:refresh') {
    await sendMessage(chatId, '🔄 Refreshing DeepSeek…')
    await refreshDeepSeekNow({ source: 'telegram-v2' }).catch(() => null)
    return sendMessage(chatId, fmtDeepSeek(), { reply_markup: deepSeekKeyboard() })
  }

  if (data === 'ops:health') {
    const h = await localHealthCheck()
    return sendMessage(chatId, `🩺 BrowserAI health\nstatus: ${h.ok ? 'OK ✅' : 'FAIL ❌'}\nurl: ${h.url}\n${h.text || ''}`, { reply_markup: mainKeyboard() })
  }
  if (data === 'ops:docker') return runOpsAndReply(chatId, messageId, 'Docker', 'browserai', 'docker_ps', {}, true, mainKeyboard())
  if (data === 'ops:logs') {
    await editMessage(chatId, messageId, '⏳ Загружаю логи…').catch(() => {})
    try {
      const r = await runOpsAction({ service: 'browserai', action: 'docker_logs_recent', params: { service: 'browserai', tail: 160 }, confirm: true })
      lastLogs.set(String(chatId), { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode })
      const text = fmtOpsResult('📜 Logs', r)
      const keyboard = {
        inline_keyboard: [
          [{ text: '📋 Скопировать', callback_data: 'logs:copy' }, { text: '🔄 Обновить', callback_data: 'ops:logs' }],
          [{ text: '⬅ Назад', callback_data: 'menu:main' }],
        ],
      }
      return editMessage(chatId, messageId, text, { reply_markup: keyboard }).catch(async () => {
        await sendMessage(chatId, text, { reply_markup: keyboard })
      })
    } catch (e) {
      return editMessage(chatId, messageId, `❌ Logs: ${e?.message || String(e)}`, { reply_markup: mainKeyboard() }).catch(() => {})
    }
  }
  if (data === 'logs:copy') {
    const last = lastLogs.get(String(chatId))
    if (!last) {
      return editMessage(chatId, messageId, 'Нет сохранённых логов. Нажмите 📜 Логи сначала.', { reply_markup: mainKeyboard() }).catch(() => {})
    }
    const r = { stdout: last.stdout, stderr: last.stderr, exitCode: last.exitCode }
    const text = fmtOpsResult('📜 Logs (copy)', r)
    await sendMessage(chatId, text)
    return editMessage(chatId, messageId, 'Логи отправлены отдельным сообщением для копирования.', { reply_markup: mainKeyboard() }).catch(() => {})
  }
  if (data === 'ops:ci') return runOpsAndReply(chatId, messageId, 'GitHub Actions', 'github', 'actions_status', { limit: 5 }, true, deployKeyboard())
  if (data === 'ops:ci_wait') return runOpsAndReply(chatId, messageId, 'Waiting GitHub Actions', 'github', 'actions_wait', { workflows: 'CI,Deploy to Timeweb', limit: 10, timeout_sec: 900, interval_sec: 10 }, true, deployKeyboard())
  if (data === 'deploy:safe') {
    return editMessage(chatId, messageId, '⚠️ Запустить deploy_safe?', {
      reply_markup: { inline_keyboard: [[{ text: '✅ Да, deploy_safe', callback_data: 'deploy:safe:confirm' }, { text: '❌ Нет', callback_data: 'menu:main' }]] },
    })
  }
  if (data === 'deploy:safe:confirm') return runOpsAndReply(chatId, messageId, 'Deploy safe', 'browserai', 'deploy_safe', {}, true, deployKeyboard())
}

async function poll() {
  while (running) {
    try {
      const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SEC}&allowed_updates=${encodeURIComponent(JSON.stringify(['message','callback_query']))}`
      const r = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 8) * 1000) })
      const data = await r.json().catch(() => null)
      if (data?.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = Math.max(offset, upd.update_id + 1)
          if (upd.message) handleCommand(upd.message).catch((e) => warn('handleCommand:', e?.message || e))
          else if (upd.callback_query) handleCallback(upd.callback_query).catch((e) => warn('handleCallback:', e?.message || e))
        }
      } else if (data && !data.ok) {
        warn('getUpdates:', data.description)
        await sleep(POLL_INTERVAL_MS * 3)
      }
    } catch {
      await sleep(POLL_INTERVAL_MS)
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export async function startTelegramBot() {
  if (!TG_TOKEN) { log('TG_BOT_TOKEN not set — disabled'); return }
  if ((process.env.TELEGRAM_BOT || '').toLowerCase() === 'off') { log('TELEGRAM_BOT=off — disabled'); return }
  if (!ADMIN_CHAT_ID) { warn('TG_ADMIN_CHAT_ID is not set — bot will only answer /id and deny all admin actions') }
  if (running) return
  running = true
  ensureTables()
  await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => {})
  await tg('setMyCommands', { commands: [
    { command: 'start', description: 'Главное меню BrowserAI' },
    { command: 'menu', description: 'Главное меню' },
    { command: 'new', description: 'Новый AI-контекст' },
    { command: 'stop', description: 'Остановить текущий run' },
    { command: 'status', description: 'Статус сервера' },
    { command: 'health', description: 'Health check' },
    { command: 'logs', description: 'Логи контейнера' },
    { command: 'docker', description: 'Docker ps' },
    { command: 'ci', description: 'GitHub Actions' },
    { command: 'deploy', description: 'Deploy menu' },
    { command: 'deepseek', description: 'DeepSeek status' },
    { command: 'hidekeyboard', description: 'Убрать старую нижнюю клавиатуру' },
    { command: 'id', description: 'Показать chat_id' },
  ] }).catch(() => {})
  log('Telegram v2 polling started (single token)')
  poll().catch((e) => warn('poll loop crashed:', e?.message || e))
}

export function stopTelegramBot() {
  running = false
  for (const run of activeRuns.values()) run.stop?.()
  activeRuns.clear()
}
