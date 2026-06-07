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
  const saveTimeoutRef = useRef(null)

  // Персистентность с дебаунсом — не пишем localStorage на каждый токен стриминга
  useEffect(() => {
    clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => saveChats(chats), 800)
    return () => clearTimeout(saveTimeoutRef.current)
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

  // Отправка сообщения. text + attachments[] + overrideModel (для авторежима)
  const sendMessage = useCallback(
    async (text, attachments = [], overrideModel = null) => {
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
        // БАГ 3 ИСПРАВЛЕН: если авторежим передал overrideModel — используем его,
        // не дожидаясь пока React обновит settings через setState
        const resolved = overrideModel
          ? { ...resolveActive(settings), model: overrideModel }
          : resolveActive(settings)

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

  // ── Agent mode: streams /api/agent/chat and updates the assistant
  // message in place as tool calls / final answer come in. The history
  // sent to the server is just role+content; tool calls live on the
  // *client* assistant message as m.toolCalls[].
  const sendAgentMessage = useCallback(
    async (text, attachments = []) => {
      const trimmed = (text || '').trim()
      if (!trimmed && attachments.length === 0) return

      let chatId = activeId
      if (!chatId) chatId = newChat()

      const userMsg = { id: uid(), role: 'user', content: trimmed, attachments }
      const assistantMsg = {
        id: uid(),
        role: 'assistant',
        content: '',
        pending: true,
        toolCalls: [],
        agent: true,
      }

      let history = []
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c
          const isFirst = c.messages.length === 0
          history = [...c.messages, userMsg]
          return {
            ...c,
            title: isFirst ? deriveTitle(trimmed) : c.title,
            updatedAt: Date.now(),
            messages: [...c.messages, userMsg, assistantMsg],
          }
        }),
      )

      const controller = new AbortController()
      abortRef.current = controller
      setIsStreaming(true)

      const patchAssistant = (patch) => {
        setChats((prev) =>
          prev.map((c) =>
            c.id !== chatId
              ? c
              : {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === assistantMsg.id ? (typeof patch === 'function' ? patch(m) : { ...m, ...patch }) : m,
                  ),
                },
          ),
        )
      }

      const { streamAgent } = await import('./agentStream.js')

      // Build the LLM history: same as chat but agent loop wants strict
      // role,content only. Drop the empty assistant placeholder we just
      // pushed.
      const llmHistory = history.map((m) => ({
        role: m.role,
        content: m.role === 'user'
          ? (m.attachments?.length
              ? `${m.content || ''}\n\nAttachments:\n${m.attachments.map((a) => `- ${a.name} (${a.type})`).join('\n')}`
              : (m.content || ''))
          : (m.content || ''),
      }))

      // Provider config — same resolution the regular chat uses, so the
      // agent talks to whatever the user selected in Settings (DeepSeek
      // managed, OpenAI, BigModel, Groq, etc.).
      const active = resolveActive(settings) || {}

      try {
        await new Promise((resolve) => {
          streamAgent({
            history: llmHistory,
            provider: {
              baseUrl:      active.baseUrl,
              apiKey:       active.apiKey,
              authType:     active.authType || 'bearer',
              authHeader:   active.authHeader || '',
              extraHeaders: active.extraHeaders || {},
              model:        active.model,
              temperature:  Number(active.temperature ?? 0.3),
            },
            signal: controller.signal,
            onEvent: (kind, data) => {
              switch (kind) {
                case 'thinking':
                  // Optional: we could surface a "thinking" indicator
                  break
                case 'tool_start':
                  patchAssistant((m) => ({
                    ...m,
                    pending: true,
                    toolCalls: [
                      ...(m.toolCalls || []),
                      {
                        id: `${data.step}-${data.name}`,
                        step: data.step,
                        name: data.name,
                        args: data.args,
                        status: 'running',
                        startedAt: Date.now(),
                      },
                    ],
                  }))
                  break
                case 'tool_result':
                  patchAssistant((m) => ({
                    ...m,
                    toolCalls: (m.toolCalls || []).map((tc) =>
                      tc.step === data.step && tc.name === data.name
                        ? { ...tc, status: 'done', ok: data.ok, result: data.result, error: data.error, finishedAt: Date.now() }
                        : tc,
                    ),
                  }))
                  break
                case 'thought':
                  // Streaming reasoning between tool calls — the model's
                  // intermediate "I'll do X next" / "Now I'll Y" text.
                  // Appended to the assistant thoughts[] array so the UI
                  // can interleave them with toolCalls in order.
                  patchAssistant((m) => ({
                    ...m,
                    thoughts: [
                      ...(m.thoughts || []),
                      { step: data.step, text: data.text || '', at: Date.now() },
                    ],
                  }))
                  break
                case 'assistant':
                  patchAssistant({ content: data.text || '', pending: false })
                  break
                case 'error':
                  patchAssistant((m) => ({ ...m, error: data.message || 'agent error', pending: false }))
                  break
                case 'done':
                  patchAssistant({ pending: false })
                  resolve()
                  break
              }
            },
          })
        })
      } catch (e) {
        patchAssistant({ pending: false, error: e?.message || 'agent crashed' })
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
    sendAgentMessage,
    stop,
  }
}
