function textFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n')
  }
  return ''
}

export function lastUserText(history = []) {
  const last = [...(history || [])].reverse().find((m) => m?.role === 'user')
  return textFromContent(last?.content || '')
}

export function routeUserMessage(text = '', attachments = [], { forceAgent = false } = {}) {
  const raw = String(text || '').trim()
  const att = Array.isArray(attachments)
    ? attachments.map((a) => `${a?.name || ''} ${a?.type || ''} ${a?.path || ''}`).join(' ').toLowerCase()
    : ''

  if (forceAgent) return { mode: 'agent', reason: 'forced-agent', icon: '🤖' }
  if (!raw && attachments?.length) return { mode: 'chat', reason: 'attachments-only', icon: '💬' }

  const agentPatterns = [
    /\b(ssh|docker|nginx|systemctl|journalctl|timeweb|vps|vds|deploy|деплой|сервер|логи|логах|github|git|ci\/cd)\b/i,
    /(исправ|почини|реализуй|добавь|перепиши|измени|обнови|создай файл|удали файл|переименуй|собери|протестируй|проверь код|найди в файлах|прочитай файл)/i,
    /(зайди|подключись|настрой|установи|запусти|выполни команд|bash|консоль|терминал)/i,
    /(workspace|репозитор|проект|код|скрипт|файл|папк|readme|package\.json)/i,
  ]
  if (agentPatterns.some((re) => re.test(raw)) || /(code|script|json|jsx|tsx|python|node|npm|vite|react)/i.test(att)) {
    return { mode: 'agent', reason: 'tools-required', icon: '🤖' }
  }

  const webPatterns = [
    /(погода|прогноз|температур|курс|цена|стоимость|котировк|новост|сегодня|сейчас|актуальн|свеж|последн|расписан|афиша|результат матча)/i,
    /(weather|forecast|news|today|current|latest|price|stock|exchange rate|score|schedule)/i,
    /(найди в интернете|поищи в интернете|загугли|что происходит|что нового)/i,
  ]
  if (webPatterns.some((re) => re.test(raw))) {
    return { mode: 'web', reason: 'current-info', icon: '🌐' }
  }

  return { mode: 'chat', reason: raw.length <= 1200 ? 'simple-chat' : 'long-chat', icon: '💬' }
}

export function routeHistory(history = [], opts = {}) {
  return routeUserMessage(lastUserText(history), [], opts)
}
