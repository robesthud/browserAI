import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    // BrowserAI agent loop emits tool_start / tool_result
    if ((ev === 'tool_start' || ev === 'tool-start') && (name === 'bash' || name === 'shell_session_run')) {
      const cmd = data.args?.command || data.command || data.args?.cmd || ''
      if (cmd) logs.push({ type: 'cmd', text: `$ ${cmd}`, ts: data.ts || item.ts })
      continue
    }
    if ((ev === 'tool_result' || ev === 'tool-result') && (name === 'bash' || name === 'shell_session_run')) {
      const result = data.result
      const exitCode = result?.exitCode ?? result?.exit_code
      const stdout = typeof result === 'string' ? result : (result?.stdout || result?.content || result?.result || '')
      const stderr = result?.stderr || ''
      if (stdout) logs.push({ type: 'out', text: String(stdout), ts: data.ts })
      if (stderr) logs.push({ type: 'err', text: String(stderr), ts: data.ts })
      if (exitCode !== undefined) {
        logs.push({ type: exitCode === 0 ? 'info' : 'err', text: `[exit ${exitCode}]`, ts: data.ts })
      }
      if (data.error) logs.push({ type: 'err', text: String(data.error), ts: data.ts })
      continue
    }
    // OpenHands native events fallback
    if (ev === 'action' && data.action === 'run') {
      const cmd = data.args?.command || ''
      if (cmd) logs.push({ type: 'cmd', text: `$ ${cmd}` })
    }
    if (ev === 'observation' && data.observation === 'run') {
      const out = data.extras?.stdout || data.content || ''
      if (out) logs.push({ type: 'out', text: String(out) })
    }
  }
  return logs
}

/**
 * OpenHandsWorkspace — ЕДИНСТВЕННЫЙ активный workspace UI в BrowserAI.
 * 
 * Было две реализации:
 *  - Workspace.jsx (левый drawer, 924 строки) — legacy, удалён 2026-06-28
 *  - OpenHandsWorkspace.jsx (правый aside) — актуальный, chat-isolated
 *
 * Этот компонент:
 *  - chatId-изолированный workspace: /workspace/chats/<chatId>
 *  - файлы через /api/workspace/tree (X-BrowserAI-Chat-Id header)
 *  - терминал = read-only история bash tool calls из /api/agent/runs/<chat>/history
 *  - автообновление по workspaceRevision из useChats
 */
export default function OpenHandsWorkspace({
  activeChat,
  isOpen,
  onToggle,
  workspaceRevision = 0,
  aiWorking = false,
  // legacy props kept for backward compat with App.jsx — ignored, we fetch ourselves
  files: _ignoredFiles,
  terminalLogs: _ignoredTerminalLogs,
  browserScreenshot = null,
  onDownloadZip: _ignoredDownload,
}) {
  const [activeTab, setActiveTab] = useState('files') // files | terminal | browser
  const [files, setFiles] = useState([])
  const [terminalLogs, setTerminalLogs] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingTerminal, setLoadingTerminal] = useState(false)
  const [filesError, setFilesError] = useState('')
  const [terminalError, setTerminalError] = useState('')
  const [saveError, setSaveError] = useState('')

  const chatId = activeChat?.id || ''
  const terminalEndRef = useRef(null)
  const selectedFileRef = useRef(null)

  // keep a ref copy of selectedFile to avoid refreshFiles re-creation loop
  useEffect(() => { selectedFileRef.current = selectedFile }, [selectedFile])

  const refreshFiles = useCallback(async (silent = false) => {
    if (!isOpen || !chatId) return
    if (!silent) setLoadingFiles(true)
    setFilesError('')
    try {
      workspaceApi.setChatId(chatId)
      const data = await workspaceApi.getTree(false)
      const flat = flattenTree(data.tree).sort((a, b) => String(a.path).localeCompare(String(b.path)))
      setFiles(flat)
      // if selected file disappeared — clear editor
      const sel = selectedFileRef.current
      if (sel && !flat.find((f) => f.path === sel.path)) {
        setSelectedFile(null)
        setFileContent('')
        setDirty(false)
      }
    } catch (e) {
      setFilesError(e.message || 'Не удалось загрузить workspace')
    } finally {
      if (!silent) setLoadingFiles(false)
    }
  }, [chatId, isOpen]) // NOTE: intentionally NO selectedFile dep — fixes refresh loop

  const refreshTerminal = useCallback(async (silent = false) => {
    if (!isOpen || !chatId) return
    if (!silent) setLoadingTerminal(true)
    setTerminalError('')
    try {
      const r = await fetch(`/api/agent/runs/${encodeURIComponent(chatId)}/history`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setTerminalLogs(historyToTerminalLogs(data.items || []))
    } catch (e) {
      setTerminalError(e.message || String(e))
      // keep old logs, don't wipe
    } finally {
      if (!silent) setLoadingTerminal(false)
    }
  }, [chatId, isOpen])

  // initial load / chat switch
  useEffect(() => {
    if (!isOpen || !chatId) return
    void refreshFiles()
    void refreshTerminal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, chatId])

  // P0 fix: auto-refresh when agent touches workspace
  useEffect(() => {
    if (!isOpen || !chatId || !workspaceRevision) return
    void refreshFiles(true)
    if (activeTab === 'terminal') void refreshTerminal(true)
  }, [workspaceRevision, isOpen, chatId, activeTab, refreshFiles, refreshTerminal])

  // live terminal polling while agent is working
  useEffect(() => {
    if (!isOpen || activeTab !== 'terminal' || !chatId || !aiWorking) return
    const id = setInterval(() => { void refreshTerminal(true) }, 2500)
    return () => clearInterval(id)
  }, [isOpen, activeTab, chatId, aiWorking, refreshTerminal])

  // auto-scroll terminal to bottom on new logs
  useEffect(() => {
    if (activeTab !== 'terminal') return
    terminalEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [terminalLogs, activeTab])

  const openFile = async (file) => {
    if (dirty && selectedFile && !window.confirm('Несохранённые изменения будут потеряны. Открыть другой файл?')) {
      return
    }
    setSaveError('')
    setFilesError('')
    try {
      workspaceApi.setChatId(chatId)
      const full = await workspaceApi.readFile(file.path)
      setSelectedFile({ ...file, ...full })
      setFileContent(full.text ?? full.content ?? '')
      setDirty(false)
    } catch (e) {
      setFilesError(e.message || 'Не удалось открыть файл')
    }
  }

  const saveSelectedFile = async () => {
    if (!selectedFile?.path) return
    setSaveError('')
    try {
      workspaceApi.setChatId(chatId)
      await workspaceApi.saveFile(selectedFile.path, fileContent)
      setDirty(false)
      await refreshFiles(true)
    } catch (e) {
      setSaveError(e.message || 'Не удалось сохранить файл')
    }
  }

  // Ctrl+S save
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (selectedFile && dirty) {
          e.preventDefault()
          void saveSelectedFile()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, dirty, fileContent])

  const uploadInput = async (fileList) => {
    if (!fileList?.length) return
    setFilesError('')
    try {
      workspaceApi.setChatId(chatId)
      const packed = await serializeUploadFiles(fileList)
      await workspaceApi.uploadFiles('', packed)
      await refreshFiles()
    } catch (e) {
      setFilesError(e.message || 'Не удалось загрузить файл')
    }
  }

  const deleteSelectedFile = async () => {
    if (!selectedFile?.path) return
    if (!window.confirm(`Удалить ${selectedFile.path}?`)) return
    try {
      workspaceApi.setChatId(chatId)
      await workspaceApi.remove(selectedFile.path)
      setSelectedFile(null)
      setFileContent('')
      setDirty(false)
      await refreshFiles()
    } catch (e) {
      setSaveError(e.message || 'Не удалось удалить')
    }
  }

  const downloadZip = () => {
    const params = []
    if (chatId) params.push(`chatId=${encodeURIComponent(chatId)}`)
    // server reads chatId from query (see workspace.js downloadUrl comment)
    window.open(`/api/workspace/download${params.length ? `?${params.join('&')}` : ''}`, '_blank')
  }

  const activeFileCount = useMemo(() => files.length, [files])

  if (!isOpen) return null

  const errorBanner = filesError || saveError || terminalError
  const errorText = filesError || saveError || terminalError

  return (
    <aside className="w-96 shrink-0 border-l border-white/10 bg-graphite-900 flex flex-col h-full overflow-hidden text-cream text-[12px]">
      <div className="flex items-center border-b border-white/10 bg-graphite-950 p-2 gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('files')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] transition-colors ${activeTab === 'files' ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
        >
          <span>📁</span> Файлы ({activeFileCount})
          {workspaceRevision ? <span className="text-[9px] opacity-60">rev {String(workspaceRevision).slice(-4)}</span> : null}
        </button>
        <button
          type="button"
          onClick={() => { setActiveTab('terminal'); void refreshTerminal() }}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] transition-colors ${activeTab === 'terminal' ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
        >
          <span>🖥️</span> Терминал
          {aiWorking && activeTab !== 'terminal' ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> : null}
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

      {errorBanner && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-200 flex items-start justify-between gap-2">
          <span className="flex-1">{errorText}</span>
          <button onClick={() => { setFilesError(''); setSaveError(''); setTerminalError('') }} className="text-red-300/70 hover:text-red-200">✕</button>
        </div>
      )}

      {activeTab === 'files' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 bg-graphite-850 text-[11px] gap-2">
            <span className="font-mono text-cream-soft truncate">/workspace/chats/{activeChat?.id ? activeChat.id.slice(0,8) : 'default'}</span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => void refreshFiles()}
                className="rounded border border-white/10 px-2 py-1 text-cream hover:bg-white/10 transition-colors"
                title="Обновить"
                disabled={loadingFiles}
              >
                {loadingFiles ? '…' : '↻'}
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
            {loadingFiles && files.length === 0 ? (
              <p className="text-center py-4 text-cream-faint italic text-[11px]">Загрузка workspace…</p>
            ) : files.length === 0 ? (
              <p className="text-center py-4 text-cream-faint italic text-[11px]">Воркспейс пуст. Загрузите файлы или попросите агента создать проект.</p>
            ) : (
              files.map((f, idx) => (
                <button
                  key={f.path || idx}
                  type="button"
                  onClick={() => void openFile(f)}
                  className={`flex w-full items-center justify-between rounded px-2.5 py-1 text-left font-mono text-[11px] transition-colors ${selectedFile?.path === f.path ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
                >
                  <span className="truncate">📄 {f.path || f.name}</span>
                  <span className="text-[10px] text-cream-faint/60 shrink-0 ml-2">{formatSize(f.size)}</span>
                </button>
              ))
            )}
          </div>

          {selectedFile ? (
            <div className="flex flex-1 flex-col overflow-hidden bg-graphite-950">
              <div className="flex items-center justify-between border-b border-white/5 px-3 py-1 bg-graphite-900 text-[11px] font-mono text-cream-soft gap-2">
                <span className="truncate flex-1">{selectedFile.path || selectedFile.name}{dirty ? ' •' : ''}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void deleteSelectedFile()}
                    className="rounded px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10 transition-colors"
                    title="Удалить файл"
                  >
                    🗑
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveSelectedFile()}
                    disabled={!dirty}
                    className={`rounded px-2 py-0.5 text-[10px] transition-colors ${dirty ? 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : 'bg-white/10 text-cream-faint cursor-default'}`}
                    title="Сохранить (Ctrl+S)"
                  >
                    💾 Сохранить
                  </button>
                </div>
              </div>
              <textarea
                value={fileContent}
                onChange={(e) => { setFileContent(e.target.value); setDirty(true) }}
                className="flex-1 resize-none bg-transparent p-3 text-cream outline-none thin-scroll font-mono text-[11px] leading-relaxed"
                spellCheck={false}
                placeholder="// выберите файл слева"
              />
              <div className="border-t border-white/5 px-3 py-1 text-[10px] text-cream-faint flex justify-between">
                <span>{fileContent.length} симв • {fileContent.split('\n').length} строк</span>
                <span>{dirty ? '● не сохранено — Ctrl+S' : 'сохранено'}</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] italic text-cream-faint">
              Выберите файл для просмотра/редактирования.<br/>Файлы изолированы по chatId.
            </div>
          )}
        </div>
      )}

      {activeTab === 'terminal' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-black font-mono text-[11px] text-emerald-400">
          <div className="border-b border-white/10 px-3 py-1.5 text-cream-faint text-[10px] flex items-center justify-between bg-[#0a0a0a] shrink-0">
            <span>[agent@browserai /workspace/chats/{chatId ? chatId.slice(0,8) : '…'}]$</span>
            <div className="flex items-center gap-2">
              {aiWorking && <span className="text-emerald-300 animate-pulse">● live</span>}
              <button onClick={() => void refreshTerminal()} className="rounded border border-white/10 px-2 py-0.5 text-cream-faint hover:text-cream" disabled={loadingTerminal}>
                {loadingTerminal ? '…' : '↻'}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 leading-relaxed thin-scroll whitespace-pre-wrap break-words">
            {terminalError && (
              <div className="text-red-400 mb-2">⚠ {terminalError}</div>
            )}
            {terminalLogs.length === 0 && !loadingTerminal ? (
              <span className="text-cream-faint italic">Команд пока нет. Запустите агента — bash-вывод появится здесь live.</span>
            ) : (
              terminalLogs.map((log, idx) => {
                const text = typeof log === 'string' ? log : log.text
                const type = typeof log === 'string' ? (log.startsWith('$') ? 'cmd' : 'out') : (log.type || 'out')
                const cls =
                  type === 'cmd' ? 'text-cream font-semibold' :
                  type === 'err' ? 'text-red-400' :
                  type === 'info' ? 'text-amber-300 text-[10px]' :
                  'text-emerald-400'
                return <div key={idx} className={cls}>{text}</div>
              })
            )}
            <div ref={terminalEndRef} />
          </div>
          <div className="border-t border-white/10 px-3 py-1.5 text-[10px] text-cream-faint bg-[#0a0a0a] shrink-0">
            read-only agent log • {terminalLogs.length} событий • {aiWorking ? 'стриминг…' : 'пауза'}
          </div>
        </div>
      )}

      {activeTab === 'browser' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-graphite-950">
          <div className="flex items-center gap-2 border-b border-white/10 bg-graphite-900 px-3 py-2 text-[11px]">
            <div className="flex-1 flex items-center gap-2 rounded border border-white/10 bg-graphite-950 px-2.5 py-1 font-mono text-[10px] text-cream-soft">
              <span>🌐</span>
              <span className="truncate">OpenHands browser / preview</span>
            </div>
          </div>
          <div className="flex-1 p-4 flex items-center justify-center overflow-auto bg-graphite-900/50">
            {browserScreenshot ? (
              <img src={browserScreenshot} alt="Виртуальный браузер" className="max-w-full max-h-full rounded border border-white/10 shadow-xl" />
            ) : (
              <div className="text-center space-y-3 text-cream-faint max-w-xs">
                <p className="text-[28px]">🌐</p>
                <p className="italic text-[11px] leading-relaxed">
                  Browser preview пока в разработке.<br/>
                  OpenHands runtime уже запущен на Timeweb<br/>
                  (<code>openhands:18000</code>),<br/>
                  осталось подключить скриншот-стрим<br/>
                  <code>/api/browser/stream?chatId=…</code>
                </p>
                <p className="text-[10px] text-cream-faint/70">
                  Терминал и файлы уже работают live.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
