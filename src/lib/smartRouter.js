/**
 * Lightweight client-side router for BrowserAI.
 *
 * Goal: do NOT send every user turn through the expensive full agent loop.
 * The router is deliberately model-agnostic:
 *   - chat: plain /api/chat, no tools, cheapest
 *   - web:  plain /api/chat + server-built web context (settings.useWebAI=true)
 *   - agent: full /api/agent/chat with tools/workspace/bash/deploy
 */

function textFromAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  return attachments.map((a) => `${a?.name || ''} ${a?.type || ''} ${a?.path || ''}`).join(' ')
}

export function routeUserMessage(text = '', attachments = [], { forceAgent = false } = {}) {
  const raw = String(text || '').trim()
  const t = raw.toLowerCase()
  const att = textFromAttachments(attachments).toLowerCase()

  if (forceAgent) {
    return {
      mode: 'agent',
      reason: 'Агент включён вручную',
      icon: '🤖',
    }
  }

  if (!raw && attachments.length) {
    return { mode: 'chat', reason: 'Вложения без команды', icon: '💬' }
  }

  // Explicit commands / ops / code changes need the full agent.
  const agentPatterns = [
    /\b(ssh|docker|nginx|systemctl|journalctl|timeweb|vps|vds|deploy|деплой|сервер|логи|логах|github|git|ci\/cd)\b/i,
    /(исправ|почини|реализуй|добавь|перепиши|измени|обнови|создай файл|удали файл|переименуй|собери|протестируй|проверь код|найди в файлах|прочитай файл)/i,
    /(зайди|подключись|настрой|установи|запусти|выполни команд|bash|консоль|терминал)/i,
    /(workspace|репозитор|проект|код|скрипт|файл|папк|readme|package\.json)/i,
  ]
  if (agentPatterns.some((re) => re.test(raw)) || /(code|script|json|jsx|tsx|python|node|npm|vite|react)/i.test(att)) {
    return { mode: 'agent', reason: 'Нужны инструменты/файлы/код', icon: '🤖' }
  }

  // Current facts should use web, but still not full agent.
  const webPatterns = [
    /(погода|прогноз|температур|курс|цена|стоимость|котировк|новост|сегодня|сейчас|актуальн|свеж|последн|расписан|афиша|результат матча)/i,
    /(weather|forecast|news|today|current|latest|price|stock|exchange rate|score|schedule)/i,
    /(найди в интернете|поищи в интернете|загугли|что происходит|что нового)/i,
  ]
  if (webPatterns.some((re) => re.test(raw))) {
    return { mode: 'web', reason: 'Нужна актуальная информация', icon: '🌐' }
  }

  // Very short conversational / knowledge / writing requests: keep cheap.
  if (raw.length <= 1200) {
    return { mode: 'chat', reason: 'Обычный вопрос без инструментов', icon: '💬' }
  }

  // Long pasted text can still be answered by normal chat unless it includes
  // action/code keywords above.
  return { mode: 'chat', reason: 'Длинный текст, но инструменты не нужны', icon: '💬' }
}
