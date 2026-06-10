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
import haptics from './haptics.js'
import { workspaceApi } from './workspace.js'
import { createJob, detectLongJobType, cancelJob } from './jobs.js'

const SUMMARY_TRIGGER_MESSAGES = 14
const SUMMARY_KEEP_RECENT = 8
const RECENT_CONTEXT_MESSAGES = 10
const MAX_CONTEXT_CHARS = 18000


function dataUrlToWorkspaceFile(dataUrl, index = 0) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s)
  if (!match) return null
  const mime = match[1] || 'application/octet-stream'
  const b64 = match[2] || ''
  const ext =
    mime.includes('png') ? 'png' :
    mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' :
    mime.includes('webp') ? 'webp' :
    mime.includes('gif') ? 'gif' :
    mime.includes('pdf') ? 'pdf' :
    mime.includes('presentation') || mime.includes('powerpoint') ? 'pptx' :
    mime.includes('mp4') ? 'mp4' :
    'bin'
  const stamp = String(Date.now())
  return {
    path: `generated-${stamp}-${index + 1}.${ext}`,
    name: `generated-${stamp}-${index + 1}.${ext}`,
    content: b64,
    type: mime,
  }
}

async function saveGeneratedMediaToWorkspace(chatId, text = '') {
  const urls = []
  const re = /(?:!\[[^\]]*\]\(|\[[^\]]+\]\()?(data:(?:image|application|video)\/[^)\s]+)\)?/g
  let m
  while ((m = re.exec(String(text || '')))) {
    if (!urls.includes(m[1])) urls.push(m[1])
  }
  if (!urls.length) return
  const files = urls.map(dataUrlToWorkspaceFile).filter(Boolean)
  if (!files.length) return
  workspaceApi.setChatId(chatId)
  await workspaceApi.uploadFiles('generated', files)
}

function messageSize(m) {
  let size = String(m.content || '').length
  for (const a of m.attachments || []) {
    if (a.text) size += a.text.length
    else size += (a.name || '').length + 40
  }
  return size
}

// Render a SHORT, model-readable description of a single tool call so it
// can be replayed into the next turn's history. Without this, the agent
// loses the memory of what it actually did last turn (read_file paths,
// edit_file paths, bash commands, etc.) and starts inventing "вот код
// который надо вставить" instead of editing the files it already touched.
function summarizeToolCallForHistory(tc) {
  if (!tc?.name) return ''
  const args = tc.args || {}
  let preview = ''
  if (args.path)         preview = args.path
  else if (args.command) preview = String(args.command).replace(/\s+/g, ' ').slice(0, 200)
  else if (args.query)   preview = `"${String(args.query).slice(0, 120)}"`
  else if (args.url)     preview = args.url
  else preview = Object.keys(args).slice(0, 3).map((k) => `${k}=…`).join(', ')

  const status = tc.status === 'done' ? (tc.ok ? '✓' : '✗') : '…'
  let outline = `${status} ${tc.name}(${preview})`

  // For some tools, include a few facts from the result so the model
  // knows what the disk now looks like.
  const r = tc.result
  if (!r && !tc.error) return outline

  const clip = (str, head = 1500, tail = 500) => {
    // Strip ANSI codes so LLM doesn't see garbage like \x1b[31m
    const s = String(str || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
    if (s.length <= head + tail + 100) return s
    return `${s.slice(0, head)}\n...[${s.length - head - tail} omitted]...\n${s.slice(-tail)}`
  }

  if (tc.name === 'edit_file' && r?.bytesWritten) outline += `  → ${r.bytesWritten}b written`
  else if (tc.name === 'write_file' && r?.bytesWritten) outline += `  → ${r.bytesWritten}b written`
  else if (tc.name === 'list_files' && Array.isArray(r?.entries)) {
    outline += `  → ${r.entries.length} entries:\n` + clip(r.entries.map(e => `${e.isDirectory ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n'))
  }
  else if (tc.name === 'read_file' && typeof r?.content === 'string') outline += `  → \n${clip(r.content, 2000, 1000)}`
  else if (tc.name === 'bash') outline += `  → exit ${r?.exitCode}\nSTDOUT:\n${clip(r?.stdout || '', 2000, 1000)}\nSTDERR:\n${clip(r?.stderr || '', 1000, 500)}`
  else if (tc.name === 'web_search' && Array.isArray(r?.results)) outline += `  → ${r.results.length} results\n${clip(JSON.stringify(r.results), 2000, 500)}`
  else if (tc.name === 'web_fetch') outline += `  → \n${clip(r?.text || '', 2000, 1000)}`
  else if (tc.name === 'download_url' && r?.savedPath) outline += `  → ${r.savedPath}`
  else if (tc.name === 'download_url' || tc.name === 'git_clone') {
    const dest = r?.savedPath || r?.destination || r?.path || '/workspace'
    const grounding = r?.postFetchGrounding || (r?.localProjects ? `Local projects: ${r.localProjects.length}` : '')
    outline += `  → SUCCESS. Files NOW LOCAL at ${dest}. 
**NEXT: ONLY use list_files / find_projects / read_file / search_files / local bash. DO NOT re-use remote download/git/web tools for this project. ${grounding}**`
  }
  
  if (tc.error) outline += `  ! ${String(tc.error).slice(0, 500)}`
  return outline
}

// Convert one stored chat message into the {role, content} pair we send
// to the LLM. For assistant messages, we PREPEND the tool-call history
// from the previous turn so the agent remembers what it already did
// (edit_file paths, bash commands, search results, …). This is the
// fix that lets the agent answer "что ты сделал?" honestly and stops it
// from re-running the same tools again because it forgot.
function messageToHistoryEntry(m) {
  if (m.role === 'user') {
    const atts = m.attachments || []
    const images = atts.filter((a) => a.dataUrl && /^image\//.test(a.type || ''))
    const others = atts.filter((a) => !(a.dataUrl && /^image\//.test(a.type || '')))

    // Multimodal path: build an OpenAI-compatible content[] array when
    // there are inline image attachments. Providers that don't support
    // vision will receive the text only — we keep a copy of the textual
    // description so the LLM still knows the image was sent.
    if (images.length) {
      const textParts = []
      if (m.content) textParts.push(m.content)
      if (others.length) {
        textParts.push('\nOther attachments:\n' + others.map((a) => `- ${a.name} (${a.type})`).join('\n'))
      }
      const content = []
      if (textParts.length) content.push({ type: 'text', text: textParts.join('\n') })
      for (const img of images) {
        // OpenAI / Anthropic / Gemini OpenAI-proxy all accept image_url
        // with a data: URI. Provider-side will route to its own vision
        // model automatically.
        content.push({ type: 'image_url', image_url: { url: img.dataUrl } })
      }
      return { role: 'user', content }
    }

const content = atts.length
      ? `${m.content || ''}\n\n<arena-system-message>\nThe user attached the following files:\n${atts.map((a) => a.name).join('\n')}\n</arena-system-message>`
      : (m.content || '')
    return { role: 'user', content: content.trim() }
  }
  // assistant
  const lines = []
  const tcs = Array.isArray(m.toolCalls) ? m.toolCalls : []
  if (tcs.length) {
    lines.push('[Tool calls I made on this turn:]')
    for (const tc of tcs) {
      const s = summarizeToolCallForHistory(tc)
      if (s) lines.push('  ' + s)
    }
    lines.push('')
  }
  if (m.content) lines.push(m.content)
  const job = m.job
  if (job) {
    const files = job.result?.files || []
    if (files.length) {
      lines.push('')
      lines.push(`[Job ${job.type} ${job.status}: produced ${files.join(', ')}]`)
    }
  }
  return { role: 'assistant', content: lines.join('\n').trim() || '(empty)' }
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

  const [workspaceRevision, setWorkspaceRevision] = useState(0)

  const [isStreaming, setIsStreaming] = useState(false)
  // Ids of long-running background jobs (gemini video/image, document gen).
  // The UI treats an active job like streaming: progress, locked input, Stop.
  const [activeJobs, setActiveJobs] = useState([])
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
    workspaceApi.initChatWorkspace(chat.id).catch(() => {})
    return chat.id
  }, [])

  const selectChat = useCallback((id) => {
    setActiveId(id)
    if (id) workspaceApi.initChatWorkspace(id).catch(() => {})
  }, [])

  const deleteChat = useCallback(
    (id) => {
      workspaceApi.deleteChatWorkspace(id).catch(() => {})
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

  // Branch from a specific message: create a NEW chat that contains every
  // message up to (and including) the chosen one, so the user can try a
  // different next prompt without losing the original chat thread. The
  // workspace is initialised fresh — branches don't share workspace state
  // because that would let one branch silently corrupt the other.
  const branchFromMessage = useCallback((chatId, messageId) => {
    const original = chats.find((c) => c.id === chatId)
    if (!original) return null
    const idx = (original.messages || []).findIndex((m) => m.id === messageId)
    if (idx === -1) return null
    const keep = original.messages.slice(0, idx + 1).map((m) => ({ ...m, pending: false }))
    const branch = createChat()
    branch.title = `↳ ${original.title || 'Branch'}`
    branch.messages = keep
    branch.summary = original.summary || ''
    setChats((prev) => [branch, ...prev])
    setActiveId(branch.id)
    workspaceApi.initChatWorkspace(branch.id).catch(() => {})
    return branch.id
  }, [chats])

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

  // Remove a job id from the active set (called by JobCard on terminal state).
  const markJobDone = useCallback((jobId) => {
    setActiveJobs((prev) => prev.filter((id) => id !== jobId))
  }, [])

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setActiveJobs((prev) => {
      prev.forEach((id) => { void cancelJob(id).catch(() => {}) })
      return []
    })
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

      // React may defer the state updater in concurrent/mobile WebView cases.
      // Do not send an empty provider history: at minimum include the current user turn.
      if (history.length === 0) {
        history = [userMsg]
      }

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
        const longJobType = detectLongJobType(trimmed, attachments)
        if (longJobType) {
          const data = await createJob({
            type: longJobType,
            title: longJobType.replace(/_/g, ' '),
            prompt: trimmed,
            chatId,
            model: 'gemini-2.5-pro',
            attachments,
          })
          patchAssistant({ pending: false, job: data.job, content: '' })
          if (data?.job?.id) setActiveJobs((prev) => prev.includes(data.job.id) ? prev : [...prev, data.job.id])
          return
        }

        // БАГ 3 ИСПРАВЛЕН: если авторежим передал overrideModel — используем его,
        // не дожидаясь пока React обновит settings через setState
        const baseResolved = resolveActive(settings)
        const resolved = overrideModel
          ? (typeof overrideModel === 'object'
              ? { ...baseResolved, ...overrideModel }
              : { ...baseResolved, model: overrideModel })
          : baseResolved

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
        if (acc) {
          patchAssistant({ content: acc, pending: false })
          saveGeneratedMediaToWorkspace(chatId, acc).catch(() => {})
        } else patchAssistant({ pending: false })
        haptics.success()
} catch (err) {
        if (err.name === 'AbortError') {
          patchAssistant({ pending: false, stopped: true })
          haptics.tap()
        } else {
          patchAssistant({
            pending: false,
            error: err.message === 'Failed to fetch' || err.message === 'Load failed' 
                   ? 'Связь с сервером BrowserAI прервана (проверьте интернет или VPN)' 
                   : err.message || 'Неизвестная ошибка',
          })
          haptics.error()
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
    async (text, attachments = [], overrideProvider = null) => {
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
      let chatSummary = ''
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c
          const isFirst = c.messages.length === 0
          history = [...c.messages, userMsg]
          chatSummary = c.summary || ''
          return {
            ...c,
            title: isFirst ? deriveTitle(trimmed) : c.title,
            updatedAt: Date.now(),
            messages: [...c.messages, userMsg, assistantMsg],
          }
        }),
      )

      if (history.length === 0) {
        history = [userMsg]
      }

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

      let streamAgent;
      try {
        const mod = await import('./agentStream.js');
        streamAgent = mod.streamAgent;
      } catch (err) {
        if (err.message?.includes('dynamically imported module') || err.name === 'TypeError') {
          window.location.reload();
          return;
        }
        throw err;
      }

      // Build the LLM history: same as chat but agent loop wants strict
      // role,content only. Drop the empty assistant placeholder we just
      // pushed.
      // CRITICAL: replay the assistant's tool calls inside the content
      // string (via messageToHistoryEntry) so the model REMEMBERS what
      // it actually did last turn — which files it edited, which bash
      // commands it ran, which downloads succeeded — instead of forgetting
      // and re-running everything or hallucinating a summary.
      const llmHistory = history.map(messageToHistoryEntry)

      // Provider config — same resolution the regular chat uses, so the
      // agent talks to whatever the user selected in Settings (DeepSeek
      // managed, OpenAI, BigModel, Groq, etc.).
      const active = overrideProvider && typeof overrideProvider === 'object'
        ? { ...resolveActive(settings), ...overrideProvider }
        : (resolveActive(settings) || {})

      // Persistent extraSystem: chat-level summary if it exists (we re-use
      // the same one chat-mode computes), plus an early-turn marker so the
      // server knows it can auto-read project rules (AGENTS.md, README.md,
      // package.json) before the model starts working.
      const extraSystemParts = []
      if (chatSummary) {
        extraSystemParts.push(`# Earlier conversation summary\n\n${chatSummary}`)
      }
      if (history.length <= 2) {
        // First user turn → ask the server to inject project context.
        extraSystemParts.push('[browserai-first-turn]')
      }

      try {
        await new Promise((resolve) => {
          streamAgent({
            chatId,
            history: llmHistory,
            extraSystem: extraSystemParts.join('\n\n'),
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
                case 'stream_protocol':
                  patchAssistant((m) => ({ ...m, streamProtocol: data.payload || data }))
                  break
                case 'agent_context':
                  patchAssistant((m) => ({ ...m, agentContext: data.payload || data }))
                  break
                case 'agent_state':
                  patchAssistant((m) => ({ ...m, agentState: data.payload || data }))
                  break
                case 'tool_router':
                  patchAssistant((m) => ({
                    ...m,
                    routerWarnings: [
                      ...(m.routerWarnings || []),
                      { step: data.step, sub: data.sub, name: data.name, warnings: data.warnings || [] },
                    ],
                  }))
                  break
                case 'thinking':
                  // Optional: we could surface a "thinking" indicator
                  break
                case 'tool_preview':
                  // Mid-stream XML closer detected: the LLM has just
                  // finished writing a tool call but the server hasn't
                  // started executing yet. Show a 'queued' pill so the
                  // user sees a response within ms instead of waiting
                  // for the full assistant message to land.
                  patchAssistant((m) => {
                    const id = `${data.step}-${data.name}`
                    if ((m.toolCalls || []).some((tc) => tc.id === id)) return m
                    return {
                      ...m,
                      pending: true,
                      toolCalls: [
                        ...(m.toolCalls || []),
                        {
                          id, step: data.step, name: data.name, args: data.args,
                          status: 'queued', startedAt: Date.now(),
                        },
                      ],
                    }
                  })
                  break
                case 'tool_start':
                  patchAssistant((m) => {
                    const id = `${data.step}-${data.name}`
                    const existing = (m.toolCalls || []).find((tc) => tc.id === id)
                    if (existing) {
                      // tool_preview already created the pill — flip status.
                      return {
                        ...m,
                        pending: true,
                        toolCalls: m.toolCalls.map((tc) =>
                          tc.id === id ? { ...tc, status: 'running', startedAt: Date.now() } : tc,
                        ),
                      }
                    }
                    return {
                      ...m,
                      pending: true,
                      toolCalls: [
                        ...(m.toolCalls || []),
                        {
                          id, step: data.step, name: data.name, args: data.args,
                          status: 'running', startedAt: Date.now(),
                        },
                      ],
                    }
                  })
                  break
                case 'tool_result':
                  patchAssistant((m) => ({
                    ...m,
                    toolCalls: (m.toolCalls || []).map((tc) =>
                      tc.step === data.step && tc.name === data.name
                        ? { ...tc, status: 'done', ok: data.ok, result: data.result, error: data.error, structured: data.structured, finishedAt: Date.now() }
                        : tc,
                    ),
                  }))
                  if (['bash', 'write_file', 'edit_file', 'download_url', 'delete_file'].includes(data.name)) {
                    setWorkspaceRevision(Date.now())
                  }
                  // Small haptic so the user can feel progress in long
                  // agent runs even without looking at the screen.
                  haptics.tap()
                  break
                case 'tool_diagnostic':
                  // Inline syntax-check failed after a write/edit — flag
                  // the matching toolCall so AgentToolBlock can paint an
                  // amber pill and surface the message.
                  patchAssistant((m) => ({
                    ...m,
                    toolCalls: (m.toolCalls || []).map((tc) =>
                      tc.step === data.step && tc.name === data.name
                        ? { ...tc, diagnostic: { path: data.path, error: data.error } }
                        : tc,
                    ),
                  }))
                  break
                case 'tool_progress':
                  // Live stdout/stderr chunks from long bash / verify_code
                  // calls — appended to the matching toolCall so the
                  // AgentToolBlock can render a streaming tail instead of
                  // staying empty until the command finishes.
                  patchAssistant((m) => ({
                    ...m,
                    toolCalls: (m.toolCalls || []).map((tc) =>
                      tc.step === data.step && tc.name === data.name
                        ? {
                            ...tc,
                            stream: ((tc.stream || '') + String(data.chunk || '')).slice(-8000),
                          }
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
                case 'thinking_delta':
                  // Provider-side "extended thinking" stream — Anthropic
                  // delta.reasoning, OpenAI o1/o3 reasoning, DeepSeek-R1
                  // reasoning_content. Chunks arrive char-by-char and we
                  // append them into a single thinking buffer that the
                  // UI renders as a collapsed "💭 Размышления" block
                  // distinct from the regular thoughts (which are
                  // narrative one-liners written into the system stream).
                  patchAssistant((m) => ({
                    ...m,
                    thinking: ((m.thinking || '') + String(data.chunk || '')).slice(-32000),
                  }))
                  break
                case 'ask_user':
                  // Open question card inline in the assistant message.
                  // The user will submit via /api/agent/answer, which
                  // resolves the server-side promise; the agent loop
                  // then continues and we'll see a tool_result with the
                  // selection echoed back (which is fine — we just
                  // ignore it, the card is already shown).
                  patchAssistant((m) => ({
                    ...m,
                    askUsers: [
                      ...(m.askUsers || []),
                      {
                        id: data.question_id,
                        step: data.step,
                        question: data.question,
                        options: data.options || [],
                        multi: data.multi !== false,
                        allowCustom: data.allow_custom !== false,
                        expiresAt: data.expiresAt || null,
                        answered: false,
                        answer: null,
                      },
                    ],
                  }))
                  haptics.warning()
                  break
                case 'tool_approval':
                  // Server is asking the user to approve / deny a tool
                  // call (bash, git, deploy, mcp …). We piggy-back on
                  // the askUsers[] array so the same answer-channel
                  // wiring works. The component just shows a different
                  // visual treatment when kind === 'approval'.
                  patchAssistant((m) => ({
                    ...m,
                    askUsers: [
                      ...(m.askUsers || []),
                      {
                        id: data.question_id,
                        step: data.step,
                        kind: 'approval',
                        tool: data.tool,
                        category: data.category,
                        args: data.args || {},
                        question: `Разрешить вызов «${data.tool}» (${data.category})?`,
                        options: ['approve', 'deny'],
                        multi: false,
                        allowCustom: false,
                        expiresAt: data.expiresAt || null,
                        answered: false,
                        answer: null,
                      },
                    ],
                  }))
                  haptics.warning()
                  break
                case 'assistant_delta':
                  // Streaming chunk of the final answer — appended to
                  // the bubble live to give a typing-animation feel even
                  // when the upstream provider didn't expose true SSE.
                  patchAssistant((m) => ({
                    ...m,
                    content: (m.content || '') + String(data.chunk || ''),
                  }))
                  break
                case 'assistant':
                  // Snap to the canonical final string (may differ from
                  // the concatenated deltas by 1-2 chars due to chunk-split).
                  patchAssistant({ content: data.text || '', pending: false })
                  saveGeneratedMediaToWorkspace(chatId, data.text || '').catch(() => {})
                  haptics.success()
                  break
                case 'error':
                  patchAssistant((m) => ({ ...m, error: data.message || 'agent error', providerError: data.providerError || null, pending: false }))
                  haptics.error()
                  break
                case 'usage':
                  // Stream token totals from the server. The full counter
                  // lives on the assistant message so it survives a reload.
                  // reasoningTokens (Claude thinking_tokens / OpenAI o1
                  // reasoning_tokens / DeepSeek R1) gets surfaced inside
                  // the same tokens object so the AgentExtendedThinking
                  // pill can show "N reasoning tok" next to the toggle.
                  patchAssistant((m) => {
                    const base = data.totals || {
                      prompt:     data.prompt,
                      completion: data.completion,
                      total:      data.total,
                    }
                    const reasoningTokens = Number(
                      data.reasoningTokens
                      || data.totals?.reasoningTokens
                      || m.tokens?.reasoningTokens
                      || 0,
                    )
                    return {
                      ...m,
                      tokens: { ...base, reasoningTokens },
                    }
                  })
                  break
                case 'done':
                  patchAssistant((m) => ({
                    ...m,
                    pending: false,
                    tokens: data.tokens || m.tokens,
                    finishReason: data.reason || m.finishReason,
                  }))
                  resolve()
                  break
              }
            },
          })
        })
      } catch (e) {
        patchAssistant({ pending: false, error: e?.message || 'agent crashed' })
        haptics.error()
      } finally {
        abortRef.current = null
        setIsStreaming(false)
      }
    },
    [activeId, newChat, settings],
  )

  // Submit an answer to an `ask_user` question the agent posed earlier.
  // Resolves the server-side promise so the agent loop continues. We also
  // mark the question card as answered locally so the user sees feedback.
  const answerAgentQuestion = useCallback(async (chatId, messageId, questionId, payload) => {
    try {
      await fetch('/api/agent/answer', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: questionId, answer: payload }),
      })
    } catch (e) {
      console.warn('answerAgentQuestion failed:', e?.message || e)
    }
    setChats((prev) => prev.map((c) => c.id !== chatId ? c : {
      ...c,
      messages: c.messages.map((m) => {
        if (m.id !== messageId) return m
        return {
          ...m,
          askUsers: (m.askUsers || []).map((q) =>
            q.id === questionId ? { ...q, answered: true, answer: payload } : q,
          ),
        }
      }),
    }))
    haptics.tap()
  }, [])


  const cancelAgentQuestion = useCallback(async (chatId, messageId, questionId, reason = 'cancelled by user') => {
    try {
      await fetch(`/api/agent/questions/${encodeURIComponent(questionId)}/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
    } catch (e) {
      console.warn('cancelAgentQuestion failed:', e?.message || e)
    }
    setChats((prev) => prev.map((c) => c.id !== chatId ? c : {
      ...c,
      messages: c.messages.map((m) => {
        if (m.id !== messageId) return m
        return {
          ...m,
          askUsers: (m.askUsers || []).map((q) =>
            q.id === questionId ? { ...q, answered: true, answer: { selected: ['cancelled'], custom: reason }, cancelled: true } : q,
          ),
        }
      }),
    }))
    haptics.tap()
  }, [])

  return {
    chats,
    activeChat,
    workspaceRevision,
    activeId,
    isStreaming,
    jobBusy: activeJobs.length > 0,
    markJobDone,
    newChat,
    selectChat,
    deleteChat,
    renameChat,
    branchFromMessage,
    updateChat,
    sendMessage,
    sendAgentMessage,
    answerAgentQuestion,
    cancelAgentQuestion,
    stop,
  }
}
