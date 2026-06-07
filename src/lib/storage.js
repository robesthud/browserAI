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

// Truncates large tool-call results before persisting. Keeps the chat
// history compact in localStorage without losing the visible summary —
// only file/bash payloads are clipped, everything else passes through.
function trimToolResult(name, result) {
  if (result == null || typeof result !== 'object') return result
  const MAX = 4 * 1024
  const clip = (s) => (typeof s === 'string' && s.length > MAX
    ? s.slice(0, MAX) + `\n... [сохранён фрагмент, ещё ${s.length - MAX} символов]`
    : s)
  if (name === 'read_file' && result.content) return { ...result, content: clip(result.content) }
  if (name === 'bash') return { ...result, stdout: clip(result.stdout), stderr: clip(result.stderr) }
  if (name === 'web_fetch' && result.content) return { ...result, content: clip(result.content) }
  return result
}

function trimChatsForStorage(chats) {
  return chats.map((c) => ({
    ...c,
    messages: (c.messages || []).map((m) => {
      if (!Array.isArray(m.toolCalls) || m.toolCalls.length === 0) return m
      return {
        ...m,
        toolCalls: m.toolCalls.map((tc) => ({
          ...tc,
          result: trimToolResult(tc.name, tc.result),
        })),
      }
    }),
  }))
}

export function saveChats(chats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(trimChatsForStorage(chats)))
  } catch (e) {
    if (e?.name === 'QuotaExceededError') {
      // localStorage переполнен — удаляем самые старые чаты (кроме последних 5) и пробуем снова
      console.warn('localStorage QuotaExceededError — обрезаем старые чаты')
      try {
        const trimmed = trimChatsForStorage(chats.slice(0, 5))
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
