/**
 * userTelegramBot.js
 *
 * Full end-user Telegram bot for BrowserAI. Anyone who messages the bot
 * gets a friendly iOS-style chat interface backed by the same LLM stack
 * the web app uses:
 *
 *   /start            — onboarding, persistent reply keyboard
 *   💬 plain chat     — text + streaming edits + photo/voice in
 *   🤖 agent mode     — tool cards as separate messages
 *   📁 my files       — upload to workspace, /files browser
 *   ⚙️ settings       — pick model, toggle mode, language
 *
 * Distinct from deepseekBot.js (which is the admin control surface for
 * the managed DeepSeek session); this bot is for normal end users.
 *
 * Data lives in three SQLite tables auto-created at boot:
 *
 *   tg_users     chat_id -> linked browserai user_id + prefs
 *   tg_chats     ongoing conversation per tg user
 *   tg_messages  individual messages of a conversation
 *
 * Long polling, no webhook required.
 */
import { runAgent } from './agentLoop.js'
import {
  getActiveBearer as getDeepSeekBearer,
  getCookieHeader as getDeepSeekCookieHeader,
  isSessionValid as isDeepSeekValid,
} from './deepseekTokenRefresher.js'
import { callLLM } from './llmClient.js'
import { GATEWAY_API_KEY, GATEWAY_BASE_URL, getGatewayModels, resolveGatewayModel } from './gateway.js'

const TG_TOKEN = process.env.TG_USER_BOT_TOKEN || process.env.TG_BOT_TOKEN || ''
const POLL_TIMEOUT_SEC = 25
const POLL_INTERVAL_MS = 2000
const STREAM_EDIT_MS = 800            // throttle for edit-message during streaming
const MAX_HISTORY_MESSAGES = 30
const MAX_MESSAGE_LEN = 4000
// Public URL shown to users (e.g. for the web interface link). Configurable via
// env so the deployment host isn't hardcoded. Falls back to APP_URL or the VPS.
const APP_PUBLIC_URL = (process.env.APP_URL || process.env.APP_PUBLIC_URL || 'http://72.56.116.15').replace(/\/$/, '')

// ── Mode / model defaults ──────────────────────────────────────────────────
const DEFAULT_MODE = 'chat'           // 'chat' | 'agent'
const DEFAULT_MODEL = 'deepseek_chat'
const DEFAULT_PROVIDER = {
  baseUrl: GATEWAY_BASE_URL,
  apiKey: GATEWAY_API_KEY,
}

// ── State (in memory; durable bits in SQLite via tgDb) ─────────────────────
let offset = 0
let running = false
let tgDb = null  // injected at start()

function log(...a) { console.log('[user-tg]', ...a) }
function warn(...a) { console.warn('[user-tg]', ...a) }

// ── SQLite tables ──────────────────────────────────────────────────────────
function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_users (
      chat_id INTEGER PRIMARY KEY,
      tg_username TEXT,
      tg_first_name TEXT,
      tg_lang TEXT,
      user_id TEXT,             -- linked browserai user_id (NULL until /link)
      mode TEXT NOT NULL DEFAULT 'chat',
      model TEXT NOT NULL DEFAULT 'deepseek_chat',
      provider_base_url TEXT NOT NULL DEFAULT 'https://browserai.local/free-gateway',
      provider_api_key TEXT NOT NULL DEFAULT '__gateway__',
      active_chat_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tg_chats (
      id TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tg_chats_chat_id ON tg_chats(chat_id);

    CREATE TABLE IF NOT EXISTS tg_messages (
      id TEXT PRIMARY KEY,
      tg_chat_id TEXT NOT NULL,   -- references tg_chats.id
      role TEXT NOT NULL,         -- 'user' | 'assistant' | 'system'
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tg_messages_chat ON tg_messages(tg_chat_id);
  `)
}

function getOrCreateUser(msg) {
  const chatId = msg.chat?.id
  if (!chatId) return null
  const now = Date.now()
  let row = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
  if (!row) {
    tgDb.prepare(`
      INSERT INTO tg_users (chat_id, tg_username, tg_first_name, tg_lang, mode, model, provider_base_url, provider_api_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId,
      msg.from?.username || null,
      msg.from?.first_name || null,
      msg.from?.language_code || null,
      DEFAULT_MODE,
      DEFAULT_MODEL,
      DEFAULT_PROVIDER.baseUrl,
      DEFAULT_PROVIDER.apiKey,
      now, now,
    )
    row = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
  }
  return row
}

function updateUser(chatId, patch) {
  const cols = Object.keys(patch)
  if (!cols.length) return
  const sets = cols.map((c) => `${c} = ?`).join(', ')
  const vals = cols.map((c) => patch[c])
  tgDb.prepare(`UPDATE tg_users SET ${sets}, updated_at = ? WHERE chat_id = ?`)
    .run(...vals, Date.now(), chatId)
}

function ensureActiveChat(user) {
  if (user.active_chat_id) {
    const exists = tgDb.prepare('SELECT id FROM tg_chats WHERE id = ?').get(user.active_chat_id)
    if (exists) return user.active_chat_id
  }
  return newChat(user.chat_id)
}

function newChat(chatId) {
  const id = `tgc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  tgDb.prepare('INSERT INTO tg_chats (id, chat_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, chatId, null, now, now)
  tgDb.prepare('UPDATE tg_users SET active_chat_id = ?, updated_at = ? WHERE chat_id = ?')
    .run(id, now, chatId)
  return id
}

function addMessage(tgChatId, role, content) {
  const id = `tgm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  tgDb.prepare('INSERT INTO tg_messages (id, tg_chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, tgChatId, role, String(content || '').slice(0, MAX_MESSAGE_LEN), Date.now())
  tgDb.prepare('UPDATE tg_chats SET updated_at = ? WHERE id = ?').run(Date.now(), tgChatId)
  return id
}

function getHistory(tgChatId) {
  const rows = tgDb.prepare(`
    SELECT role, content FROM tg_messages
    WHERE tg_chat_id = ?
    ORDER BY created_at ASC
    LIMIT ${MAX_HISTORY_MESSAGES}
  `).all(tgChatId)
  return rows.map((r) => ({ role: r.role, content: r.content }))
}

// ── Telegram API ───────────────────────────────────────────────────────────
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POLL_TIMEOUT_SEC * 1000 + 5000),
  })
  return r.json()
}

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '💬 Чат' }, { text: '🤖 Агент' }],
    [{ text: '📁 Файлы' }, { text: '⚙️ Настройки' }, { text: '🆕 Новый чат' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
}

async function reply(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text: String(text || '').slice(0, MAX_MESSAGE_LEN),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: MAIN_KEYBOARD,
    ...extra,
  })
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: String(text || '').slice(0, MAX_MESSAGE_LEN),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  })
}

async function answerCallbackQuery(id, text = '') {
  return tg('answerCallbackQuery', { callback_query_id: id, text })
}

async function sendChatAction(chatId, action = 'typing') {
  return tg('sendChatAction', { chat_id: chatId, action })
}

// ── Inline keyboards ──────────────────────────────────────────────────────
function modelsKeyboard(currentModel) {
  const candidates = getGatewayModels()

  const rows = candidates.map((m) => ([{
    text: (m === currentModel ? '✓ ' : '  ') + m,
    callback_data: `set_model:${m}`,
  }]))
  rows.push([{ text: '← Назад', callback_data: 'settings_main' }])
  return { inline_keyboard: rows }
}

function modeKeyboard(currentMode) {
  return {
    inline_keyboard: [
      [
        { text: (currentMode === 'chat' ? '✓ ' : '  ') + '💬 Чат',  callback_data: 'set_mode:chat' },
        { text: (currentMode === 'agent' ? '✓ ' : '  ') + '🤖 Агент', callback_data: 'set_mode:agent' },
      ],
      [{ text: '← Назад', callback_data: 'settings_main' }],
    ],
  }
}

function settingsKeyboard(user) {
  return {
    inline_keyboard: [
      [{ text: `Режим: ${user.mode === 'agent' ? '🤖 Агент' : '💬 Чат'}`, callback_data: 'open_modes' }],
      [{ text: `Модель: ${user.model}`, callback_data: 'open_models' }],
      [{ text: '🗑 Очистить историю', callback_data: 'clear_history' }],
    ],
  }
}

// ── LLM calls ─────────────────────────────────────────────────────────────
async function getProvider(user) {
  const requestedModel = user.model || DEFAULT_MODEL
  if (user.provider_base_url === GATEWAY_BASE_URL || user.provider_api_key === GATEWAY_API_KEY) {
    const routed = resolveGatewayModel(requestedModel)
    user = { ...user, provider_base_url: routed.baseUrl, provider_api_key: routed.apiKey, model: routed.model }
  }

  const apiKey = user.provider_api_key === '__managed__'
    ? (isDeepSeekValid() ? getDeepSeekBearer() : '')
    : user.provider_api_key
  const extraHeaders = {}
  if (user.provider_base_url.includes('chat.deepseek.com')) {
    const cookie = getDeepSeekCookieHeader()
    if (cookie) extraHeaders.Cookie = cookie
    extraHeaders.Referer = 'https://chat.deepseek.com/'
    extraHeaders.Origin  = 'https://chat.deepseek.com'
  }
  return {
    baseUrl: user.provider_base_url,
    apiKey,
    authType: 'bearer',
    model: user.model || DEFAULT_MODEL,
    extraHeaders,
    temperature: 0.7,
  }
}

async function handlePlainChat(user, userText) {
  const tgChatId = ensureActiveChat(user)
  addMessage(tgChatId, 'user', userText)
  const history = getHistory(tgChatId)

  // Send placeholder we will edit as the response streams
  const placeholder = await reply(user.chat_id, '✍️ ...')
  const messageId = placeholder?.result?.message_id
  let acc

  const provider = await getProvider(user)
  if (!provider.apiKey) {
    await editMessage(user.chat_id, messageId, '❌ Серверная сессия не настроена. Попробуйте позже.')
    return
  }

  await sendChatAction(user.chat_id, 'typing')

  try {
    // We don't have a streaming non-managed path, so use non-stream callLLM
    // and edit the placeholder once. (Streaming would require duplicating
    // the SSE parser per provider; for the bot a single final edit is
    // perfectly acceptable.)
    const r = await callLLM({
      ...provider,
      messages: history,
    })
    acc = r.text || '(пустой ответ)'
  } catch (e) {
    acc = `❌ Ошибка: ${e.message || String(e)}`
  }

  // Save assistant turn
  addMessage(tgChatId, 'assistant', acc)

  // Final edit — Telegram message limit is 4096 chars, split if needed
  if (acc.length <= 3800) {
    await editMessage(user.chat_id, messageId, acc)
  } else {
    await editMessage(user.chat_id, messageId, acc.slice(0, 3800) + '...')
    let rest = acc.slice(3800)
    while (rest.length > 0) {
      const chunk = rest.slice(0, 3800)
      rest = rest.slice(3800)
      await reply(user.chat_id, chunk)
    }
  }
}

// Throttle edits so we don't hit Telegram's 1-per-second limit
function makeEditQueue(chatId, messageId) {
  let pending = null
  let last = 0
  let busy = false
  return async function schedule(text) {
    pending = text
    if (busy) return
    const wait = Math.max(0, STREAM_EDIT_MS - (Date.now() - last))
    busy = true
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const toSend = pending
    pending = null
    last = Date.now()
    try { await editMessage(chatId, messageId, toSend) } catch { /* rate-limited or message too old */ }
    busy = false
    if (pending) schedule(pending)
  }
}

async function handleAgentChat(user, userText) {
  const tgChatId = ensureActiveChat(user)
  addMessage(tgChatId, 'user', userText)
  const history = getHistory(tgChatId)

  const placeholder = await reply(user.chat_id, '🤖 Думаю...')
  const placeholderId = placeholder?.result?.message_id
  const schedulePlaceholderEdit = makeEditQueue(user.chat_id, placeholderId)

  const provider = await getProvider(user)
  if (!provider.apiKey) {
    await editMessage(user.chat_id, placeholderId, '❌ Серверная сессия не настроена.')
    return
  }

  // Fake SSE response object — we intercept events and translate them
  // to Telegram messages instead of writing to a network stream.
  let toolMsgIds = new Map()  // step -> message_id
  let finalAccumulator = ''
  let aborted = false

  const fakeRes = {
    setHeader: () => {}, flushHeaders: () => {}, on: () => {}, headersSent: false,
    end: () => {},
    write: (s) => {
      // Parse the SSE chunk: 'event: name\ndata: {json}\n\n'
      const lines = String(s).split('\n')
      let evt = 'message'
      let dataLines = []
      for (const line of lines) {
        if (line.startsWith('event:')) evt = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) return
      let data
      try { data = JSON.parse(dataLines.join('\n')) } catch { return }
      handleAgentEvent(evt, data)
    },
  }

  async function handleAgentEvent(kind, data) {
    if (aborted) return
    switch (kind) {
      case 'thinking':
        schedulePlaceholderEdit(`🤖 Шаг ${data.step}: думаю...`)
        break
      case 'thought':
        if (data.text && data.text.trim()) {
          try { await reply(user.chat_id, `💭 ${data.text.trim().slice(0, 1500)}`, { reply_markup: undefined }) } catch { /* ignore Telegram send error */ }
        }
        break
      case 'tool_start': {
        const args = data.args || {}
        let summary = ''
        if (args.path) summary = ` \`${args.path}\``
        else if (args.command) summary = ` \`${String(args.command).slice(0, 80)}\``
        else if (args.query) summary = ` "${args.query}"`
        const r = await reply(user.chat_id, `🔧 *${data.name}*${summary}\n_выполняется..._`, { reply_markup: undefined })
        toolMsgIds.set(data.step, r?.result?.message_id)
        break
      }
      case 'tool_result': {
        const id = toolMsgIds.get(data.step)
        if (!id) break
        const icon = data.ok ? '✓' : '✗'
        let summary = ''
        let resultSnippet = ''
        if (data.result?.stdout) resultSnippet = String(data.result.stdout).slice(0, 500)
        else if (data.result?.content) resultSnippet = String(data.result.content).slice(0, 500)
        else if (data.error) resultSnippet = data.error
        const text = `${icon} *${data.name}*${summary}${resultSnippet ? '\n```\n' + resultSnippet + '\n```' : ''}`
        try { await editMessage(user.chat_id, id, text) } catch { /* ignore Telegram edit error */ }
        break
      }
      case 'assistant':
        finalAccumulator = data.text || ''
        break
      case 'done':
        schedulePlaceholderEdit(finalAccumulator || '_(агент завершил работу)_')
        addMessage(tgChatId, 'assistant', finalAccumulator)
        break
      case 'error':
        await reply(user.chat_id, `❌ ${data.message || 'Ошибка агента'}`)
        break
    }
  }

  try {
    await runAgent({
      provider,
      history,
      res: fakeRes,
    })
  } catch (e) {
    await reply(user.chat_id, `❌ Агент упал: ${e.message || String(e)}`)
  }
}

// ── Command / message routing ──────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat?.id
  if (!chatId) return

  // Save / refresh user
  const user = getOrCreateUser(msg)
  if (!user) return

  const text = (msg.text || '').trim()
  if (!text) {
    // Voice / photo / document — placeholder for later
    if (msg.voice) {
      await reply(chatId, '🎙 Голосовые пока в разработке — текст пока работает.')
    } else if (msg.document || msg.photo) {
      await reply(chatId, '📁 Загрузка файлов через бота в разработке. Используйте веб-интерфейс пока.')
    }
    return
  }

  // Commands
  if (text === '/start' || text === '/help') {
    await reply(chatId,
      `👋 Привет, ${user.tg_first_name || 'друг'}!\n\n` +
      `Я ваш AI-помощник BrowserAI. Просто пишите что хотите.\n\n` +
      `*Меню снизу:*\n` +
      `💬 *Чат* — обычный разговор с моделью\n` +
      `🤖 *Агент* — модель может читать/писать файлы, искать в вебе, выполнять команды\n` +
      `📁 *Файлы* — ваше хранилище\n` +
      `⚙️ *Настройки* — выбор модели и режима\n` +
      `🆕 *Новый чат* — очистить контекст\n\n` +
      `Текущий режим: *${user.mode === 'agent' ? '🤖 Агент' : '💬 Чат'}*\n` +
      `Модель: \`${user.model}\``,
    )
    return
  }
  if (text === '/new' || text === '🆕 Новый чат') {
    newChat(chatId)
    await reply(chatId, '🆕 Новый чат начат. Контекст очищен.')
    return
  }
  if (text === '/settings' || text === '⚙️ Настройки') {
    const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
    await reply(chatId, '⚙️ *Настройки*', { reply_markup: settingsKeyboard(fresh) })
    return
  }
  if (text === '/files' || text === '📁 Файлы') {
    await reply(chatId, `📁 Управление файлами через бота в разработке.\n\nИспользуйте веб: ${APP_PUBLIC_URL}`)
    return
  }
  if (text === '💬 Чат') {
    updateUser(chatId, { mode: 'chat' })
    await reply(chatId, '💬 Включён режим *Чат*. Просто пишите вопрос — отвечу.')
    return
  }
  if (text === '🤖 Агент') {
    updateUser(chatId, { mode: 'agent' })
    await reply(chatId, '🤖 Включён *Агентский режим*. Я могу читать файлы, искать в вебе, выполнять команды.')
    return
  }
  if (text === '/model') {
    const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
    await reply(chatId, '🔧 Выберите модель:', { reply_markup: modelsKeyboard(fresh.model) })
    return
  }

  // Plain text -> route to chat or agent
  const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
  await sendChatAction(chatId, 'typing')
  if (fresh.mode === 'agent') {
    await handleAgentChat(fresh, text)
  } else {
    await handlePlainChat(fresh, text)
  }
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id
  const data = cb.data || ''
  if (!chatId) return

  if (data === 'settings_main') {
    const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: settingsKeyboard(fresh) })
  } else if (data === 'open_models') {
    const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: modelsKeyboard(fresh.model) })
  } else if (data === 'open_modes') {
    const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: modeKeyboard(fresh.mode) })
  } else if (data.startsWith('set_model:')) {
    const model = data.slice(10)
    updateUser(chatId, { model, provider_base_url: GATEWAY_BASE_URL, provider_api_key: GATEWAY_API_KEY })
    const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
    await answerCallbackQuery(cb.id, `Модель: ${model}`)
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: settingsKeyboard(fresh) })
  } else if (data.startsWith('set_mode:')) {
    const mode = data.slice(9)
    updateUser(chatId, { mode })
    const fresh = tgDb.prepare('SELECT * FROM tg_users WHERE chat_id = ?').get(chatId)
    await answerCallbackQuery(cb.id, `Режим: ${mode}`)
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: settingsKeyboard(fresh) })
  } else if (data === 'clear_history') {
    newChat(chatId)
    await answerCallbackQuery(cb.id, 'История очищена')
    await reply(chatId, '🆕 Новый чат начат. Контекст очищен.')
  } else {
    await answerCallbackQuery(cb.id)
  }
}

// ── Long polling loop ──────────────────────────────────────────────────────
async function poll() {
  while (running) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SEC}&allowed_updates=${encodeURIComponent(JSON.stringify(['message','callback_query']))}`,
        { signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 5) * 1000) },
      )
      const data = await r.json().catch(() => null)
      if (data?.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = Math.max(offset, upd.update_id + 1)
          if (upd.message) {
            handleMessage(upd.message).catch((e) => warn('handleMessage:', e.message))
          } else if (upd.callback_query) {
            handleCallback(upd.callback_query).catch((e) => warn('handleCallback:', e.message))
          }
        }
      } else if (data && !data.ok) {
        warn('getUpdates error:', data.description)
        await new Promise((r) => setTimeout(r, 5000))
      }
    } catch {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }
}

// ── Public ─────────────────────────────────────────────────────────────────
export function startUserTelegramBot({ db }) {
  if (!TG_TOKEN) {
    log('TG_USER_BOT_TOKEN not set — user bot disabled')
    return
  }
  if ((process.env.USER_TG_BOT || '').toLowerCase() === 'off') {
    log('USER_TG_BOT=off — disabled')
    return
  }
  if (running) return
  tgDb = db
  initTables(tgDb)
  running = true
  log('Polling Telegram updates (user-bot)...')
  poll().catch((e) => warn('poll loop crashed:', e.message))
}

export function stopUserTelegramBot() {
  running = false
}
