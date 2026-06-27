import React, { useState, useEffect } from 'react'

export default function OpenHandsWorkspace({ activeChat, isOpen, onToggle, files = [], terminalLogs = [], browserScreenshot = null, onDownloadZip, onUploadFile, onSaveFile }) {
  const [activeTab, setActiveTab] = useState('files') // files | terminal | browser
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileContent, setFileContent] = useState('')

  useEffect(() => {
    if (files.length > 0 && !selectedFile) {
      setSelectedFile(files[0])
      setFileContent(files[0]?.content || '')
    }
  }, [files, selectedFile])

  if (!isOpen) return null

  return (
    <aside className="w-96 shrink-0 border-l border-white/10 bg-graphite-900 flex flex-col h-full overflow-hidden text-cream text-[12px]">
      {/* ── 1. Вкладки навигации (Табы OpenHands) ── */}
      <div className="flex items-center border-b border-white/10 bg-graphite-950 p-2 gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('files')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] transition-colors ${activeTab === 'files' ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
        >
          <span>📁</span> Файлы ({files.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('terminal')}
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

      {/* ── 2. Вкладка Файлов (Дерево + Редактор) ── */}
      {activeTab === 'files' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Верхняя панель кнопок воркспейса */}
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 bg-graphite-850 text-[11px]">
            <span className="font-mono text-cream-soft">Workspace / {activeChat?.id ? `chat_${activeChat.id.slice(0, 6)}` : 'default'}</span>
            <div className="flex items-center gap-1">
              <label className="cursor-pointer rounded border border-white/10 px-2 py-1 text-cream hover:bg-white/10 transition-colors" title="Загрузить файл">
                <span>+ Upload</span>
                <input type="file" className="hidden" onChange={(e) => onUploadFile?.(e.target.files[0])} />
              </label>
              <button
                type="button"
                onClick={onDownloadZip}
                className="rounded border border-white/10 bg-emerald-500/10 px-2 py-1 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                title="Скачать весь проект в ZIP-архив"
              >
                📥 ZIP
              </button>
            </div>
          </div>

          {/* Дерево файлов */}
          <div className="max-h-40 overflow-y-auto border-b border-white/5 p-2 bg-graphite-900/50 space-y-1">
            {files.length === 0 ? (
              <p className="text-center py-4 text-cream-faint italic text-[11px]">Воркспейс пуст. ИИ-агент создаст файлы здесь.</p>
            ) : (
              files.map((f, idx) => (
                <button
                  key={f.path || idx}
                  type="button"
                  onClick={() => { setSelectedFile(f); setFileContent(f.content || '') }}
                  className={`flex w-full items-center justify-between rounded px-2.5 py-1 text-left font-mono text-[11px] transition-colors ${selectedFile?.path === f.path ? 'bg-graphite-800 text-cream font-medium border border-white/10' : 'text-cream-faint hover:text-cream hover:bg-white/5'}`}
                >
                  <span className="truncate">📄 {f.path || f.name}</span>
                  <span className="text-[10px] text-cream-faint/60">{f.size ? `${Math.round(f.size / 1024)} KB` : ''}</span>
                </button>
              ))
            )}
          </div>

          {/* Редактор кода (Monaco-подобный вид с номерами строк) */}
          {selectedFile && (
            <div className="flex flex-1 flex-col overflow-hidden bg-graphite-950">
              <div className="flex items-center justify-between border-b border-white/5 px-3 py-1 bg-graphite-900 text-[11px] font-mono text-cream-soft">
                <span>{selectedFile.path || selectedFile.name}</span>
                <button
                  type="button"
                  onClick={() => onSaveFile?.(selectedFile.path, fileContent)}
                  className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-cream hover:bg-white/20 transition-colors"
                >
                  💾 Сохранить
                </button>
              </div>
              <div className="flex flex-1 overflow-hidden font-mono text-[11px] leading-relaxed">
                <div className="w-10 shrink-0 select-none bg-graphite-900/80 py-2 text-right text-cream-faint/40 pr-2 border-r border-white/5">
                  {fileContent.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}
                </div>
                <textarea
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  className="flex-1 resize-none bg-transparent p-2 text-cream outline-none thin-scroll font-mono"
                  spellCheck={false}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 3. Вкладка Терминала (tmux / bash прямой эфир) ── */}
      {activeTab === 'terminal' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-black font-mono text-[11px] text-emerald-400 p-3 leading-relaxed thin-scroll">
          <div className="border-b border-white/10 pb-1.5 mb-2 text-cream-faint text-[10px] flex items-center justify-between">
            <span>[openhands@timeweb-vps ~]$ tmux attach -t agent_sandbox</span>
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          </div>
          <div className="flex-1 overflow-y-auto whitespace-pre-wrap select-text space-y-1">
            {terminalLogs.length === 0 ? (
              <span className="text-cream-faint italic">Терминал готов к выполнению команд...</span>
            ) : (
              terminalLogs.map((log, idx) => (
                <div key={idx} className={log.startsWith('$') ? 'text-cream font-semibold' : 'text-emerald-400'}>
                  {log}
                </div>
              ))
            )}
            <span className="animate-pulse text-amber-300"> █</span>
          </div>
        </div>
      )}

      {/* ── 4. Вкладка Браузера (Виртуальный веб-браузер) ── */}
      {activeTab === 'browser' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-graphite-950">
          {/* Адресная строка браузера */}
          <div className="flex items-center gap-2 border-b border-white/10 bg-graphite-900 px-3 py-2 text-[11px]">
            <div className="flex items-center gap-1.5 text-cream-faint">
              <button className="hover:text-cream">◀</button>
              <button className="hover:text-cream">▶</button>
              <button className="hover:text-cream">↻</button>
            </div>
            <div className="flex-1 flex items-center gap-2 rounded border border-white/10 bg-graphite-950 px-2.5 py-1 font-mono text-[10px] text-cream-soft">
              <span>🔒</span>
              <span className="truncate">http://127.0.0.1:8080/preview/shashki.html</span>
            </div>
          </div>
          {/* Скриншот или превью страницы */}
          <div className="flex-1 p-4 flex items-center justify-center overflow-auto bg-graphite-900/50">
            {browserScreenshot ? (
              <img src={browserScreenshot} alt="Виртуальный браузер" className="max-w-full max-h-full rounded border border-white/10 shadow-xl" />
            ) : (
              <div className="text-center space-y-2 text-cream-faint">
                <p className="text-[24px]">🌐</p>
                <p className="italic text-[11px]">Виртуальный браузер ожидает открытия веб-страницы агентом...</p>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
