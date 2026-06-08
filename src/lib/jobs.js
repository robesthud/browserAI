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
  return null
}
