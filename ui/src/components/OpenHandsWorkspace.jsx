import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FileTree from './FileTree.jsx'
import { serializeUploadFiles, workspaceApi } from '../lib/workspace.js'
import { useWorkspace } from '../lib/useWorkspace.js'

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
    if ((ev === 'tool_start' || ev === 'tool-start') && (name === 'bash' || name === 'shell_session_run')) {
      const cmd = data.args?.command || data.command || data.args?.cmd || ''
      if (cmd) logs.push({ type: 'cmd', text: `$ ${cmd}` })
      continue
    }
    if ((ev === 'tool_result' || ev === 'tool-result') && (name === 'bash' || name === 'shell_session_run')) {
      const result = data.result
      const exitCode = result?.exitCode ?? result?.exit_code
      const stdout = typeof result === 'string' ? result : (result?.stdout || result?.content || result?.result || '')
      const stderr = result?.stderr || ''
      if (stdout) logs.push({ type: 'out', text: String(stdout) })
      if (stderr) logs.push({ type: 'err', text: String(stderr) })
      if (exitCode !== undefined) logs.push({ type: exitCode === 0 ? 'info' : 'err', text: `[exit ${exitCode}]` })
      if (data.error) logs.push({ type: 'err', text: String(data.error) })
    }
  }
  return logs
}

/**
 * OpenHandsWorkspace — ЕДИНСТВЕННЫЙ workspace в BrowserAI
 * BrowserAI Arena style: graphite / cream, mono 11px, минимум хрома
 *
 * v3 (2026-06-28):
 *  - FileTree вместо flat-списка (как в OpenHands)
 *  - CRUD: New File / New Folder / Rename / Delete / Move (drag&drop)
 *  - chatId-изолированный workspace: /workspace/chats/<chatId>
 *  - авто-refresh по workspaceRevision
 *  - терминал: live polling + auto-scroll + exit code
 *  - редактор: textarea + Ctrl+S + dirty-state (Monaco — следующий шаг)
 */
export default function OpenHandsWorkspace({
  activeChat,
  isOpen,
  onToggle,
  workspaceRevision = 0,
  aiWorking = false,
  browserScreenshot = null,
}) {
  const [activeTab, setActiveTab] = useState('files')
  const [terminalLogs, setTerminalLogs] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingTerminal, setLoadingTerminal] = useState(false)
  const [terminalError, setTerminalError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [menu, setMenu] = useState(null) // {x,y,node}

  const chatId = activeChat?.id || ''
  const terminalEndRef = useRef(null)
  const refreshTerminal = useCallback(async (silent = false) => {
    if (!isOpen || !chatId) return
    if (!silent) setLoadingTerminal(true)
    setTerminalError('')
    try {
      const r = await fetch(`/api/agent/runs/${encodeURIComponent(chatId)}/history`, {
        credentials: 'include', cache: 'no-store'
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setTerminalLogs(historyToTerminalLogs(data.items || []))
    } catch (e) {
      setTerminalError(e.message || String(e))
    } finally {
      if (!silent) setLoadingTerminal(false)
    }
  }, [chatId, isOpen])

  const {
    tree, loadingFiles, filesError, setFilesError,
    revision: treeRevision, refreshFilesNow, refreshFiles, setSelectedFileRef,
  } = useWorkspace({ chatId, isOpen, aiWorking, workspaceRevision, activeTab, refreshTerminal })

  useEffect(() => { setSelectedFileRef(selectedFile) }, [selectedFile, setSelectedFileRef])

  // initial / chat switch: files handled by useWorkspace; terminal refresh stays here
  useEffect(() => {
    if (!isOpen || !chatId) return
    void refreshTerminal()
  }, [isOpen, chatId, refreshTerminal])

  // live terminal while AI working
  useEffect(() => {
    if (!isOpen || activeTab !== 'terminal' || !chatId || !aiWorking) return
    const id = setInterval(() => void refreshTerminal(true), 2500)
    return () => clearInterval(id)
  }, [isOpen, activeTab, chatId, aiWorking, refreshTerminal])

  // auto-scroll terminal
  useEffect(() => {
    if (activeTab === 'terminal') terminalEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [terminalLogs, activeTab])

  // --- file ops ---
  const openFile = async (node) => {
    if (!node || node.type !== 'file') return
    if (dirty && selectedFile && !window.confirm('Несохранённые изменения будут потеряны. Открыть другой файл?')) return
    setSaveError(''); setFilesError('')
    try {
      workspaceApi.setChatId(chatId)
      const full = await workspaceApi.readFile(node.path)
      setSelectedFile({ ...node, ...full })
      setFileContent(full.text ?? full.content ?? '')
      setDirty(false)
    } catch (e) {
      setFilesError(e.message || 'open failed')
    }
  }

  const saveFile = useCallback(async () => {
    if (!selectedFile?.path) return
    setSaveError('')
    try {
      workspaceApi.setChatId(chatId)
      await workspaceApi.saveFile(selectedFile.path, fileContent)
      setDirty(false)
      await refreshFiles(true)
    } catch (e) {
      setSaveError(e.message || 'save failed')
    }
  }, [selectedFile?.path, chatId, fileContent, refreshFiles])

  // Ctrl+S
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (selectedFile && dirty) { e.preventDefault(); void saveFile() }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [selectedFile, dirty, saveFile])

  const uploadFiles = async (fileList, parentPath = '') => {
    if (!fileList?.length) return
    setFilesError('')
    try {
      workspaceApi.setChatId(chatId)
      const packed = await serializeUploadFiles(fileList)
      await workspaceApi.uploadFiles(parentPath, packed)
      await refreshFiles()
    } catch (e) {
      setFilesError(e.message || 'upload failed')
    }
  }

  const createFolder = async (baseNode = null) => {
    const basePath = baseNode?.type === 'dir' ? baseNode.path : (baseNode?.path?.split('/').slice(0,-1).join('/') || '')
    const name = window.prompt('Имя новой папки', 'new-folder')
    if (!name) return
    try {
      await workspaceApi.createFolder(basePath, name)
      await refreshFiles()
    } catch (e) { setFilesError(e.message || 'mkdir failed') }
  }

  const createFile = async (baseNode = null) => {
    const basePath = baseNode?.type === 'dir' ? baseNode.path : (baseNode?.path?.split('/').slice(0,-1).join('/') || '')
    const name = window.prompt('Имя нового файла', 'untitled.txt')
    if (!name) return
    try {
      await workspaceApi.createFile(basePath, name, '')
      await refreshFiles()
      // авто-открыть
      const fullPath = basePath ? `${basePath}/${name}` : name
      await openFile({ path: fullPath, name, type: 'file' })
    } catch (e) { setFilesError(e.message || 'create failed') }
  }

  const renameNode = async (node) => {
    if (!node?.path) return
    const newName = window.prompt('Новое имя', node.name)
    if (!newName || newName === node.name) return
    try {
      await workspaceApi.rename(node.path, newName)
      if (selectedFile?.path === node.path) {
        const newPath = [...node.path.split('/').slice(0,-1), newName].filter(Boolean).join('/')
        setSelectedFile(s => s ? { ...s, path: newPath, name: newName } : s)
      }
      await refreshFiles()
    } catch (e) { setFilesError(e.message || 'rename failed') }
  }

  const deleteNode = async (node) => {
    if (!node?.path) return
    const kind = node.type === 'dir' ? 'папку' : 'файл'
    if (!window.confirm(`Удалить ${kind} «${node.name}»?`)) return
    try {
      await workspaceApi.remove(node.path)
      if (selectedFile?.path === node.path || selectedFile?.path?.startsWith(node.path + '/')) {
        setSelectedFile(null); setFileContent(''); setDirty(false)
      }
      await refreshFiles()
    } catch (e) { setFilesError(e.message || 'delete failed') }
  }

  const moveNode = async (sourcePath, targetDirPath) => {
    try {
      await workspaceApi.move(sourcePath, targetDirPath || '')
      await refreshFiles(true)
    } catch (e) { setFilesError(e.message || 'move failed') }
  }

  const downloadNode = (node) => {
    if (!node?.path) return
    const url = workspaceApi.downloadUrl(node.path, { inline: false })
    window.open(url, '_blank')
  }

  // context menu
  const openContextMenu = (e, node) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, node })
  }
  const closeMenu = () => setMenu(null)
  const handleMenuAction = (action, node) => {
    closeMenu()
    const actions = {
      open: () => node?.type === 'file' && openPreview(node),
      new_file: () => createFile(node),
      new_folder: () => createFolder(node),
      rename: () => renameNode(node),
      delete: () => deleteNode(node),
      download: () => downloadNode(node),
      upload_here: () => {
        const input = document.createElement('input')
        input.type = 'file'; input.multiple = true
        input.onchange = () => uploadFiles(input.files, node?.type === 'dir' ? node.path : '')
        input.click()
      },
    }
    actions[action]?.()
  }
  const openPreview = (node) => openFile(node)

  const downloadZip = () => {
    const p = chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''
    window.open(`/api/workspace/download${p}`, '_blank')
  }

  const nodes = useMemo(() => tree?.children || [], [tree?.children])
  const fileCount = useMemo(() => {
    let n = 0
    const walk = (arr) => { for (const x of arr || []) { if (x.type === 'file') n++; if (x.children) walk(x.children) } }
    walk(nodes)
    return n
  }, [nodes])

  if (!isOpen) return null

  const err = filesError || saveError || terminalError

  return (
    <aside className="w-[420px] xl:w-[480px] shrink-0 border-l border-white/10 bg-graphite-900 flex flex-col h-full overflow-hidden text-cream text-[12px]">
      {/* Tabs — BrowserAI / Arena style */}
      <div className="flex items-center border-b border-white/10 bg-graphite-950 p-1.5 gap-1">
        {[
          ['files', '📁', `Файлы`, fileCount],
          ['terminal', '🖥️', 'Терминал', aiWorking ? '●' : null],
          ['browser', '🌐', 'Браузер', null],
        ].map(([id, icon, label, badge]) => (
          <button key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11px] transition-colors ${
              activeTab === id
                ? 'bg-graphite-800 text-cream border border-white/10'
                : 'text-cream-faint hover:text-cream hover:bg-white/5'
            }`}
          >
            <span>{icon}</span>
            <span>{label}</span>
            {badge !== null && <span className="text-[10px] text-cream-faint/70">{badge}</span>}
          </button>
        ))}
        <button type="button" onClick={onToggle}
          className="shrink-0 ml-1 rounded-md px-2 py-1.5 text-cream-faint hover:text-cream hover:bg-white/5" title="Скрыть">✕</button>
      </div>

      {err && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-200 flex justify-between gap-2">
          <span className="flex-1 truncate">{err}</span>
          <button onClick={() => { setFilesError(''); setSaveError(''); setTerminalError('') }} className="text-red-300/70 hover:text-red-200">✕</button>
        </div>
      )}

      {/* FILES TAB — FileTree + editor */}
      {activeTab === 'files' && (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* left: tree */}
          <div className="w-[46%] min-w-[180px] border-r border-white/5 flex flex-col bg-graphite-900/60">
            <div className="flex items-center gap-1 border-b border-white/5 px-2 py-1.5 text-[10px] bg-graphite-850">
              <span className="font-mono text-cream-soft truncate flex-1" title={`/workspace/chats/${chatId || 'default'}`}>
                /chats/{chatId ? chatId.slice(0,8) : '…'}
              </span>
              <button onClick={()=>void refreshFilesNow(false, false)} className="px-1.5 py-0.5 rounded hover:bg-white/10" title="Обновить">↻</button>
            </div>
            <div className="px-2 py-1.5 flex flex-wrap gap-1 border-b border-white/5 bg-graphite-900/80 text-[10px]">
              <button onClick={()=>createFile()} className="rounded border border-white/10 px-2 py-1 hover:bg-white/5">+ файл</button>
              <button onClick={()=>createFolder()} className="rounded border border-white/10 px-2 py-1 hover:bg-white/5">+ папка</button>
              <label className="rounded border border-white/10 px-2 py-1 hover:bg-white/10 cursor-pointer">
                ↑ upload
                <input type="file" multiple hidden onChange={e=>uploadFiles(e.target.files)} />
              </label>
              <button onClick={downloadZip} className="rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-emerald-300 hover:bg-emerald-500/10">ZIP</button>
            </div>
            <div className="flex-1 overflow-y-auto thin-scroll p-1.5 text-[12px]"
              onContextMenu={(e)=>openContextMenu(e, {type:'dir', path:'', name:'workspace'})}
              onDragOver={e=>{e.preventDefault(); e.dataTransfer.dropEffect='copy'}}
              onDrop={e=>{e.preventDefault(); if(e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files, '')}}
            >
              {loadingFiles && !tree ? (
                <div className="p-3 text-cream-faint italic text-[11px]">Загрузка…</div>
              ) : nodes.length ? (
                <FileTree
                  data={nodes}
                  activePath={selectedFile?.path}
                  onPreview={openPreview}
                  onDownload={downloadNode}
                  onContextMenu={openContextMenu}
                  onMove={moveNode}
                  onDelete={deleteNode}
                />
              ) : (
                <div className="p-3 text-[11px] text-cream-faint leading-snug">
                  Пусто.<br/>
                  <button onClick={()=>createFile()} className="underline hover:text-cream">Создать файл</button> · <button onClick={()=>createFolder()} className="underline hover:text-cream">папку</button><br/>
                  или попросить агента: <span className="font-mono text-cream-soft">«создай проект»</span>
                </div>
              )}
            </div>
            <div className="border-t border-white/5 px-2 py-1 text-[10px] text-cream-faint flex justify-between bg-graphite-950/60">
              <span>{fileCount} файлов</span>
              <span>rev {treeRevision ? String(treeRevision).slice(-5) : (workspaceRevision ? String(workspaceRevision).slice(-5) : '—')}</span>
            </div>
          </div>

          {/* right: editor */}
          <div className="flex-1 flex flex-col min-w-0 bg-graphite-950">
            {selectedFile ? (
              <>
                <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 bg-graphite-900 text-[11px]">
                  <div className="truncate font-mono text-cream-soft flex-1 mr-2" title={selectedFile.path}>
                    {selectedFile.path}
                    {dirty && <span className="text-amber-300 ml-1">•</span>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={()=>downloadNode(selectedFile)} className="px-2 py-0.5 rounded text-[10px] text-cream-faint hover:bg-white/10">↓</button>
                    <button onClick={()=>renameNode(selectedFile)} className="px-2 py-0.5 rounded text-[10px] text-cream-faint hover:bg-white/10">✎</button>
                    <button onClick={()=>deleteNode(selectedFile)} className="px-2 py-0.5 rounded text-[10px] text-red-300 hover:bg-red-500/10">🗑</button>
                    <button
                      onClick={saveFile}
                      disabled={!dirty}
                      className={`px-2.5 py-0.5 rounded text-[10px] font-medium transition-colors ${dirty ? 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : 'bg-white/5 text-cream-faint cursor-default'}`}
                    >
                      💾 {dirty ? 'Сохранить' : 'OK'}
                    </button>
                  </div>
                </div>
                <textarea
                  value={fileContent}
                  onChange={e => { setFileContent(e.target.value); setDirty(true) }}
                  className="flex-1 w-full bg-transparent p-3 font-mono text-[12px] leading-[1.5] text-cream outline-none resize-none thin-scroll"
                  spellCheck={false}
                  placeholder="// …"
                />
                <div className="border-t border-white/5 px-3 py-1 text-[10px] text-cream-faint flex justify-between bg-graphite-900/50">
                  <span>{formatSize(new Blob([fileContent]).size)} • {fileContent.split('\n').length} строк</span>
                  <span>{dirty ? '● Ctrl+S' : '✓ сохранено'} • {selectedFile.mime || 'text/plain'}</span>
                </div>
              </>
            ) : (
              <div className="flex-1 grid place-items-center text-center p-6 text-cream-faint text-[12px] leading-relaxed">
                <div>
                  <div className="text-[22px] mb-2">📝</div>
                  <div>Выберите файл слева<br/>или создайте новый через <b>+ файл</b></div>
                  <div className="mt-3 text-[10px] text-cream-faint/70 font-mono">
                    /workspace/chats/{chatId?.slice(0,12) || '…'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TERMINAL TAB */}
      {activeTab === 'terminal' && (
        <div className="flex-1 flex flex-col bg-black text-emerald-400 font-mono text-[11px] overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-[10px] text-cream-faint bg-[#0b0b0b] shrink-0">
            <span>agent@browserai:/workspace/chats/{chatId?.slice(0,8) || '…'} $</span>
            <div className="flex items-center gap-2">
              {aiWorking && <span className="text-emerald-300 animate-pulse">● live</span>}
              <button onClick={()=>refreshTerminal()} disabled={loadingTerminal}
                className="border border-white/10 rounded px-2 py-0.5 hover:bg-white/5">
                {loadingTerminal ? '…' : '↻'}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 leading-relaxed thin-scroll whitespace-pre-wrap break-words">
            {terminalError && <div className="text-red-400 mb-2">⚠ {terminalError}</div>}
            {terminalLogs.length === 0 && !loadingTerminal ? (
              <span className="text-cream-faint italic">нет команд — запусти агента</span>
            ) : terminalLogs.map((log,i)=>{
              const text = typeof log==='string'?log:log.text
              const type = typeof log==='string' ? (log.startsWith('$')?'cmd':'out') : log.type
              const cls = type==='cmd' ? 'text-amber-200 font-bold' : type==='err' ? 'text-red-400' : type==='info' ? 'text-amber-300 text-[10px]' : 'text-emerald-400'
              return <div key={i} className={cls}>{text}</div>
            })}
            <div ref={terminalEndRef} />
          </div>
          <div className="border-t border-white/10 px-3 py-1 text-[10px] text-cream-faint bg-[#0b0b0b]">
            {terminalLogs.length} событий • {aiWorking ? 'live 2.5s' : 'idle'} • read-only (интерактивный PTY — следующий шаг)
          </div>
        </div>
      )}

      {/* BROWSER TAB */}
      {activeTab === 'browser' && (
        <div className="flex-1 flex flex-col bg-graphite-950 overflow-hidden">
          <div className="border-b border-white/10 px-3 py-2 text-[11px] bg-graphite-900 flex items-center justify-between">
            <span className="font-mono text-cream-soft">OpenHands browser • preview</span>
            <span className="text-[10px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-0.5">WIP</span>
          </div>
          <div className="flex-1 grid place-items-center p-6 text-center text-cream-faint">
            {browserScreenshot ? (
              <img src={browserScreenshot} alt="browser" className="max-w-full rounded border border-white/10" />
            ) : (
              <div className="space-y-3 max-w-sm text-[12px] leading-relaxed">
                <div className="text-[28px]">🌐</div>
                <div>
                  Browser preview пока в разработке.<br/>
                  OpenHands runtime: <code className="text-cream-soft">openhands:18000</code><br/>
                  следующий шаг — <code>/api/browser/stream?chatId=…</code>
                </div>
                <div className="text-[10px] text-cream-faint/70">
                  Файлы и терминал уже live.<br/>
                  Monaco-редактор — следующий коммит.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Context menu */}
      {menu && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={closeMenu} />
          <div
            className="fixed z-[70] min-w-[200px] rounded-xl border border-white/10 bg-graphite-800 p-1 shadow-2xl text-[12px]"
            style={{ left: Math.min(menu.x, window.innerWidth-220), top: Math.min(menu.y, window.innerHeight-240) }}
          >
            {[
              ...(menu.node?.type === 'file' ? [['open','📄 Открыть']] : []),
              ['new_file','📄 + Новый файл'],
              ['new_folder','📁 + Новая папка'],
              ['upload_here','⬆ Загрузить сюда'],
              ...(menu.node?.path ? [['rename','✎ Переименовать'],['download','⬇ Скачать'],['delete','🗑 Удалить',true]] : [])
            ].map(([id,label,danger])=>(
              <button key={id}
                onClick={()=>handleMenuAction(id, menu.node)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${danger ? 'text-red-300 hover:bg-red-500/10' : 'text-cream-soft hover:bg-white/5 hover:text-cream'}`}
              >{label}</button>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
