async function req(path, options = {}) {
  const res = await fetch(`/api/jobs${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`))
  return res.json()
}

export function createJob(payload) {
  return req('', { method: 'POST', body: JSON.stringify(payload) })
}

export function getJob(id) {
  return req(`/${encodeURIComponent(id)}`)
}

export function cancelJob(id) {
  return req(`/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

export function retryJob(id) {
  return req(`/${encodeURIComponent(id)}/retry`, { method: 'POST' })
}

export function createToolJob({ tool, args = {}, chatId = '', title = '' }) {
  return req('/tool', { method: 'POST', body: JSON.stringify({ tool, args, chatId, title }) })
}

export function createAgentJob(payload = {}) {
  return req('/agent', { method: 'POST', body: JSON.stringify(payload) })
}

export function retryVideoJob(id) {
  return req(`/${encodeURIComponent(id)}/retry-video`, { method: 'POST' })
}

export function listJobs(chatId = '') {
  return req(`?chatId=${encodeURIComponent(chatId)}`)
}

export function detectLongJobType(text = '', attachments = []) {
  const lower = String(text || '').toLowerCase()
  const hasImage = attachments.some((a) => String(a.type || '').startsWith('image/') || String(a.dataUrl || '').startsWith('data:image/'))
  if (/(оживи|анимируй|анимац|сделай видео|создай видео|сгенерируй видео|video|animate)/i.test(lower)) {
    return hasImage ? 'gemini_video' : 'gemini_video'
  }
  if (/(презентац|pptx|slides|слайды)/i.test(lower)) return 'generate_presentation'
  if (/(pdf|пдф|отч[её]т|документ)/i.test(lower) && /(создай|сделай|сгенерируй|подготовь)/i.test(lower)) return 'generate_pdf'
  if (/(docx|word|документ)/i.test(lower) && /(создай|сделай|сгенерируй|подготовь)/i.test(lower)) return 'generate_docx'
  if (/(xlsx|excel|таблиц)/i.test(lower) && /(создай|сделай|сгенерируй|подготовь)/i.test(lower)) return 'generate_xlsx'
  if (/(запусти агента в фоне|фоновый агент|background agent)/i.test(lower)) return 'agent_run'
  if (/(проверь проект|полная проверка|verify task|верифицируй)/i.test(lower)) return 'tool_verify_task'
  if (/(scan secrets|секрет|токен).*?(проверь|найди|scan)/i.test(lower)) return 'tool_secret_scan'
  return null
}
