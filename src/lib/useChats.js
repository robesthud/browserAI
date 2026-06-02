// Центральный хук управления чатами: список чатов, активный чат,
// отправка сообщений в API, стриминг, обработка ошибок, остановка.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadChats,
  saveChats,
  createChat,
  deriveTitle,
  uid,
} from './storage.js'
import { sendChat, summarizeConversation } from './api.js'
import { resolveActive } from './settings.js'

const SUMMARY_TRIGGER_MESSAGES = 14
const SUMMARY_KEEP_RECENT = 8
const RECENT_CONTEXT_MESSAGES = 10
const MAX_CONTEXT_CHARS = 18000

function messageSize(m) {
  let size = String(m.content || '').length
  for (const a of m.attachments || []) {
    if (a.text) size += a.text.length
    else size += (a.name || '').length + 40
  }
  return size
}

function buildContextWindow(history, memorySummary = '') {
  const recent = []
  let total = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i]
    const size = messageSize(msg)
    if (recent.length >= RECENT_CONTEXT_MESSAGES || (recent.length > 0 && total + size > MAX_CONTEXT_CHARS)) {
      break
    }
    total += size
    recent.unshift(msg)
  }
  return { recent, memorySummary }
}

export function useChats(settings) {
  // #9 FIX: вычисляем normalizedChats один раз — избегаем двойного чтения localStorage
  const normalizedChats = () =>
    loadChats().map((chat) => ({
      ...chat,
      summary: chat.summary || '',
      summarizedUntil: chat.summarizedUntil || 0,
    }))

  const [chats, setChats] = useState(() => {
    const initial = normalizedChats()
    return initial
  })
  const [activeId, setActiveId] = useState(() => {
    // Читаем localStorage только один раз — напрямую из того же вызова
    const initial = loadChats()
    return initial.length > 0 ? initial[0].id : null
  })
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef(null)

  // Персистентность
  useEffect(() => {
    saveChats(chats)
  }, [chats])

  const activeChat = chats.find((c) => c.id === activeId) || null

  const newChat = useCallback(() => {
    const chat = createChat()
    setChats((prev) => [chat, ...prev])
    setActiveId(chat.id)
    return chat.id
  }, [])

  const selectChat = useCallback((id) => {
    setActiveId(id)
  }, [])

  const deleteChat = useCallback(
    (id) => {
      setChats((prev) => {
        const next = prev.filter((c) => c.id !== id)
        if (id === activeId) {
          setActiveId(next[0]?.id ?? null)
        }
        return next
      })
    },
    [activeId],
  )

  const renameChat = useCallback((id, title) => {
    setChats((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c)),
    )
  }, [])

  const updateChat = useCallback((id, updater) => {
    setChats((prev) =>
      prev.map((c) => (c.id === id ? updater(c) : c)),
    )
  }, [])

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsStreaming(false)
  }, [])

  // Отправка сообщения. text + attachments[]
  const sendMessage = useCallback(
    async (text, attachments = []) => {
      const trimmed = (text || '').trim()
      if (!trimmed && attachments.length === 0) return

      // гарантируем активный чат
      let chatId = activeId
      if (!chatId) {
        chatId = newChat()
      }

      const userMsg = {
        id: uid(),
        role: 'user',
        content: trimmed,
        attachments,
      }
      const assistantMsg = {
        id: uid(),
        role: 'assistant',
        content: '',
        pending: true,
      }

      // добавляем сообщения и, если это первое — задаём заголовок.
      // историю для API строим из самого свежего состояния.
      let history = []
      let memorySummary = ''
      let summarizedUntil = 0
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c
          const isFirst = c.messages.length === 0
          history = [...c.messages, userMsg]
          memorySummary = c.summary || ''
          summarizedUntil = c.summarizedUntil || 0
          return {
            ...c,
            title: isFirst ? deriveTitle(trimmed) : c.title,
            updatedAt: Date.now(),
            summary: c.summary || '',
            summarizedUntil: c.summarizedUntil || 0,
            messages: [...c.messages, userMsg, assistantMsg],
          }
        }),
      )

      const controller = new AbortController()
      abortRef.current = controller
      setIsStreaming(true)

      const patchAssistant = (patch) => {
        setChats((prev) =>
          prev.map((c) => {
            if (c.id !== chatId) return c
            return {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) =>
                m.id === assistantMsg.id ? { ...m, ...patch } : m,
              ),
            }
          }),
        )
      }

      try {
        const resolved = resolveActive(settings)

        if (
          resolved.apiKey &&
          resolved.baseUrl &&
          resolved.model &&
          history.length > SUMMARY_TRIGGER_MESSAGES
        ) {
          const summarizeEnd = Math.max(summarizedUntil, history.length - SUMMARY_KEEP_RECENT)
          const segment = history.slice(summarizedUntil, summarizeEnd)
          if (segment.length > 0) {
            const nextSummary = await summarizeConversation({
              settings: resolved,
              messages: segment,
              previousSummary: memorySummary,
              signal: controller.signal,
            })
            memorySummary = nextSummary
            summarizedUntil = summarizeEnd
            setChats((prev) =>
              prev.map((c) =>
                c.id === chatId
                  ? { ...c, summary: nextSummary, summarizedUntil: summarizeEnd }
                  : c,
              ),
            )
          }
        }

        const { recent, memorySummary: contextSummary } = buildContextWindow(
          history,
          memorySummary,
        )

        let acc = ''
        await sendChat({
          settings: resolved,
          messages: recent,
          memorySummary: contextSummary,
          signal: controller.signal,
          onToken: (chunk) => {
            acc += chunk
            patchAssistant({ content: acc, pending: false })
          },
        })
        // #10 FIX: обновляем только если acc непустой, чтобы не затирать
        // контент, уже отрисованный через onToken при стриминге
        if (acc) patchAssistant({ content: acc, pending: false })
        else patchAssistant({ pending: false })
      } catch (err) {
        if (err.name === 'AbortError') {
          patchAssistant({ pending: false, stopped: true })
        } else {
          patchAssistant({
            pending: false,
            error: err.message || 'Неизвестная ошибка',
          })
        }
      } finally {
        abortRef.current = null
        setIsStreaming(false)
      }
    },
    [activeId, newChat, settings],
  )

  return {
    chats,
    activeChat,
    activeId,
    isStreaming,
    newChat,
    selectChat,
    deleteChat,
    renameChat,
    updateChat,
    sendMessage,
    stop,
  }
}
