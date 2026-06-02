import { backend } from './backend.js'

function normalizeBaseUrl(baseUrl = '') {
  return String(baseUrl || '').replace(/\/$/, '')
}

function extractTextParts(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text || ''
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text
  }
  return ''
}

function extractAssistantText(payload) {
  const choice = payload?.choices?.[0]
  if (!choice) return ''
  const direct = extractTextParts(choice.message?.content)
  if (direct) return direct
  const delta = extractTextParts(choice.delta?.content)
  if (delta) return delta
  return ''
}

function formatAttachment(attachment) {
  if (!attachment) return ''

  const name = attachment.name || 'attachment'
  const type = attachment.type || 'application/octet-stream'
  const size = Number(attachment.size || 0)

  if (attachment.text) {
    return [
      `Файл: ${name}`,
      `Тип: ${type}`,
      size ? `Размер: ${size} байт` : null,
      'Содержимое:',
      String(attachment.text),
    ]
      .filter(Boolean)
      .join('\n')
  }

  return [
    `Файл: ${name}`,
    `Тип: ${type}`,
    size ? `Размер: ${size} байт` : null,
    'Содержимое недоступно как текст. Учитывай файл как бинарное вложение.',
  ]
    .filter(Boolean)
    .join('\n')
}

function messageToProviderContent(message) {
  const base = String(message?.content || '')
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.map(formatAttachment).filter(Boolean)
    : []

  if (attachments.length === 0) return base
  const prefix = base ? `${base}\n\n` : ''
  return `${prefix}Вложения:\n\n${attachments.join('\n\n---\n\n')}`
}

function buildSystemPrompt({ systemPrompt, memorySummary = '', webContext = '' }) {
  const parts = [String(systemPrompt || '').trim()].filter(Boolean)

  if (memorySummary) {
    parts.push(
      'Краткая память по предыдущему контексту разговора:\n' +
        String(memorySummary).trim(),
    )
  }

  if (webContext) {
    parts.push(
      'Ниже приложен актуальный web-контекст. Используй его только если он релевантен запросу пользователя. '
        + 'Если используешь факты из web-контекста, укажи ссылки из него в ответе.\n\n'
        + webContext,
    )
  }

  return parts.join('\n\n')
}

function buildProviderMessages({ settings, messages, memorySummary = '', webContext = '' }) {
  const providerMessages = []
  const system = buildSystemPrompt({
    systemPrompt: settings?.systemPrompt,
    memorySummary,
    webContext,
  })

  if (system) {
    providerMessages.push({ role: 'system', content: system })
  }

  for (const message of messages || []) {
    if (!message?.role) continue
    providerMessages.push({
      role: message.role,
      content: messageToProviderContent(message),
    })
  }

  return providerMessages
}

async function requestChat({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.7,
  stream = false,
  signal,
}) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream,
    }),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${errorText || 'Chat request failed'}`)
  }

  return response
}

export async function streamChat({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.7,
  onChunk,
  signal,
}) {
  const response = await requestChat({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    stream: true,
    signal,
  })

  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let buffer = ''
  let acc = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() || ''

    for (const event of events) {
      const lines = event.split(/\r?\n/)
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw) continue
        if (raw === '[DONE]') return acc

        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }

        const chunk = extractAssistantText(parsed)
        if (!chunk) continue
        acc += chunk
        onChunk?.(chunk)
      }
    }
  }

  return acc
}

async function requestChatText({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.7,
  signal,
}) {
  const response = await requestChat({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    stream: false,
    signal,
  })

  const payload = await response.json()
  return extractAssistantText(payload)
}

async function buildWebContext(settings, messages) {
  if (!settings?.useWebAI) return ''

  const latestUserMessage = [...(messages || [])]
    .reverse()
    .find((item) => item?.role === 'user' && String(item.content || '').trim())

  const query = String(latestUserMessage?.content || '').trim()
  if (!query) return ''

  try {
    const search = await backend.webSearch(query, 5)
    const results = Array.isArray(search?.results) ? search.results.slice(0, 3) : []
    if (results.length === 0) return ''

    const pages = await Promise.all(
      results.map(async (result) => {
        try {
          const page = await backend.webFetch(result.url)
          return {
            title: result.title || result.url,
            url: result.url,
            snippet: result.snippet || '',
            content: String(page?.content || '').replace(/\s+/g, ' ').slice(0, 2500),
          }
        } catch {
          return {
            title: result.title || result.url,
            url: result.url,
            snippet: result.snippet || '',
            content: '',
          }
        }
      }),
    )

    return pages
      .map((page, index) => {
        const lines = [
          `[${index + 1}] ${page.title}`,
          page.url,
          page.snippet ? `Кратко: ${page.snippet}` : null,
          page.content ? `Текст страницы: ${page.content}` : null,
        ].filter(Boolean)
        return lines.join('\n')
      })
      .join('\n\n---\n\n')
  } catch {
    return ''
  }
}

export async function sendChat({
  settings,
  messages,
  memorySummary = '',
  signal,
  onToken,
}) {
  const baseUrl = normalizeBaseUrl(settings?.baseUrl)
  const apiKey = String(settings?.apiKey || '')
  const model = String(settings?.model || '')
  const temperature = Number(settings?.temperature ?? 0.7)

  if (!baseUrl || !apiKey || !model) {
    throw new Error('Сначала настрой API-ключ и выбери модель')
  }

  const webContext = await buildWebContext(settings, messages)
  const providerMessages = buildProviderMessages({
    settings,
    messages,
    memorySummary,
    webContext,
  })

  const shouldStream = Boolean(settings?.stream !== false && typeof onToken === 'function')

  if (shouldStream) {
    return streamChat({
      baseUrl,
      apiKey,
      model,
      messages: providerMessages,
      temperature,
      onChunk: onToken,
      signal,
    })
  }

  return requestChatText({
    baseUrl,
    apiKey,
    model,
    messages: providerMessages,
    temperature,
    signal,
  })
}

export async function summarizeConversation({
  settings,
  messages,
  previousSummary = '',
  signal,
}) {
  const summaryInstruction = [
    'Сделай краткую, но содержательную сводку диалога для дальнейшего продолжения разговора.',
    'Выдели: цели пользователя, факты, решения, ограничения, незавершённые задачи.',
    'Пиши компактно, без воды, в виде 4-8 коротких пунктов.',
  ].join(' ')

  const content = [
    previousSummary ? `Предыдущая сводка:\n${previousSummary}` : null,
    'Новые сообщения:',
    ...(messages || []).map((message) => {
      const role = message?.role === 'assistant' ? 'Ассистент' : 'Пользователь'
      return `${role}: ${messageToProviderContent(message)}`
    }),
  ]
    .filter(Boolean)
    .join('\n\n')

  return requestChatText({
    baseUrl: settings?.baseUrl,
    apiKey: settings?.apiKey,
    model: settings?.model,
    temperature: 0.2,
    signal,
    messages: [
      {
        role: 'system',
        content: summaryInstruction,
      },
      {
        role: 'user',
        content,
      },
    ],
  })
}

function normalizeModels(data) {
  if (!Array.isArray(data?.data)) return []
  return [...new Set(data.data.map((item) => String(item?.id || '').trim()).filter(Boolean))]
}

async function probeChatModel(baseUrl, apiKey, model, signal) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
    signal,
  })

  if (response.ok) return { ok: true }
  return { ok: false, status: response.status }
}

export async function validateKey({ baseUrl, apiKey, model }, signal) {
  const root = normalizeBaseUrl(baseUrl)
  if (!root || !apiKey) {
    return {
      ok: false,
      message: 'Укажите Base URL и ключ',
      models: [],
      preferredModel: '',
    }
  }

  try {
    const response = await fetch(`${root}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          message: `Ключ отклонён (${response.status})`,
          models: [],
          preferredModel: '',
        }
      }
      return {
        ok: false,
        message: `Ошибка ${response.status}`,
        models: [],
        preferredModel: '',
      }
    }

    const payload = await response.json().catch(() => null)
    const models = normalizeModels(payload)
    const preferredCandidates = [model, ...models].filter(Boolean).slice(0, 8)

    for (const candidate of preferredCandidates) {
      const probe = await probeChatModel(root, apiKey, candidate, signal)
      if (probe.ok) {
        return {
          ok: true,
          message: models.length
            ? `Ключ валиден · моделей: ${models.length}`
            : 'Ключ валиден',
          models,
          preferredModel: candidate,
        }
      }
      if (probe.status === 401 || probe.status === 403) {
        return {
          ok: false,
          message: `Ключ отклонён (${probe.status})`,
          models,
          preferredModel: '',
        }
      }
    }

    return {
      ok: true,
      message: models.length
        ? `Ключ валиден · моделей: ${models.length}`
        : 'Ключ валиден',
      models,
      preferredModel: model || models[0] || '',
    }
  } catch (error) {
    return {
      ok: false,
      message: 'Не удалось проверить: ' + (error?.message || 'сеть'),
      models: [],
      preferredModel: '',
    }
  }
}
