/**
 * deepseekBot.js
 *
 * Optional Telegram control surface for the DeepSeek session refresher.
 * Polls getUpdates (no webhook needed), only accepts messages from the
 * configured admin chat. Commands:
 *
 *   /status                       – show session state
 *   /refresh                      – force heartbeat + models refresh
 *   /settoken <userToken>         – replace Bearer token
 *   /setcookie <name=value;...>   – append/replace cookies
 *   /models                       – list cached models
 *   /help                         – short usage
 *
 * Env:
 *   TG_BOT_TOKEN       – Telegram bot token (8804033846:...)
 *   TG_ADMIN_CHAT_ID   – numeric chat_id allowed to issue commands
 *   DEEPSEEK_BOT       – set to "off" to disable the bot
 */
import {
  getSessionState,
  refreshNow,
  setSession,
  getCachedModels,
} from './deepseekTokenRefresher.js'

const TG_TOKEN = process.env.TG_BOT_TOKEN || ''
const ADMIN_CHAT_ID = String(process.env.TG_ADMIN_CHAT_ID || process.env.TG_CHAT_ID || '')
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_SEC = 25

let offset = 0
let running = false

function log(...a) { console.log('[deepseek-bot]', ...a) }
function warn(...a) { console.warn('[deepseek-bot]', ...a) }

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POLL_TIMEOUT_SEC * 1000 + 5000),
  })
  return r.json()
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

function fmtState(s) {
  const lines = [
    `*DeepSeek session*`,
    `• alive: ${s.alive ? '✅' : '❌'}`,
    `• token: ${s.hasToken ? '✅' : '❌'}`,
    `• cookies: ${s.hasCookies ? s.cookieNames.join(', ') : '—'}`,
    `• expires: ${s.expiresAt || 'unknown'}` + (s.expiresInSec != null ? ` (${Math.round(s.expiresInSec / 60)} min)` : ''),
    `• last seen: ${s.lastSeenAt || 'never'}`,
    `• last refresh: ${s.lastRefreshAt || 'never'}`,
    `• user: ${s.user?.email || s.user?.name || '—'}`,
    `• models cached: ${s.models?.length || 0}`,
    `• updated by: ${s.updatedBy || '—'}`,
  ]
  if (s.lastError) lines.push(`• last error: \`${s.lastError}\``)
  return lines.join('\n')
}

async function handleCommand(msg) {
  const chatId = msg.chat?.id
  const text = (msg.text || '').trim()
  if (!chatId || !text) return

  if (ADMIN_CHAT_ID && String(chatId) !== ADMIN_CHAT_ID) {
    await reply(chatId, '⛔ Not authorized.')
    warn('Unauthorized command from chat', chatId)
    return
  }

  const [cmdRaw, ...rest] = text.split(/\s+/)
  const cmd = cmdRaw.replace(/@.*$/, '').toLowerCase()
  const arg = rest.join(' ').trim()

  try {
    if (cmd === '/start' || cmd === '/help') {
      await reply(chatId,
        '*DeepSeek bot*\n\n' +
        '/status — show session state\n' +
        '/refresh — force refresh\n' +
        '/settoken `<userToken>` — set Bearer token\n' +
        '/setcookie `<name=value;...>` — append/replace cookies\n' +
        '/models — list cached models\n')
      return
    }
    if (cmd === '/status') {
      await reply(chatId, fmtState(getSessionState()))
      return
    }
    if (cmd === '/refresh') {
      const s = await refreshNow({ source: 'tg-bot' })
      await reply(chatId, '🔄 Refresh done.\n\n' + fmtState(s))
      return
    }
    if (cmd === '/settoken') {
      if (!arg) { await reply(chatId, 'Usage: `/settoken <userToken>`'); return }
      const s = await setSession({ userToken: arg, source: 'tg-bot' })
      // Try to delete the message with the secret token
      try { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }) } catch { /* can't delete: not admin or too old */ }
      await reply(chatId, '🔐 Token saved.\n\n' + fmtState(s))
      return
    }
    if (cmd === '/setcookie') {
      if (!arg) { await reply(chatId, 'Usage: `/setcookie <name=value; name2=value2>`'); return }
      const s = await setSession({ cookies: arg, source: 'tg-bot' })
      try { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }) } catch { /* can't delete: not admin or too old */ }
      await reply(chatId, '🍪 Cookies saved.\n\n' + fmtState(s))
      return
    }
    if (cmd === '/models') {
      const list = getCachedModels()
      if (!list.length) { await reply(chatId, 'No models cached yet.'); return }
      await reply(chatId, '*Models:*\n' + list.map((m) => `• \`${m.id}\` — ${m.name || ''}`).join('\n'))
      return
    }
    await reply(chatId, 'Unknown command. /help for the list.')
  } catch (e) {
    warn('command error:', e.message)
    await reply(chatId, `Error: \`${e.message}\``)
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
            handleCommand(upd.message).catch((e) => warn('handleCommand:', e.message))
          }
        }
      } else if (data && !data.ok) {
        warn('getUpdates error:', data.description)
        await new Promise((r) => setTimeout(r, 5000))
      }
    } catch (e) {
      // Network/timeout — back off briefly
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }
}

export function startDeepSeekBot() {
  if (!TG_TOKEN) {
    log('TG_BOT_TOKEN not set — bot disabled')
    return
  }
  if (!ADMIN_CHAT_ID) {
    warn('TG_ADMIN_CHAT_ID not set — bot will refuse every command (set the env var)')
  }
  if ((process.env.DEEPSEEK_BOT || '').toLowerCase() === 'off') {
    log('DEEPSEEK_BOT=off — bot disabled')
    return
  }
  if (running) return
  running = true
  log('Polling Telegram updates...')
  poll().catch((e) => warn('poll loop crashed:', e.message))
}

export function stopDeepSeekBot() {
  running = false
}
