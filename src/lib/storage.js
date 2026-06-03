// Персистентность чатов в localStorage.
// Структура чата:
// { id, title, createdAt, updatedAt, summary, summarizedUntil,
//   messages: [{ id, role, content, attachments?, error? }] }

import { uid } from './uid.js'

export { uid }

const KEY = 'browserai.chats.v1'

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
  } catch (e) {
    if (e?.name === 'QuotaExceededError') {
      // localStorage переполнен — удаляем самые старые чаты (кроме последних 5) и пробуем снова
      console.warn('localStorage QuotaExceededError — обрезаем старые чаты')
      try {
        const trimmed = chats.slice(0, 5)
        localStorage.setItem(KEY, JSON.stringify(trimmed))
      } catch {
        // совсем не можем сохранить — молча продолжаем
      }
    }
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

// Заголовок чата из первого сообщения пользователя.
// Обрезаем по последнему пробелу чтобы не резать слова посередине.
export function deriveTitle(text) {
  if (!text) return 'Новый чат'
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'Новый чат'
  if (clean.length <= 40) return clean
  const cut = clean.slice(0, 40)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…'
}
