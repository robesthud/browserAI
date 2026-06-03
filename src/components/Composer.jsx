import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconPaperclip,
  IconArrowRight,
  IconStop,
  IconClose,
  IconFile,
  IconFolder,
} from '../icons.jsx'
import { processFiles, formatSize } from '../lib/files.js'
import FileTree from './FileTree.jsx'
import { filterWorkspaceTree, workspaceApi } from '../lib/workspace.js'

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
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [busyFiles, setBusyFiles] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const fileInputRef = useRef(null)
  const taRef = useRef(null)

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

  const submit = () => {
    if (isStreaming) return
    const t = text.trim()
    if (!t && attachments.length === 0) return
    onSend(t, attachments)
    setText('')
    setAttachments([])
    // requestAnimationFrame — ждём пока React обновит DOM после setText('')
    // прежде чем сбрасывать высоту, иначе textarea может остаться растянутой
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
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }

  const wrapperClass = hasMessages
    ? 'w-full border-t border-white/5 bg-graphite-900/80 px-4 pt-4 pb-4 backdrop-blur pb-safe'
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
            className={`rounded-3xl border bg-graphite-800 p-4 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)] transition-colors
              ${dragOver ? 'border-cream/40 bg-graphite-750' : 'border-white/[0.06]'}`}
          >
            {attachments.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 rounded-lg border border-white/10 bg-graphite-750 px-2.5 py-1.5 text-[12px] text-cream-soft"
                    title={
                      a.error ||
                      (a.truncated ? 'Файл обрезан до 200 КБ' : a.path || a.name)
                    }
                  >
                    <span className="text-cream-dim">
                      <IconFile />
                    </span>
                    <span className="max-w-[160px] truncate">{a.name}</span>
                    <span className="text-cream-faint">{formatSize(a.size)}</span>
                    <button
                      onClick={() => removeAttachment(a.id)}
                      className="text-cream-faint transition-colors hover:text-cream"
                      title="Убрать"
                    >
                      <IconClose />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              ref={taRef}
              value={text}
              onChange={autoGrow}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Спросите что угодно…"
              className="block w-full resize-none border-0 bg-transparent px-2 pb-3 pt-1 text-[15px]
                         text-cream placeholder:text-cream-faint focus:outline-none focus:ring-0"
            />

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busyFiles}
                  className="flex items-center gap-2 rounded-full border border-white/10 px-3.5 py-2 text-[13px]
                           text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream
                           disabled:opacity-50 whitespace-nowrap"
                >
                  <IconPaperclip />
                  <span>{busyFiles ? 'Чтение…' : 'Файлы'}</span>
                </button>

                <button
                  onClick={() => setWorkspacePickerOpen(true)}
                  className="flex items-center gap-2 rounded-full border border-white/10 px-3.5 py-2 text-[13px]
                           text-cream-soft transition-colors hover:border-white/20 hover:bg-graphite-750 hover:text-cream
                           whitespace-nowrap"
                >
                  <IconFolder />
                  <span>Workspace</span>
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
