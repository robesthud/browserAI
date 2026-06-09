import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconPaperclip,
  IconArrowRight,
  IconStop,
  IconClose,
  IconFile,
  IconFolder,
  IconMic,
} from '../icons.jsx'
import { processFiles, formatSize } from '../lib/files.js'
import FileTree from './FileTree.jsx'
import { filterWorkspaceTree, workspaceApi } from '../lib/workspace.js'
import { runSlashCommand, parseMentions } from '../lib/slashCommands.js'
import SlashAutocomplete from './SlashAutocomplete.jsx'

function devtoolsEnabled() {
  try { return localStorage.getItem('browserai.devtools') === '1' }
  catch { return false }
}

function WorkspacePickerModal({ open, onClose, onPick }) {
  const [tree, setTree] = useState(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const data = await workspaceApi.getTree(false)
        if (!cancelled) setTree(data.tree)
      } catch (e) {
        if (!cancelled) setError(e.message || 'Не удалось загрузить workspace')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!tree) return null
    return filterWorkspaceTree(tree, search)
  }, [tree, search])

  const pickFile = async (node) => {
    const file = await workspaceApi.readFile(node.path)
    onPick({
      id: file.path || file.name,
      name: file.name,
      size: file.size,
      type: file.mime || 'application/octet-stream',
      text: file.kind === 'text' ? file.text : null,
      dataUrl: file.kind === 'image' || file.kind === 'pdf' ? file.dataUrl : null,
      fromWorkspace: true,
      path: file.path,
    })
    onClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-graphite-800 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3.5">
          <div className="text-[15px] text-cream">Выбрать файл из Workspace</div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750 hover:text-cream"
          >
            <IconClose />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск файла…"
            className="w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-[13px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
          />
          <div className="thin-scroll max-h-[55vh] overflow-y-auto rounded-xl border border-white/5 bg-graphite-900/40 p-2">
            {loading ? (
              <div className="px-3 py-3 text-[12px] text-cream-faint">Загрузка…</div>
            ) : error ? (
              <div className="px-3 py-3 text-[12px] text-red-300">⚠ {error}</div>
            ) : filtered?.children?.length ? (
              <FileTree
                data={filtered.children}
                activePath={null}
                onPreview={pickFile}
                onDownload={null}
                onContextMenu={null}
                onMove={null}
              />
            ) : (
              <div className="px-3 py-3 text-[12px] text-cream-faint">Файлы не найдены.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Composer({
  hasMessages,
  isStreaming,
  onSend,
  onStop,
  chatId = '',
  // Slash-command hooks — wired by App.jsx
  onSlashClear,
  onSlashSettings,
  onSlashSearch,
  onSlashCheckpoints,
  onSlashExport,
  onSlashToggleAgent,
  onSlashSetModel,
  onSlashFetchCost,
  onFlash,
}) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState([])
  const [busyFiles, setBusyFiles] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [autocompleteOpen, setAutocompleteOpen] = useState(true)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const fileInputRef = useRef(null)
  const taRef = useRef(null)
  const isDev = devtoolsEnabled()

  const addFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return
    setBusyFiles(true)
    try {
      const processed = await processFiles(fileList)
      setAttachments((prev) => [...prev, ...processed])
    } finally {
      setBusyFiles(false)
    }
  }

  const addWorkspaceAttachment = (file) => {
    setAttachments((prev) => {
      if (prev.some((a) => a.id === file.id)) return prev
      return [...prev, file]
    })
  }

  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const [isRecording, setIsRecording] = useState(false)
  const recognitionRef = useRef(null)
  const baseTextRef = useRef('')

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition()
      recognition.lang = 'ru-RU'
      recognition.interimResults = true
      recognition.continuous = false

      recognition.onstart = () => {
        setText(prev => {
          baseTextRef.current = prev
          return prev
        })
      }

      recognition.onresult = (e) => {
        let transcript = ''
        for (let i = 0; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript
        }
        
        setText(() => {
          const base = baseTextRef.current.trim()
          return (base ? base + ' ' : '') + transcript + (e.results[e.results.length - 1].isFinal ? '' : ' (Слушаю...)')
        })
      }

      recognition.onend = () => {
        setIsRecording(false)
        setText(prev => {
          const final = prev.replace(/\s*\(Слушаю...\)$/, '')
          baseTextRef.current = final
          return final
        })
      }

      recognition.onerror = () => {
        setIsRecording(false)
        setText(prev => {
          const final = prev.replace(/\s*\(Слушаю...\)$/, '')
          baseTextRef.current = final
          return final
        })
      }

      recognitionRef.current = recognition
    }
  }, [])

  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop()
      setIsRecording(false)
    } else {
      if (recognitionRef.current) {
        recognitionRef.current.start()
        setIsRecording(true)
      } else {
        alert("Голосовой ввод не поддерживается в этом браузере")
      }
    }
  }

  const submit = async () => {
    if (isStreaming) return
    let t = text.trim()
    if (!t && attachments.length === 0) return

    // ── Slash-command interception ──
    // If the first non-whitespace token is /<cmd>, route to runSlashCommand
    // which may either consume the input entirely or rewrite it.
    if (isDev && t.startsWith('/')) {
      try {
        const slashRes = await runSlashCommand(t, {
          newChat: onSlashClear,
          openSettings: onSlashSettings,
          openSearch: onSlashSearch,
          openCheckpoints: onSlashCheckpoints,
          onExportChat: onSlashExport,
          onToggleAgent: onSlashToggleAgent,
          onSetModel: onSlashSetModel,
          fetchCost: onSlashFetchCost,
          postFlash: onFlash,
        })
        if (slashRes.handled) {
          if (slashRes.send) {
            t = slashRes.send
          } else {
            // Pure side-effect command — clear input and bail.
            setText('')
            setAttachments([])
            requestAnimationFrame(() => {
              if (taRef.current) taRef.current.style.height = 'auto'
            })
            return
          }
        }
      } catch (e) {
        onFlash?.({ kind: 'err', text: 'Ошибка slash-команды: ' + (e?.message || String(e)) })
      }
    }

    // ── File mentions: @path turns into an inline attachment ──
    const { mentioned } = parseMentions(t)
    let finalAttachments = attachments
    if (mentioned.length) {
      try {
        const loaded = []
        for (const p of mentioned) {
          if (finalAttachments.some((a) => a.path === p)) continue
          const url = chatId
            ? `/api/workspace/file?path=${encodeURIComponent(p)}&chatId=${encodeURIComponent(chatId)}`
            : `/api/workspace/file?path=${encodeURIComponent(p)}`
          try {
            const r = await fetch(url, { credentials: 'include' })
            if (!r.ok) continue
            const j = await r.json()
            const content = j?.text || j?.content || ''
            if (!content) continue
            loaded.push({
              id: 'mention-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              name: p.split('/').pop(),
              path: p,
              type: j?.mime || 'text/plain',
              size: content.length,
              text: content.length > 32_000 ? content.slice(0, 32_000) : content,
              truncated: content.length > 32_000,
              dataUrl: null,
            })
          } catch { /* ignore individual file failures */ }
        }
        if (loaded.length) finalAttachments = [...finalAttachments, ...loaded]
      } catch { /* mentions are best-effort */ }
    }

    if (isRecording) {
      recognitionRef.current?.stop()
      setIsRecording(false)
    }
    baseTextRef.current = ''

    onSend(t, finalAttachments)
    setText('')
    setAttachments([])
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto'
    })
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const autoGrow = (e) => {
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
    setText(el.value)
    setCaret(el.selectionStart || el.value.length)
    setAutocompleteOpen(true)
  }

  // Apply a replacement from the slash/mention autocomplete.
  const acceptAutocomplete = (newText, newCaret) => {
    setText(newText)
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.value = newText
        taRef.current.selectionStart = taRef.current.selectionEnd = newCaret
        taRef.current.focus()
        taRef.current.style.height = 'auto'
        taRef.current.style.height = Math.min(taRef.current.scrollHeight, 220) + 'px'
      }
      setCaret(newCaret)
    })
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }

  const wrapperClass = hasMessages
    ? 'w-full border-t border-white/5 bg-graphite-900/80 px-2 pt-2 pb-2 backdrop-blur pb-safe md:px-4 md:pt-4 md:pb-4'
    : 'flex flex-1 flex-col items-center justify-center px-4 md:px-6'

  const innerClass = hasMessages ? 'mx-auto w-full max-w-2xl' : 'w-full max-w-2xl'

  return (
    <>
      <section className={wrapperClass}>
        <div className={innerClass}>
          {!hasMessages && (
            <h1 className="mb-6 text-center font-serif text-[32px] font-normal leading-tight text-cream sm:text-[38px] md:mb-8 md:text-[44px]">
              Добро пожаловать в чат с AI
            </h1>
          )}

          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`relative rounded-2xl border bg-graphite-800 p-2 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)] transition-colors md:rounded-3xl md:p-4
              ${dragOver ? 'border-cream/40 bg-graphite-750' : 'border-white/[0.06]'}`}
          >
            {isDev && autocompleteOpen && (
              <SlashAutocomplete
                text={text}
                caret={caret}
                chatId={chatId}
                onAccept={acceptAutocomplete}
                onClose={() => setAutocompleteOpen(false)}
              />
            )}
            {attachments.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {attachments.map((a) => {
                  const isImage = a.dataUrl && /^image\//.test(a.type || '')
                  return (
                    <div
                      key={a.id}
                      className="group relative flex items-center gap-2 rounded-lg border border-white/10 bg-graphite-750 px-2.5 py-1.5 text-[12px] text-cream-soft"
                      title={
                        a.error ||
                        (a.truncated ? 'Файл обрезан до 200 КБ' : a.path || a.name)
                      }
                    >
                      {isImage ? (
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          className="h-9 w-9 rounded object-cover"
                        />
                      ) : (
                        <span className="text-cream-dim"><IconFile /></span>
                      )}
                      <div className="flex min-w-0 flex-col">
                        <span className="max-w-[110px] truncate sm:max-w-[160px]">{a.name}</span>
                        <span className="text-[10px] text-cream-faint">
                          {formatSize(a.size)}
                        </span>
                      </div>
                      <button
                        onClick={() => removeAttachment(a.id)}
                        className="text-cream-faint transition-colors hover:text-cream"
                        title="Убрать"
                      >
                        <IconClose />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <textarea
              ref={taRef}
              value={text}
              onChange={autoGrow}
              onKeyDown={onKeyDown}
              onPaste={async (e) => {
                // Image paste from clipboard (Cmd/Ctrl-V on a screenshot)
                // → treat each pasted image as a real attachment without
                // any extra clicks. Plain text paste falls through to the
                // native textarea behaviour.
                const items = e.clipboardData?.items || []
                const imageFiles = []
                for (const it of items) {
                  if (it.kind === 'file' && /^image\//.test(it.type)) {
                    const f = it.getAsFile()
                    if (f) {
                      // Give pasted files a meaningful name (clipboard files
                      // come in as 'image.png' which collides if you paste
                      // twice in a row).
                      const ext = (it.type.split('/')[1] || 'png').toLowerCase()
                      const renamed = new File([f], `pasted-${Date.now()}.${ext}`, { type: it.type })
                      imageFiles.push(renamed)
                    }
                  }
                }
                if (imageFiles.length) {
                  e.preventDefault()
                  await addFiles(imageFiles)
                }
              }}
              rows={1}
              placeholder="Напишите сообщение…"
              className="block w-full resize-none border-0 bg-transparent px-2 pb-2 pt-1 text-[14px]
                         text-cream placeholder:text-cream-faint focus:outline-none focus:ring-0 md:pb-3 md:text-[15px]"
            />

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 md:gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busyFiles}
                  title={busyFiles ? 'Чтение…' : 'Прикрепить файл'}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-[13px]
                           text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream
                           disabled:opacity-50 md:h-auto md:w-auto md:gap-2 md:px-3.5 md:py-2"
                >
                  <IconPaperclip />
                  <span className="hidden md:inline">{busyFiles ? 'Чтение…' : 'Файлы'}</span>
                </button>

                <button
                  onClick={() => setWorkspacePickerOpen(true)}
                  title="Прикрепить из Workspace"
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-[13px]
                           text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream
                           md:h-auto md:w-auto md:gap-2 md:px-3.5 md:py-2"
                >
                  <IconFolder />
                  <span className="hidden md:inline">Из файлов</span>
                </button>

                <button
                  onClick={toggleRecording}
                  className={`grid h-9 w-9 place-items-center rounded-full border border-white/10 text-[13px] transition-colors md:h-[38px] md:w-[38px]
                           ${isRecording ? 'bg-red-500/20 text-red-400 border-red-500/30 animate-pulse' : 'text-cream-soft hover:border-white/20 hover:bg-graphite-750 hover:text-cream'}`}
                  title={isRecording ? "Остановить запись" : "Голосовой ввод"}
                >
                  <IconMic />
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files)
                  e.target.value = ''
                }}
              />

              <div className="flex items-center gap-2">
                {isStreaming ? (
                  <button
                    onClick={onStop}
                    className="grid h-9 w-9 place-items-center rounded-full bg-cream text-graphite-900
                               transition-transform hover:scale-105 active:scale-95"
                    title="Остановить"
                  >
                    <IconStop />
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={!text.trim() && attachments.length === 0}
                    className="grid h-9 w-9 place-items-center rounded-full bg-cream text-graphite-900
                               transition-transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
                    title="Отправить (Enter)"
                  >
                    <IconArrowRight />
                  </button>
                )}
              </div>
            </div>
          </div>

          {!hasMessages && (
            <p className="mt-3 text-center text-[12px] text-cream-faint">
              Enter — отправить, Shift+Enter — новая строка. Файлы можно перетащить
              сюда.
            </p>
          )}
        </div>
      </section>

      <WorkspacePickerModal
        open={workspacePickerOpen}
        onClose={() => setWorkspacePickerOpen(false)}
        onPick={addWorkspaceAttachment}
      />
    </>
  )
}
