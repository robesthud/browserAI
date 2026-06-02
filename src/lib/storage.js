// Персистентность чатов в localStorage.
// Структура чата:
// { id, title, createdAt, updatedAt, summary, summarizedUntil,
//   messages: [{ id, role, content, attachments?, error? }] }

const KEY = 'browserai.chats.v1'

// #18 FIX: crypto.randomUUID() вместо Date.now + Math.random
export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export function loadChats() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveChats(chats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(chats))
  } catch {
    // ignore
  }
}

export function createChat() {
  const now = Date.now()
  return {
    id: uid(),
    title: 'Новый чат',
    createdAt: now,
    updatedAt: now,
    summary: '',
    summarizedUntil: 0,
    messages: [],
  }
}

// Заголовок чата из первого сообщения пользователя
export function deriveTitle(text) {
  if (!text) return 'Новый чат'
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 40 ? clean.slice(0, 40) + '…' : clean || 'Новый чат'
}
