import { callLLM } from './llmClient.js'

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

export async function classifyIntentAI({ provider, history }) {
  const userText = lastUserText(history)
  if (!userText.trim()) return 'CHAT'

  const t = userText.toLowerCase().trim()
  if (t.length <= 15 && /^(привет|hi|hello|как дела|кто ты|ку|здравствуй|йо|йоу|прив|дратути|тест|test)$/.test(t)) {
    return 'CHAT'
  }

  let model = provider.model
  const lowerBase = String(provider.baseUrl || '').toLowerCase()
  if (lowerBase.includes('deepseek.com') && model === 'deepseek-reasoner') {
    model = 'deepseek-chat'
  } else if (lowerBase.includes('googleapis') || lowerBase.includes('gemini')) {
    model = 'gemini-2.5-flash'
  } else if (lowerBase.includes('openrouter')) {
    model = 'google/gemini-2.5-flash:free'
  }

  // Contextual routing: format the last 4 messages of history
  const recentMessages = (history || []).slice(-4).map((m) => {
    const role = String(m.role || 'user').toUpperCase()
    const content = typeof m.content === 'string' ? m.content : '[media]'
    return `${role}: ${content}`
  }).join('\n')

  const systemPrompt = `You are a professional supervisor router. Classify the user's latest message intent, taking the recent conversation context into account.
Reply with exactly one word in uppercase:
CHAT - simple greeting, casual conversation, general questions, explanations or writing text/articles not needing tools/files.
WEB - requests for current facts, weather, news, or internet search.
AGENT - requests to create/edit/delete files, write/fix/run code, run bash/terminal commands, docker, git, deploy, or work in workspace.

Recent Conversation Context:
${recentMessages}

User message to classify: "${userText}"
Output:`

  try {
    const reply = await Promise.race([
      callLLM({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        authType: provider.authType || 'bearer',
        authHeader: provider.authHeader || '',
        extraHeaders: provider.extraHeaders || {},
        model,
        messages: [{ role: 'system', content: systemPrompt }],
        temperature: 0,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
    ])
    const decision = String(reply?.text || '').trim().toUpperCase()
    if (['CHAT', 'WEB', 'AGENT'].includes(decision)) {
      return decision
    }
  } catch (e) {
    console.warn('[intent classification failed, falling back to heuristics]:', e.message)
  }
  return null
}
