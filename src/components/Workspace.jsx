import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconClose,
  IconUpload,
  IconNewChat,
  IconFolder,
} from '../icons.jsx'
import FileTree from './FileTree.jsx'
import FilePreview from './FilePreview.jsx'
import {
  filterWorkspaceTree,
  serializeUploadFiles,
  workspaceApi,
} from '../lib/workspace.js'
import { sendChat } from '../lib/api.js'
import { resolveActive } from '../lib/settings.js'

function downloadFile(file) {
  const link = document.createElement('a')
  link.href = workspaceApi.downloadUrl(file.path)
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function stripCodeFence(text = '') {
  const trimmed = String(text || '').trim()
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  return match ? match[1] : trimmed
}

function splitTargetPath(targetPath = '') {
  const clean = String(targetPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = clean.split('/').filter(Boolean)
  return {
    path: clean,
    name: parts.pop() || '',
    parentPath: parts.join('/'),
  }
}

function toChatAttachment(file) {
  return {
    id: file.path || file.name,
    name: file.name,
    size: file.size,
    type: file.mime || 'application/octet-stream',
    text: file.kind === 'text' ? file.text : null,
    dataUrl: file.kind === 'image' || file.kind === 'pdf' ? file.dataUrl : null,
    fromWorkspace: true,
    path: file.path,
  }
}

function parsePatchResponse(text) {
  const cleaned = stripCodeFence(text)
  const parsed = JSON.parse(cleaned)
  const patches = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.patches)
      ? parsed.patches
      : []

  if (!patches.length) {
    throw new Error('AI не вернул patch-инструкции')
  }

  return patches.map((patch, index) => {
    const search = String(patch.search ?? '')
    const replace = String(patch.replace ?? '')
    if (!search) {
      throw new Error(`Пустой search в patch #${index + 1}`)
    }
    return { search, replace }
  })
}

function applyPatches(source, patches) {
  let result = String(source || '')
  for (const patch of patches) {
    if (!result.includes(patch.search)) {
      throw new Error(`Не найден фрагмент для patch: ${patch.search.slice(0, 80)}`)
    }
    result = result.replace(patch.search, patch.replace)
  }
  return result
}

function ContextMenu({ state, onClose, onAction }) {
  if (!state) return null
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 min-w-[220px] rounded-xl border border-white/10 bg-graphite-800 p-1.5 shadow-2xl"
        style={{ left: state.x, top: state.y }}
      >
        {state.items.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              onAction(item.id, state.node)
              onClose()
            }}
            className={`mb-1 flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] transition-colors last:mb-0 ${
              item.danger
                ? 'text-red-300 hover:bg-red-500/10'
                : 'text-cream-soft hover:bg-graphite-750 hover:text-cream'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  )
}

export default function Workspace({ open, onClose, settings, onSendToChat, onAiBusyChange }) {
  const [showHidden, setShowHidden] = useState(false)
  const [search, setSearch] = useState('')
  const [contentQuery, setContentQuery] = useState('')
  const [contentResults, setContentResults] = useState([])
  const [searchingContent, setSearchingContent] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewStartEditing, setPreviewStartEditing] = useState(false)
  const [tree, setTree] = useState(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(null)
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await workspaceApi.getTree(showHidden)
      setTree(data.tree)
    } catch (e) {
      setError(e.message || 'Не удалось загрузить workspace')
    } finally {
      setLoading(false)
    }
  }, [showHidden])

  useEffect(() => {
    onAiBusyChange?.(aiBusy)
  }, [aiBusy, onAiBusyChange])

  useEffect(() => {
    if (!open) return undefined
    const id = setTimeout(() => {
      void refresh()
    }, 0)
    return () => clearTimeout(id)
  }, [open, refresh])

  const filteredTree = useMemo(() => {
    if (!tree) return null
    return filterWorkspaceTree(tree, search)
  }, [tree, search])

  const nodes = filteredTree?.children || []
  const hasFiles = nodes.length > 0
  const openWidth = 'w-[300px]'
  const innerWidth = 'w-[300px]'

  const upload = async (fileList, parentPath = '') => {
    if (!fileList?.length) return
    setUploading(true)
    setError('')
    try {
      const files = await serializeUploadFiles(fileList)
      await workspaceApi.uploadFiles(parentPath, files)
      await refresh()
    } catch (e) {
      setError(e.message || 'Не удалось загрузить файлы')
    } finally {
      setUploading(false)
    }
  }

  const uploadByUrl = async (parentPath = '') => {
    const url = prompt('Ссылка на файл или архив', 'https://')
    if (!url) return
    setUploading(true)
    setError('')
    try {
      await workspaceApi.uploadFromUrl(parentPath, url)
      await refresh()
    } catch (e) {
      setError(e.message || 'Не удалось загрузить по URL')
    } finally {
      setUploading(false)
    }
  }

  const runContentSearch = useCallback(async () => {
    const q = contentQuery.trim()
    if (!q) {
      setContentResults([])
      return
    }
    setSearchingContent(true)
    try {
      const data = await workspaceApi.searchContent(q, showHidden)
      setContentResults(data.results || [])
    } catch (e) {
      setError(e.message || 'Не удалось выполнить поиск по содержимому')
    } finally {
      setSearchingContent(false)
    }
  }, [contentQuery, showHidden])

  const withHistory = async (file) => {
    if (file.kind !== 'text') return file
    try {
      const history = await workspaceApi.getHistory(file.path)
      return { ...file, history: history.items || [] }
    } catch {
      return { ...file, history: [] }
    }
  }

  const openPreview = async (node, options = {}) => {
    try {
      const file = await workspaceApi.readFile(node.path)
      setPreview(await withHistory(file))
      setPreviewStartEditing(Boolean(options.edit))
    } catch (e) {
      setError(e.message || 'Не удалось открыть файл')
    }
  }

  const savePreviewFile = async (file, content) => {
    await workspaceApi.saveFile(file.path, content)
    const updated = await workspaceApi.readFile(file.path)
    setPreview(await withHistory(updated))
    await refresh()
  }

  const ensureAiAvailable = () => {
    const resolved = resolveActive(settings)
    if (!resolved.apiKey || !resolved.baseUrl || !resolved.model) {
      throw new Error('Сначала настрой API-ключ и выбери модель')
    }
    return { ...resolved, stream: false }
  }

  const createFileWithAi = async (basePath = '') => {
    const target = prompt(
      'Путь нового файла',
      basePath ? `${basePath}/new-file.txt` : 'new-file.txt',
    )
    if (!target) return

    const instruction = prompt('Что должен содержать файл?', 'Создай полезный стартовый файл')
    if (!instruction) return

    const { path } = splitTargetPath(target)
    if (!path) return

    setAiBusy(true)
    setError('')
    try {
      const response = await sendChat({
        settings: ensureAiAvailable(),
        messages: [
          {
            role: 'user',
            content:
              `Сгенерируй содержимое файла "${path}". ` +
              'Верни только итоговое содержимое файла без markdown-ограждений, пояснений и комментариев вне файла.\n\n' +
              `Инструкция: ${instruction}`,
          },
        ],
        agentMode: false,
      })
      await workspaceApi.saveFile(path, stripCodeFence(response))
      await refresh()
      await openPreview({ path }, {})
    } catch (e) {
      setError(e.message || 'Не удалось создать файл через AI')
    } finally {
      setAiBusy(false)
    }
  }

  const applyAiPatch = async (file) => {
    const source = file.kind === 'text' ? file : await workspaceApi.readFile(file.path)
    if (source.kind !== 'text') {
      throw new Error('AI patch доступен только для текстовых файлов')
    }

    const instruction = prompt('Как изменить файл через patch?', 'Добавь улучшения и не переписывай файл полностью')
    if (!instruction) return

    setAiBusy(true)
    setError('')
    try {
      const response = await sendChat({
        settings: ensureAiAvailable(),
        messages: [
          {
            role: 'user',
            content:
              `Сделай минимальные точечные изменения в файле "${source.path}". ` +
              'Верни ТОЛЬКО JSON-массив patch-объектов вида [{"search":"...","replace":"..."}] без markdown.\n' +
              'Правила:\n' +
              '- не возвращай полное содержимое файла;\n' +
              '- search должен быть точным фрагментом существующего текста;\n' +
              '- patch-ов может быть несколько;\n' +
              '- если изменений не требуется, верни [] .\n\n' +
              `Инструкция: ${instruction}\n\n` +
              `Текущее содержимое файла:\n\n${source.text}`,
          },
        ],
        agentMode: false,
      })

      const patches = parsePatchResponse(response)
      const next = applyPatches(source.text, patches)
      await workspaceApi.saveFile(source.path, next)
      const updated = await workspaceApi.readFile(source.path)
      setPreview(await withHistory(updated))
      setPreviewStartEditing(false)
      await refresh()
    } catch (e) {
      setError(e.message || 'Не удалось применить AI patch')
    } finally {
      setAiBusy(false)
    }
  }

  const sendFileToChat = async (node) => {
    const file = await workspaceApi.readFile(node.path)
    onSendToChat?.('', [toChatAttachment(file)])
  }

  const restoreHistory = async (file, revisionId) => {
    try {
      await workspaceApi.restoreHistory(file.path, revisionId)
      const updated = await workspaceApi.readFile(file.path)
      setPreview(await withHistory(updated))
      setPreviewStartEditing(false)
      await refresh()
    } catch (e) {
      setError(e.message || 'Не удалось восстановить ревизию')
    }
  }

  const onMove = async (sourcePath, targetDirPath = '') => {
    try {
      await workspaceApi.move(sourcePath, targetDirPath)
      await refresh()
      if (preview?.path === sourcePath) setPreview(null)
    } catch (e) {
      setError(e.message || 'Не удалось переместить')
    }
  }

  const openNodeMenu = (event, node) => {
    event.preventDefault()
    const common = [
      { id: 'new-folder', label: 'Новая папка' },
      { id: 'new-file', label: 'Новый файл' },
      { id: 'upload-url', label: 'Загрузить по URL' },
      { id: 'ai-create', label: 'Создать файл через AI' },
      node?.path ? { id: 'copy-path', label: 'Копировать путь' } : null,
    ]
    const fileItems = node?.type === 'file'
      ? [
          { id: 'preview', label: 'Просмотр' },
          { id: 'edit', label: 'Редактировать' },
          { id: 'attach-chat', label: 'Прикрепить в Composer' },
          { id: 'ai-patch', label: 'AI Apply Patch' },
          { id: 'download', label: 'Скачать' },
          { id: 'rename', label: 'Переименовать' },
          { id: 'delete', label: 'Удалить', danger: true },
        ]
      : node?.path
        ? [
            { id: 'rename', label: 'Переименовать' },
            { id: 'delete', label: 'Удалить', danger: true },
          ]
        : []

    setMenu({
      x: event.clientX,
      y: event.clientY,
      node,
      items: [...common, ...fileItems].filter(Boolean),
    })
  }

  const handleMenuAction = async (action, node) => {
    try {
      if (action === 'preview' && node?.type === 'file') {
        await openPreview(node)
        return
      }

      if (action === 'edit' && node?.type === 'file') {
        await openPreview(node, { edit: true })
        return
      }

      if (action === 'download' && node?.type === 'file') {
        downloadFile(node)
        return
      }

      if (action === 'attach-chat' && node?.type === 'file') {
        await sendFileToChat(node)
        return
      }

      if (action === 'ai-patch' && node?.type === 'file') {
        const file = preview?.path === node.path ? preview : await workspaceApi.readFile(node.path)
        await applyAiPatch(file)
        return
      }

      if (action === 'copy-path') {
        await navigator.clipboard.writeText(node?.path || '')
        return
      }

      if (action === 'upload-url') {
        const base = node?.type === 'dir'
          ? node.path
          : node?.path?.split('/').slice(0, -1).join('/') || ''
        await uploadByUrl(base)
        return
      }

      if (action === 'ai-create') {
        const base = node?.type === 'dir'
          ? node.path
          : node?.path?.split('/').slice(0, -1).join('/') || ''
        await createFileWithAi(base)
        return
      }

      if (action === 'new-folder') {
        const base = node?.type === 'dir'
          ? node.path
          : node?.path?.split('/').slice(0, -1).join('/') || ''
        const name = prompt('Имя новой папки', 'New Folder')
        if (name) {
          await workspaceApi.createFolder(base, name)
          await refresh()
        }
        return
      }

      if (action === 'new-file') {
        const base = node?.type === 'dir'
          ? node.path
          : node?.path?.split('/').slice(0, -1).join('/') || ''
        const name = prompt('Имя нового файла', 'untitled.txt')
        if (name) {
          await workspaceApi.createFile(base, name, '')
          await refresh()
        }
        return
      }

      if (action === 'rename' && node?.path) {
        const name = prompt('Новое имя', node.name)
        if (name && name !== node.name) {
          await workspaceApi.rename(node.path, name)
          await refresh()
          if (preview?.path === node.path) setPreview(null)
        }
        return
      }

      if (action === 'delete' && node?.path) {
        if (confirm(`Удалить ${node.type === 'dir' ? 'папку' : 'файл'} "${node.name}"?`)) {
          await workspaceApi.remove(node.path)
          await refresh()
          if (preview?.path === node.path) setPreview(null)
        }
      }
    } catch (e) {
      setError(e.message || 'Операция не выполнена')
    }
  }

  const onRootDrop = async (e) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/browserai-workspace')
    if (raw) {
      const payload = JSON.parse(raw)
      await onMove(payload.path, '')
      return
    }
    if (e.dataTransfer?.files?.length) {
      await upload(e.dataTransfer.files, '')
    }
  }

  return (
    <div
      className={`h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out ${
        open ? openWidth : 'w-0'
      }`}
    >
      <div className={`flex h-full flex-col p-3 pl-0 ${innerWidth}`}>
        <div className="flex max-h-full flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-graphite-800/40 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2.5">
            <span className="flex items-center gap-2 text-[13px] text-cream">
              Workspace
              {tree && (
                <span className="rounded-full bg-graphite-700/60 px-1.5 text-[11px] text-cream-faint">
                  {nodes.length}
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="grid h-7 w-7 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750/60 hover:text-cream"
                title="Загрузить файлы / ZIP / TAR / TGZ"
              >
                <IconUpload />
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="grid h-7 w-7 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750/60 hover:text-cream"
                title="Загрузить папку"
              >
                <IconFolder />
              </button>
              <button
                onClick={() =>
                  openNodeMenu(
                    { preventDefault() {}, clientX: 24, clientY: 90 },
                    { type: 'dir', path: '', name: 'workspace' },
                  )
                }
                className="grid h-7 w-7 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750/60 hover:text-cream"
                title="Новая папка / файл / AI / URL"
              >
                <IconNewChat />
              </button>
              <button
                onClick={onClose}
                className="grid h-7 w-7 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750/60 hover:text-cream"
                title="Закрыть"
              >
                <IconClose />
              </button>
            </div>
          </div>

          <div className="border-b border-white/5 px-3 py-2 space-y-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск файлов и папок…"
              className="w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
            />

            <div className="flex gap-2">
              <input
                value={contentQuery}
                onChange={(e) => setContentQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void runContentSearch()}
                placeholder="Поиск по содержимому (grep)…"
                className="w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
              />
              <button
                onClick={() => void runContentSearch()}
                className="rounded-lg border border-white/10 px-3 py-2 text-[12px] text-cream-soft transition-colors hover:bg-graphite-750 hover:text-cream"
              >
                grep
              </button>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[12px] text-cream-soft">
                Show hidden files {showHidden ? '• on' : '• off'}
              </span>
              <button
                onClick={() => setShowHidden((v) => !v)}
                role="switch"
                aria-checked={showHidden}
                className={`relative h-[18px] w-8 rounded-full transition-colors ${
                  showHidden ? 'bg-cream' : 'bg-graphite-600'
                }`}
              >
                <span
                  className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-graphite-900 transition-transform ${
                    showHidden ? 'translate-x-[16px]' : 'translate-x-[2px]'
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }} onDrop={onRootDrop} onContextMenu={(e) => openNodeMenu(e, { type: 'dir', path: '', name: 'workspace' })}>
            {loading ? (
              <div className="px-3 py-3 text-[12px] text-cream-faint">Загрузка…</div>
            ) : error ? (
              <div className="px-3 py-3 text-[12px] text-red-300">⚠ {error}</div>
            ) : contentQuery.trim() && (searchingContent || contentResults.length > 0) ? (
              <div className="space-y-1 p-1.5">
                {searchingContent ? (
                  <div className="px-3 py-3 text-[12px] text-cream-faint">Ищу по содержимому…</div>
                ) : contentResults.length > 0 ? (
                  contentResults.map((item) => (
                    <button
                      key={`${item.path}:${item.line}`}
                      onClick={() => void openPreview({ path: item.path, type: 'file' })}
                      className="w-full rounded-lg border border-white/5 px-3 py-2 text-left transition-colors hover:bg-graphite-750"
                    >
                      <div className="truncate text-[12px] text-cream">{item.path}</div>
                      <div className="text-[11px] text-cream-faint">Строка {item.line}</div>
                      <div className="mt-1 truncate text-[11px] text-cream-soft">{item.snippet}</div>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-3 text-[12px] text-cream-faint">Ничего не найдено.</div>
                )}
              </div>
            ) : hasFiles ? (
              <FileTree
                data={nodes}
                activePath={preview?.path}
                onPreview={openPreview}
                onDownload={downloadFile}
                onContextMenu={openNodeMenu}
                onMove={onMove}
              />
            ) : (
              <div className="px-3 py-3 text-[11px] leading-snug text-cream-faint">
                Пусто. Загрузи файлы, папку, архив или создай файл через контекстное меню.
              </div>
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void upload(e.target.files, '')
          e.target.value = ''
        }}
      />

      <input
        ref={folderInputRef}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        hidden
        onChange={(e) => {
          void upload(e.target.files, '')
          e.target.value = ''
        }}
      />

      <ContextMenu state={menu} onClose={() => setMenu(null)} onAction={handleMenuAction} />

      <FilePreview
        key={preview ? `${preview.path}:${preview.modifiedAt}:${previewStartEditing ? 1 : 0}` : 'empty'}
        file={preview}
        startEditing={previewStartEditing}
        onClose={() => {
          setPreview(null)
          setPreviewStartEditing(false)
        }}
        onDownload={downloadFile}
        onSave={savePreviewFile}
        onAiEdit={applyAiPatch}
        onRestoreHistory={restoreHistory}
      />

      {(uploading || aiBusy) && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 rounded-lg border border-white/10 bg-graphite-800 px-3 py-2 text-[12px] text-cream-soft shadow-2xl">
          {uploading ? 'Загрузка / распаковка…' : 'AI применяет patch…'}
        </div>
      )}
    </div>
  )
}
