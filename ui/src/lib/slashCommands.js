/**
 * slashCommands.js
 *
 * Cline / Claude-Code style slash commands. User types `/cmd ...` as
 * the first token of their message and the Composer intercepts it
 * instead of sending it to the LLM.
 *
 * Two return shapes:
 *   { handled: true }                  — command was executed; clear input
 *   { handled: false }                 — not a slash command; pass through
 *   { handled: true, send: string }    — command rewrote the text; send this
 *
 * Each command receives a context object so they can do real work
 * (open settings modal, clear chat, set model, query cost).
 */

export const SLASH_COMMANDS = [
  { name: '/help',     hint: 'list of all commands' },
  { name: '/clear',    hint: 'archive the current chat and start a new one' },
  { name: '/compact',  hint: 'force a context-manager compaction now' },
  { name: '/cost',     hint: 'show today\'s LLM spend' },
  { name: '/model',    hint: 'switch to a different model (e.g. /model gpt-4o-mini)' },
  { name: '/settings', hint: 'open the settings modal' },
  { name: '/search',   hint: 'open the chat search modal' },
  { name: '/save',     hint: 'create a manual checkpoint of the current workspace' },
  { name: '/undo',     hint: 'open the checkpoints tray' },
  { name: '/bg',       hint: 'list background bash tasks' },
  { name: '/export',   hint: 'download the current chat as Markdown' },
  { name: '/agent',    hint: 'toggle Agent Mode for this chat (on/off)' },
]

/**
 * Try to handle a slash command. Returns { handled, send?, message? }.
 *
 * @param {string} text - raw user input (trimmed)
 * @param {object} ctx  - hooks from Composer:
 *    { newChat, openSettings, openSearch, openCheckpoints,
 *      onExportChat, onToggleAgent, onSetModel, fetchCost, postFlash }
 */
export async function runSlashCommand(text, ctx = {}) {
  const m = /^\/(\w+)(?:\s+(.*))?$/.exec(text)
  if (!m) return { handled: false }
  const cmd = m[1].toLowerCase()
  const arg = (m[2] || '').trim()

  switch (cmd) {
    case 'help': {
      ctx.postFlash?.({
        kind: 'info',
        text: 'Slash-команды:\n' + SLASH_COMMANDS.map((c) => `  ${c.name.padEnd(10)} — ${c.hint}`).join('\n'),
      })
      return { handled: true }
    }
    case 'clear': {
      ctx.newChat?.()
      ctx.postFlash?.({ kind: 'ok', text: 'Чат архивирован, начат новый.' })
      return { handled: true }
    }
    case 'compact': {
      // Just hint the agent — the actual compaction runs on the next
      // turn via manageContext on the server side.
      return { handled: true, send: '/please-compact: сжать контекст до tier-2 прямо сейчас и продолжить' }
    }
    case 'cost': {
      try {
        const info = await ctx.fetchCost?.()
        if (info) {
          ctx.postFlash?.({
            kind: 'info',
            text: `Сегодня потрачено: $${(info.dailyTotal || 0).toFixed(4)} / лимит $${(info.cap || 0).toFixed(2)}`,
          })
        }
      } catch { ctx.postFlash?.({ kind: 'err', text: 'Не удалось получить расход' }) }
      return { handled: true }
    }
    case 'model': {
      if (!arg) {
        ctx.postFlash?.({ kind: 'info', text: 'Использование: /model <id> (например: /model gpt-4o-mini)' })
        return { handled: true }
      }
      const ok = ctx.onSetModel?.(arg)
      ctx.postFlash?.({
        kind: ok ? 'ok' : 'err',
        text: ok ? `Модель переключена на ${arg}` : `Модель «${arg}» не найдена в твоих ключах`,
      })
      return { handled: true }
    }
    case 'settings': {
      ctx.openSettings?.()
      return { handled: true }
    }
    case 'search': {
      ctx.openSearch?.()
      return { handled: true }
    }
    case 'save': {
      // Manual checkpoint = ask the agent to do nothing but log a marker.
      return { handled: true, send: '/checkpoint: пожалуйста, не делай никаких изменений, я просто хочу сохранить точку отката текущего состояния workspace.' }
    }
    case 'undo': {
      ctx.openCheckpoints?.()
      return { handled: true }
    }
    case 'bg': {
      return { handled: true, send: 'Вызови bash_list и покажи все фоновые задачи в этом чате.' }
    }
    case 'export': {
      ctx.onExportChat?.()
      return { handled: true }
    }
    case 'agent': {
      const on = arg === 'on' || arg === 'true' || arg === '1'
      const off = arg === 'off' || arg === 'false' || arg === '0'
      if (!on && !off) {
        ctx.onToggleAgent?.(null) // null = toggle current
      } else {
        ctx.onToggleAgent?.(on)
      }
      return { handled: true }
    }
  }
  return { handled: false }
}

/**
 * Resolve @file mentions inside the text. Returns
 *   { text, mentioned: ['path/a.js', 'src/b.ts'] }
 *
 * The Composer then attaches the contents of each mentioned file as a
 * text attachment, so the agent has them available without having to
 * call read_file. Cline calls this "Mentions".
 *
 * Supported syntax:
 *   @path/to/file.js
 *   @"path with spaces.md"
 */
export function parseMentions(text) {
  const mentioned = []
  const re = /@(?:"([^"]+)"|(\S+))/g
  let m
  while ((m = re.exec(text)) != null) {
    const path = (m[1] || m[2] || '').trim()
    if (path) mentioned.push(path)
  }
  return { text, mentioned }
}
