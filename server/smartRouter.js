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

  return { mode: 'agent', reason: raw.length <= 1200 ? 'default-agent' : 'long-agent', icon: '🤖' }
}

export function routeHistory(history = [], opts = {}) {
  return routeUserMessage(lastUserText(history), [], opts)
}

export async function classifyIntentAI({ provider, history }) {
  const userText = lastUserText(history)
  if (!userText.trim()) return 'CHAT'

  const t = userText.toLowerCase().trim().replace(/[?!.,\s]+$/, '')
  if (t.length <= 15 && /^(привет|hi|hello|как дела|кто ты|ку|здравствуй|йо|йоу|прив|дратути|тест|test)$/.test(t)) {
    return 'CHAT'
  }

  let classificationProvider = provider
  let model = provider.model
  const lowerBase = String(provider.baseUrl || '').toLowerCase()

  const isGemini = lowerBase.includes('googleapis') || lowerBase.includes('gemini')
  
  if (isGemini) {
    try {
      const { getSessionState, getActiveBearer } = await import('./deepseekTokenRefresher.js')
      const dsState = getSessionState()
      const dsBearer = getActiveBearer()
      if (dsState?.alive && dsBearer) {
        classificationProvider = {
          baseUrl: 'https://chat.deepseek.com/api/v0',
          apiKey: dsBearer,
          authType: 'bearer',
          extraHeaders: {
            'Referer': 'https://chat.deepseek.com/',
            'Origin': 'https://chat.deepseek.com',
            'Cookie': dsState.cookies || '',
          }
        }
        model = 'deepseek-chat'
      } else {
        return null // Fallback to heuristics if no working DeepSeek managed session
      }
    } catch {
      return null
    }
  } else if (lowerBase.includes('deepseek.com') && model === 'deepseek-reasoner') {
    model = 'deepseek-chat'
  } else if (lowerBase.includes('openrouter')) {
    model = 'google/gemini-2.5-flash:free'
  }

  classificationProvider = { ...classificationProvider, model }

  // Fallback model list for OpenRouter (free tier can change)
  const openRouterFallbackModels = [
    'google/gemini-2.5-flash:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'meta-llama/llama-3.1-8b-instruct:free',
  ]

  // Contextual routing: format the last 4 messages of history
  const recentMessages = (history || []).slice(-4).map((m) => {
    const role = String(m.role || 'user').toUpperCase()
    const content = typeof m.content === 'string' ? m.content : '[media]'
    return `${role}: ${content}`
  }).join('\n')

  // A — sanitize userText to prevent prompt injection (closing quote + newline could inject Output: AGENT)
  const safeUserText = String(userText || '').replace(/[\r\n]/g, ' ').replace(/"/g, '\''). slice(0, 500)
  const systemPrompt = `You are a professional supervisor router. Classify the user's latest message intent, taking the recent conversation context into account.
Reply with exactly one word in uppercase:
CHAT - simple greeting, casual conversation, general questions, explanations or writing text/articles not needing tools/files.
WEB - requests for current facts, weather, news, or internet search.
AGENT - requests to create/edit/delete files, write/fix/run code, run bash/terminal commands, docker, git, deploy, or work in workspace.

Recent Conversation Context:
${recentMessages}

User message to classify: "${safeUserText}"
Output:`

  // Try providers in order: OpenRouter fallback chain → DeepSeek managed → Ollama local → null (heuristics)
  const providersToTry = []

  if (lowerBase.includes('openrouter')) {
    for (const fbModel of openRouterFallbackModels) {
      providersToTry.push({ ...classificationProvider, model: fbModel })
    }
  } else {
    providersToTry.push(classificationProvider)
  }

  // DeepSeek managed fallback
  try {
    const { getSessionState, getActiveBearer } = await import('./deepseekTokenRefresher.js')
    const dsState = getSessionState()
    const dsBearer = getActiveBearer()
    if (dsState?.alive && dsBearer) {
      providersToTry.push({
        baseUrl: 'https://chat.deepseek.com/api/v0',
        apiKey: dsBearer,
        authType: 'bearer',
        extraHeaders: {
          'Referer': 'https://chat.deepseek.com/',
          'Origin': 'https://chat.deepseek.com',
          'Cookie': dsState.cookies || '',
        },
        model: 'deepseek-chat',
      })
    }
  } catch { /* ignore */ }

  // Ollama local fallback
  providersToTry.push({
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'ollama',
    authType: 'bearer',
    model: 'qwen2.5:3b',
  })

  for (const p of providersToTry) {
    try {
      const reply = await Promise.race([
        callLLM({
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          authType: p.authType || 'bearer',
          authHeader: p.authHeader || '',
          extraHeaders: p.extraHeaders || {},
          model: p.model,
          messages: [
            { role: 'system', content: 'You are a professional supervisor router.' },
            { role: 'user', content: systemPrompt }
          ],
          temperature: 0,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000))
      ])
      const decision = String(reply?.text || '').trim().toUpperCase()
      if (['CHAT', 'WEB', 'AGENT'].includes(decision)) {
        return decision
      }
    } catch (e) {
      console.warn(`[intent classification failed for ${p.model || 'unknown'}, trying next]:`, e.message)
    }
  }

  console.warn('[intent classification exhausted all providers, falling back to heuristics]')
  return null
}
