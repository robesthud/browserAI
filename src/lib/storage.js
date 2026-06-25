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

// UI-side token masking — mirrors server's redactSecrets in agentLoop.js
// Prevents tokens typed in chat from persisting in localStorage / DOM
const TOKEN_PATTERNS = [
  /github_pat_[A-Za-z0-9_]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /\bfff[0-9a-f]{5}-[0-9a-f-]{30,}/g,  // Railway-style UUID tokens
]
function redactForStorage(text = '') {
  let s = String(text || '')
  for (const re of TOKEN_PATTERNS) {
    s = s.replace(re, '<redacted>')
    re.lastIndex = 0
  }
  return s
}
function redactMessageContent(m) {
  if (!m || m.role !== 'user') return m
  if (typeof m.content === 'string') {
    const r = redactForStorage(m.content)
    return r === m.content ? m : { ...m, content: r }
  }
  return m
}

const MAX_STORED_ATTACHMENT_TEXT = 32 * 1024
const MAX_STORED_DATA_URL = 256 * 1024

function trimAttachmentForStorage(a) {
  if (!a || typeof a !== 'object') return a
  const next = { ...a }

  if (typeof next.text === 'string') {
    const redacted = redactForStorage(next.text)
    next.text = redacted.length > MAX_STORED_ATTACHMENT_TEXT
      ? redacted.slice(0, MAX_STORED_ATTACHMENT_TEXT) + `\n... [attachment text clipped for local storage, ${redacted.length - MAX_STORED_ATTACHMENT_TEXT} chars omitted]`
      : redacted
    next.truncated = Boolean(next.truncated || redacted.length > MAX_STORED_ATTACHMENT_TEXT)
  }

  if (typeof next.dataUrl === 'string' && next.dataUrl.length > MAX_STORED_DATA_URL) {
    // Keep metadata/path visible in chat history, but do not persist multi-MB
    // base64 blobs in localStorage. The in-memory message still contains the
    // dataUrl during the current send; only the saved history is compacted.
    next.dataUrl = null
    next.omittedFromStorage = true
  }

  return next
}

function trimChatsForStorage(chats) {
  return chats.map((c) => ({
    ...c,
    messages: (c.messages || []).map((m) => {
      const rm = redactMessageContent(m)  // mask tokens in user messages before localStorage
      const base = Array.isArray(rm.attachments) && rm.attachments.length > 0
        ? { ...rm, attachments: rm.attachments.map(trimAttachmentForStorage) }
        : rm
      if (!Array.isArray(base.toolCalls) || base.toolCalls.length === 0) return base
      return {
        ...base,
        toolCalls: base.toolCalls.map((tc) => ({
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
