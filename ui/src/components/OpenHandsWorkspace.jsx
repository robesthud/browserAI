import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { serializeUploadFiles, workspaceApi } from '../lib/workspace.js'

function flattenTree(node, out = []) {
  if (!node) return out
  const children = Array.isArray(node.children) ? node.children : []
  if (node.type === 'file') out.push(node)
  for (const child of children) flattenTree(child, out)
  return out
}

function formatSize(size = 0) {
  const n = Number(size || 0)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function historyToTerminalLogs(items = []) {
  const logs = []
  for (const item of items) {
    const ev = item.event || item.kind
    const data = item.data || item.payload || item
    const name = data.name || data.tool || ''
    if (ev === 'tool_start' && name === 'bash') {
      const cmd = data.args?.command || data.command || ''
      if (cmd) logs.push(`$ ${cmd}`)
    }
    if (ev === 'tool_result' && name === 'bash') {
      const result = data.result
      const text = typeof result === 'string'
        ? result
        : (result?.stdout || result?.content || result?.result || JSON.stringify(result || {}, null, 2))
      if (text) logs.push(String(text))
      if (data.error) logs.push(String(data.error))
    }
  }
  return logs
}

export default function OpenHandsWorkspace({
  activeChat,
  isOpen,
  onToggle,
  browserScreenshot = null,
}) {
  const [activeTab, setActiveTab] = useState('files') // files | terminal | browser
  const [files, setFiles] = useState([])
  const [terminalLogs, setTerminalLogs] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingTerminal, setLoadingTerminal] = useState(false)
  const [error, setError] = useState('')

  const chatId = activeChat?.id || ''

  const refreshFiles = useCallback(async () => {
    if (!isOpen) return
    setLoadingFiles(true)
    setError('')
    try {
      workspaceApi.setChatId(chatId)
      const data = await workspaceApi.getTree(false)
      const flat = flattenTree(data.tree).sort((a, b) => String(a.path).localeCompare(String(b.path)))
      setFiles(flat)
      if (selectedFile && !flat.find((f) => f.path === selectedFile.path)) {
        setSelectedFile(null)
        setFileContent('')
      }
    } catch (e) {
      setError(e.message || 'Не удалось загрузить workspace')
    } finally {
      setLoadingFiles(false)
    }
  }, [chatId, isOpen, selectedFile])

  const refreshTerminal = useCallback(async () => {
    if (!isOpen || !chatId) return
    setLoadingTerminal(true)
    try {
      const r = await fetch(`/api/agent/runs/${encodeURIComponent(chatId)}/history`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setTerminalLogs(historyToTerminalLogs(data.items || []))
    } catch (e) {
      setTerminalLogs((prev) => prev.length ? prev : [`Не удалось загрузить терминал: ${e.message || e}`])
    } finally {
      setLoadingTerminal(false)
    }
  }, [chatId, isOpen])

  useEffect(() => {
    if (!isOpen) return
    void refreshFiles()
    void refreshTerminal()
  }, [isOpen, chatId, refreshFiles, refreshTerminal])

  const openFile = async (file) => {
    setError('')
    try {
      workspaceApi.setChatId(chatId)
      const full = await workspaceApi.readFile(file.path)
      setSelectedFile({ ...file, ...full })
      setFileContent(full.text ?? full.content ?? '')
    } catch (e) {
      setError(e.message || 'Не удалось открыть файл')
    }
  }

  const saveSelectedFile = async () => {
    if (!selectedFile?.path) return
    setError('')
    try {
      workspaceApi.setChatId(chatId)
      await workspaceApi.saveFile(selectedFile.path, fileContent)
      await refreshFiles()
    } catch (e) {
      setError(e.message || 'Не удалось сохранить файл')
    }
  }

  const uploadInput = async (fileList) => {
    if (!fileList?.length) return
    setError('')
    try {
      workspaceApi.setChatId(chatId)
      const packed = await serializeUploadFiles(fileList)
      await workspaceApi.uploadFiles('', packed)
      await refreshFiles()
    } catch (e) {
      setError(e.message || 'Не удалось загрузить файл')
    }
  }

  const downloadZip = () => {
    const params = []
    if (chatId) params.push(`chatId=${encodeURIComponent(chatId)}`)
    window.open(`/api/workspace/download${params.length ? `?${params.join('&')}` : ''}`, '_blank')
  }

  const activeFileCount = useMemo(() => files.length, [files])

  if (!isOpen) return null

  return (
    <aside className="w-96 shrink-0 border-l border-white/10 bg-graphite-900 flex flex-col h-full overflow-hidden text-cream text-[12px]">
      <div className="flex items-center border-b border-white/10 bg-graphite-950 p-2 gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('files')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] transition-colors ${activeTab === 'files' ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
        >
          <span>📁</span> Файлы ({activeFileCount})
        </button>
        <button
          type="button"
          onClick={() => { setActiveTab('terminal'); void refreshTerminal() }}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] transition-colors ${activeTab === 'terminal' ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
        >
          <span>🖥️</span> Терминал
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('browser')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] transition-colors ${activeTab === 'browser' ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
        >
          <span>🌐</span> Браузер
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 ml-auto flex items-center justify-center rounded-md p-1.5 text-cream-faint hover:text-cream hover:bg-white/5"
          title="Скрыть панель"
        >
          ✕
        </button>
      </div>

      {error && <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">{error}</div>}

      {activeTab === 'files' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 bg-graphite-850 text-[11px]">
            <span className="font-mono text-cream-soft">Workspace / {activeChat?.id ? `chat_${activeChat.id.slice(0, 6)}` : 'default'}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void refreshFiles()}
                className="rounded border border-white/10 px-2 py-1 text-cream hover:bg-white/10 transition-colors"
                title="Обновить"
              >
                ↻
              </button>
              <label className="cursor-pointer rounded border border-white/10 px-2 py-1 text-cream hover:bg-white/10 transition-colors" title="Загрузить файл">
                <span>+ Upload</span>
                <input type="file" multiple className="hidden" onChange={(e) => uploadInput(e.target.files)} />
              </label>
              <button
                type="button"
                onClick={downloadZip}
                className="rounded border border-white/10 bg-emerald-500/10 px-2 py-1 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                title="Скачать весь workspace ZIP"
              >
                📥 ZIP
              </button>
            </div>
          </div>

          <div className="max-h-52 overflow-y-auto border-b border-white/5 p-2 bg-graphite-900/50 space-y-1">
            {loadingFiles ? (
              <p className="text-center py-4 text-cream-faint italic text-[11px]">Загрузка workspace…</p>
            ) : files.length === 0 ? (
              <p className="text-center py-4 text-cream-faint italic text-[11px]">Воркспейс пуст или ещё не загружен.</p>
            ) : (
              files.map((f, idx) => (
                <button
                  key={f.path || idx}
                  type="button"
                  onClick={() => void openFile(f)}
                  className={`flex w-full items-center justify-between rounded px-2.5 py-1 text-left font-mono text-[11px] transition-colors ${selectedFile?.path === f.path ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
                >
                  <span className="truncate">📄 {f.path || f.name}</span>
                  <span className="text-[10px] text-cream-faint/60">{formatSize(f.size)}</span>
                </button>
              ))
            )}
          </div>

          {selectedFile ? (
            <div className="flex flex-1 flex-col overflow-hidden bg-graphite-950">
              <div className="flex items-center justify-between border-b border-white/5 px-3 py-1 bg-graphite-900 text-[11px] font-mono text-cream-soft">
                <span className="truncate">{selectedFile.path || selectedFile.name}</span>
                <button
                  type="button"
                  onClick={() => void saveSelectedFile()}
                  className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-cream hover:bg-white/20 transition-colors"
                >
                  💾 Сохранить
                </button>
              </div>
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                className="flex-1 resize-none bg-transparent p-3 text-cream outline-none thin-scroll font-mono text-[11px] leading-relaxed"
                spellCheck={false}
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] italic text-cream-faint">
              Выберите файл для просмотра/редактирования.
            </div>
          )}
        </div>
      )}

      {activeTab === 'terminal' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-black font-mono text-[11px] text-emerald-400 p-3 leading-relaxed thin-scroll">
          <div className="border-b border-white/10 pb-1.5 mb-2 text-cream-faint text-[10px] flex items-center justify-between">
            <span>[openhands@runtime /workspace]$ history</span>
            <button onClick={() => void refreshTerminal()} className="rounded border border-white/10 px-2 py-0.5 text-cream-faint hover:text-cream">↻</button>
          </div>
          <div className="flex-1 overflow-y-auto whitespace-pre-wrap select-text space-y-1">
            {loadingTerminal ? (
              <span className="text-cream-faint italic">Загрузка истории терминала…</span>
            ) : terminalLogs.length === 0 ? (
              <span className="text-cream-faint italic">Команд в OpenHands events пока нет.</span>
            ) : (
              terminalLogs.map((log, idx) => (
                <div key={idx} className={log.startsWith('$') ? 'text-cream font-semibold' : 'text-emerald-400'}>
                  {log}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'browser' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-graphite-950">
          <div className="flex items-center gap-2 border-b border-white/10 bg-graphite-900 px-3 py-2 text-[11px]">
            <div className="flex-1 flex items-center gap-2 rounded border border-white/10 bg-graphite-950 px-2.5 py-1 font-mono text-[10px] text-cream-soft">
              <span>🌐</span>
              <span className="truncate">OpenHands browser/runtime preview</span>
            </div>
          </div>
          <div className="flex-1 p-4 flex items-center justify-center overflow-auto bg-graphite-900/50">
            {browserScreenshot ? (
              <img src={browserScreenshot} alt="Виртуальный браузер" className="max-w-full max-h-full rounded border border-white/10 shadow-xl" />
            ) : (
              <div className="text-center space-y-2 text-cream-faint">
                <p className="text-[24px]">🌐</p>
                <p className="italic text-[11px]">Browser preview ещё не подключён к OpenHands web-hosts.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
