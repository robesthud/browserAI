import { useState, useRef } from 'react'

export default function WebPreview({ open, onClose }) {
  const [port, setPort] = useState('3000')
  const [path, setPath] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const iframeRef = useRef(null)

  if (!open) return null

  const handleRefresh = () => {
    setRefreshKey((k) => k + 1)
  }

  const cleanPath = (path || '').replace(/^\/+/, '')
  const proxyUrl = `/api/sandbox/proxy/${port}/${cleanPath}`

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop blur click to close */}
      <div className="flex-1 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />

      {/* Main Drawer Panel */}
      <div className="flex h-full w-full max-w-2xl flex-col border-l border-white/10 bg-graphite-850 shadow-2xl md:w-1/2 md:min-w-[320px]">
        {/* Header */}
        <div className="border-b border-white/5 px-4 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[14px] font-medium text-cream flex items-center gap-1.5">
                <span className="text-violet-400">🌐</span> Веб-просмотр Песочницы
              </div>
              <div className="mt-0.5 text-[11px] text-cream-faint">
                Просмотр dev-серверов и тестирование вебхуков
              </div>
            </div>
            <button
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-lg text-cream-dim transition-colors hover:bg-graphite-750/60 hover:text-cream"
              title="Закрыть"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col gap-2 border-b border-white/5 bg-graphite-900/40 px-4 py-2.5 md:flex-row md:items-center">
          {/* Port input */}
          <div className="flex items-center gap-1.5 shrink-0">
            <label className="text-[11px] text-cream-faint uppercase font-semibold">Порт:</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3000"
              className="w-20 rounded-lg border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream focus:border-cream/30 focus:outline-none"
            />
          </div>

          {/* Path / address bar */}
          <div className="flex flex-1 items-center gap-1.5">
            <span className="text-[12px] text-cream-faint">/</span>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="путь (например, api/users или index.html)"
              className="w-full flex-1 rounded-lg border border-white/10 bg-graphite-900 px-3 py-1 text-[12px] text-cream focus:border-cream/30 focus:outline-none"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleRefresh}
              className="rounded-lg border border-white/10 bg-graphite-750 px-3 py-1 text-[12px] text-cream-soft hover:bg-graphite-700 hover:text-cream transition-colors"
              title="Обновить страницу"
            >
              🔄 Обновить
            </button>
          </div>
        </div>

        {/* Live URL indicator */}
        <div className="px-4 py-1.5 bg-graphite-900/60 text-[10px] font-mono text-cream-faint border-b border-white/5 truncate">
          Proxy URL: <span className="text-violet-300">{proxyUrl}</span>
        </div>

        {/* Iframe View */}
        <div className="min-h-0 flex-1 bg-white">
          <iframe
            ref={iframeRef}
            key={refreshKey}
            title="Sandbox Web Preview"
            src={proxyUrl}
            className="h-full w-full border-none bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      </div>
    </div>
  )
}
