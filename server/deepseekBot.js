/**
 * deepseekBot.js (Upgraded: Admin Bot)
 *
 * Enhanced Telegram control surface for BrowserAI Admin.
 * Handles DeepSeek sessions, Timeweb/VPS operations, and Docker management.
 *
 * Commands:
 *   /start — main interactive menu
 *
 * Env:
 *   TG_BOT_TOKEN       — Admin bot token
 *   TG_ADMIN_CHAT_ID   — Numeric chat_id allowed to issue commands
 */
import {
  getSessionState,
  refreshNow,
  setSession,
  getCachedModels,
} from './deepseekTokenRefresher.js'
import { runOpsAction, listOpsServices } from './ops.js'
import { sandboxHealth } from './agentSandbox.js'
import { browserHealth } from './browserTools.js'

const TG_TOKEN = process.env.TG_BOT_TOKEN || ''
const ADMIN_CHAT_ID = String(process.env.TG_ADMIN_CHAT_ID || '')
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_SEC = 25

let offset = 0
let running = false

function log(...a) { console.log('[admin-bot]', ...a) }
function warn(...a) { console.warn('[admin-bot]', ...a) }

async function tg(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POLL_TIMEOUT_SEC * 1000 + 5000),
    })
    return r.json()
  } catch (e) {
    warn(`tg.${method} error:`, e.message)
    return { ok: false, error: e.message }
  }
}

async function reply(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  })
}

async function edit(chatId, messageId, text, extra = {}) {
  return tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  })
}

async function answer(callbackQueryId, text = '') {
  return tg('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
}

// ── Keyboards ──────────────────────────────────────────────────────────────

const MAIN_KBD = {
  inline_keyboard: [
    [{ text: '🐳 Docker & Containers', callback_data: 'menu:docker' }],
    [{ text: '🌐 Timeweb VPS', callback_data: 'menu:timeweb' }],
    [{ text: '🧠 DeepSeek Session', callback_data: 'menu:deepseek' }],
    [{ text: '🏥 Health & Stats', callback_data: 'menu:health' }],
  ]
}

const DOCKER_KBD = {
  inline_keyboard: [
    [{ text: '📋 Status (ps)', callback_data: 'ops:browserai:docker_ps' }],
    [{ text: '📜 Logs (App)', callback_data: 'ops:browserai:docker_logs:browserai' }],
    [{ text: '📜 Logs (Sandbox)', callback_data: 'ops:browserai:docker_logs:agent-sandbox' }],
    [{ text: '🔙 Back', callback_data: 'menu:main' }],
  ]
}

const TIMEWEB_KBD = {
  inline_keyboard: [
    [{ text: '🔍 Sync Check', callback_data: 'ops:browserai:sync_check' }],
    [{ text: '🚀 Safe Deploy', callback_data: 'ops:browserai:deploy_safe' }],
    [{ text: '🔄 Restart App', callback_data: 'ops:browserai:restart' }],
    [{ text: '🔙 Back', callback_data: 'menu:main' }],
  ]
}

const DEEPSEEK_KBD = {
  inline_keyboard: [
    [{ text: '📊 Current Status', callback_data: 'ds:status' }],
    [{ text: '🔄 Force Refresh', callback_data: 'ds:refresh' }],
    [{ text: '🤖 List Models', callback_data: 'ds:models' }],
    [{ text: '🔙 Back', callback_data: 'menu:main' }],
  ]
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtDeepSeek(s) {
  return [
    `*🧠 DeepSeek Managed Session*`,
    `• Alive: ${s.alive ? '✅' : '❌'}`,
    `• Token: ${s.hasToken ? '✅' : '❌'}`,
    `• Cookies: ${s.hasCookies ? '✅ (' + s.cookieNames.length + ')' : '—'}`,
    `• Expires: ${s.expiresAt || 'unknown'}` + (s.expiresInSec != null ? ` (${Math.round(s.expiresInSec / 60)}m)` : ''),
    `• Models: ${s.models?.length || 0}`,
    `• Last seen: ${s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleTimeString() : 'never'}`,
    `• Updated by: \`${s.updatedBy || '—'}\``,
  ].join('\n')
}

async function fmtHealth() {
  const ds = getSessionState()
  const sh = await sandboxHealth()
  const bh = await browserHealth()
  return [
    `*🏥 System Health*`,
    `• DeepSeek Web: ${ds.alive ? '✅' : '❌'}`,
    `• Agent Sandbox: ${sh.ok ? '✅' : '❌'} ${sh.container ? '(`' + sh.container + '`)' : ''}`,
    `• Browser (PW): ${bh.ok ? '✅' : '❌'} (${bh.sessions} active)`,
    `• Uptime: ${Math.round(process.uptime() / 3600)}h ${Math.round((process.uptime() % 3600) / 60)}m`,
    `• Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
  ].join('\n')
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleAction(chatId, messageId, data, msg) {
  if (data === 'menu:main') {
    return edit(chatId, messageId, '*🛠 BrowserAI Admin Menu*', { reply_markup: MAIN_KBD })
  }
  if (data === 'menu:docker') {
    return edit(chatId, messageId, '*🐳 Docker Management*', { reply_markup: DOCKER_KBD })
  }
  if (data === 'menu:timeweb') {
    return edit(chatId, messageId, '*🌐 Timeweb VPS Management*', { reply_markup: TIMEWEB_KBD })
  }
  if (data === 'menu:deepseek') {
    return edit(chatId, messageId, '*🧠 DeepSeek Session*', { reply_markup: DEEPSEEK_KBD })
  }
  if (data === 'menu:health') {
    const text = await fmtHealth()
    return edit(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'menu:health' }], [{ text: '🔙 Back', callback_data: 'menu:main' }]] } })
  }

  // DeepSeek Actions
  if (data === 'ds:status') {
    return edit(chatId, messageId, fmtDeepSeek(getSessionState()), { reply_markup: DEEPSEEK_KBD })
  }
  if (data === 'ds:refresh') {
    await reply(chatId, '🔄 Refreshing session...')
    const s = await refreshNow({ source: 'tg-admin-bot' })
    return reply(chatId, '✅ Refresh complete!\n\n' + fmtDeepSeek(s))
  }
  if (data === 'ds:models') {
    const list = getCachedModels()
    const text = list.length 
      ? '*Available Models:*\n' + list.map(m => `• \`${m.id}\``).join('\n')
      : '❌ No models cached.'
    return reply(chatId, text)
  }

  // Ops Actions: ops:service:action[:param]
  if (data.startsWith('ops:')) {
    const [_, service, action, param] = data.split(':')
    const params = param ? { service: param, tail: 100 } : {}
    
    const waitMsg = await reply(chatId, `⏳ Executing \`${service}.${action}\`...`)
    try {
      const result = await runOpsAction({ service, action, params, confirm: true })
      const out = result.stdout || result.stderr || '(no output)'
      const ok = result.exitCode === 0
      const head = `${ok ? '✅' : '❌'} *${service}.${action}*`
      
      // Split output if too long
      const finalBody = out.slice(0, 3500)
      await reply(chatId, `${head}\n\`\`\`\n${finalBody}\n\`\`\``)
      if (out.length > 3500) await reply(chatId, `...(truncated ${out.length - 3500} chars)`)
    } catch (e) {
      await reply(chatId, `❌ Action failed: \`${e.message}\``)
    }
    return tg('deleteMessage', { chat_id: chatId, message_id: waitMsg.result.message_id })
  }
}

async function handleCommand(msg) {
  const chatId = msg.chat?.id
  const text = (msg.text || '').trim()
  if (!chatId) return

  if (ADMIN_CHAT_ID && String(chatId) !== ADMIN_CHAT_ID) {
    await reply(chatId, '⛔ Access Denied. Your ID: `' + chatId + '`')
    return
  }

  const [cmdRaw, ...rest] = text.split(/\s+/)
  const cmd = cmdRaw.replace(/@.*$/, '').toLowerCase()
  const arg = rest.join(' ').trim()

  if (cmd === '/start' || cmd === '/menu') {
    return reply(chatId, '*🛠 BrowserAI Admin Menu*', { reply_markup: MAIN_KBD })
  }

  // Legacy fallback for quick commands
  if (cmd === '/status') return reply(chatId, fmtDeepSeek(getSessionState()))
  if (cmd === '/id') return reply(chatId, `Your Chat ID: \`${chatId}\``)
  
  if (cmd === '/settoken' && arg) {
    const s = await setSession({ userToken: arg, source: 'tg-admin-bot' })
    try { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }) } catch {}
    return reply(chatId, '🔐 Token updated.\n\n' + fmtDeepSeek(s))
  }
}

async function poll() {
  while (running) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SEC}`, {
        signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 5) * 1000),
      })
      const data = await r.json().catch(() => null)
      if (data?.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = Math.max(offset, upd.update_id + 1)
          if (upd.message) {
            handleCommand(upd.message).catch(e => warn('handleCommand:', e.message))
          } else if (upd.callback_query) {
            const cb = upd.callback_query
            await answer(cb.id)
            handleAction(cb.message.chat.id, cb.message.message_id, cb.data, cb.message).catch(e => warn('handleAction:', e.message))
          }
        }
      } else if (data && !data.ok) {
        warn('getUpdates error:', data.description)
        await new Promise(r => setTimeout(r, 5000))
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    }
  }
}

export function startDeepSeekBot() {
  if (!TG_TOKEN) {
    log('TG_BOT_TOKEN not set — admin bot disabled')
    return
  }
  if (!ADMIN_CHAT_ID) {
    warn('TG_ADMIN_CHAT_ID not set — bot will not respond to commands.')
  }
  if ((process.env.DEEPSEEK_BOT || '').toLowerCase() === 'off') {
    log('DEEPSEEK_BOT=off — disabled')
    return
  }
  if (running) return
  running = true
  log('Admin Bot started (DeepSeek + Timeweb)...')
  poll().catch(e => warn('poll loop crashed:', e.message))
}

export function stopDeepSeekBot() {
  running = false
}
