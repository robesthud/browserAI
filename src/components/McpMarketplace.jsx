import { useState, useEffect } from 'react'

/**
 * McpMarketplace — Sprint 5C
 * Каталог MCP серверов с установкой в один клик.
 */

const CATEGORY_LABELS = {
  all: 'Все',
  dev: '💻 Dev',
  deploy: '🚀 Web',
  productivity: '📋 Продуктивность',
  database: '🗄️ Базы данных',
}

async function fetchCatalog() {
  try {
    const r = await fetch('/api/operator/mcp/catalog', { credentials: 'include' })
    if (!r.ok) return []
    const d = await r.json()
    return d.servers || []
  } catch { return [] }
}

async function installServer(serverId, envVars) {
  const r = await fetch('/api/operator/mcp/install', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, envVars }),
  })
  const d = await r.json()
  if (!r.ok || !d.ok) throw new Error(d.error || 'Install failed')
  return d
}

async function uninstallServer(id) {
  const r = await fetch(`/api/operator/mcp/server/${encodeURIComponent(id)}`, {
    method: 'DELETE', credentials: 'include',
  })
  const d = await r.json()
  if (!r.ok || !d.ok) throw new Error(d.error || 'Uninstall failed')
  return d
}

function EnvVarForm({ envVars, values, onChange }) {
  if (!envVars || Object.keys(envVars).length === 0) return null
  return (
    <div className="mt-3 space-y-2">
      {Object.entries(envVars).map(([key, meta]) => (
        <div key={key}>
          <label className="mb-0.5 block text-[10px] text-cream-faint">
            {meta.label}{meta.required && <span className="ml-1 text-red-400">*</span>}
          </label>
          <input
            type={key.toLowerCase().includes('secret') || key.toLowerCase().includes('password') ? 'password' : 'text'}
            value={values[key] || ''}
            onChange={(e) => onChange(key, e.target.value)}
            placeholder={meta.placeholder || ''}
            className="w-full rounded border border-white/10 bg-graphite-900 px-2 py-1 text-[11px] text-cream placeholder:text-cream-faint/50 focus:border-cream/30 focus:outline-none"
          />
        </div>
      ))}
    </div>
  )
}

function ServerCard({ server, installedIds, onInstall, onUninstall }) {
  const [expanded, setExpanded] = useState(false)
  const [envValues, setEnvValues] = useState({})
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState(null)

  const isInstalled = installedIds.has(server.id)
  const hasEnvVars = Object.keys(server.envVars || {}).length > 0

  const handleInstall = async () => {
    setError(null)
    setInstalling(true)
    try {
      await onInstall(server.id, envValues)
      setExpanded(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className={`rounded-xl border transition-colors ${isInstalled ? 'border-green-500/30 bg-green-500/5' : 'border-white/10 bg-graphite-900/40'}`}>
      <div className="flex items-start gap-3 p-3">
        <span className="text-2xl leading-none">{server.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-cream">{server.name}</span>
            {isInstalled && <span className="rounded-full bg-green-500/20 px-1.5 py-0.5 text-[9px] text-green-400">✓ установлен</span>}
          </div>
          <p className="mt-0.5 text-[11px] text-cream-faint">{server.description}</p>
        </div>
        <div className="flex-shrink-0 flex gap-1">
          {isInstalled ? (
            <button
              onClick={() => onUninstall(server.id)}
              className="rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10 transition-colors"
            >Удалить</button>
          ) : (
            <button
              onClick={() => hasEnvVars ? setExpanded(v => !v) : handleInstall()}
              disabled={installing}
              className="rounded border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-[11px] text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
            >{installing ? '⏳' : '+ Установить'}</button>
          )}
        </div>
      </div>

      {expanded && !isInstalled && (
        <div className="border-t border-white/5 px-3 pb-3">
          <EnvVarForm
            envVars={server.envVars}
            values={envValues}
            onChange={(k, v) => setEnvValues(prev => ({ ...prev, [k]: v }))}
          />
          {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleInstall}
              disabled={installing}
              className="rounded bg-blue-600 px-3 py-1 text-[11px] text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >{installing ? 'Установка…' : 'Установить'}</button>
            <button
              onClick={() => setExpanded(false)}
              className="rounded border border-white/10 px-3 py-1 text-[11px] text-cream-soft hover:bg-graphite-750 transition-colors"
            >Отмена</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function McpMarketplace({ installedServers = [] }) {
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState(null)

  const installedIds = new Set((installedServers || []).map(s => s._catalogId || s.name))

  useEffect(() => {
    fetchCatalog().then(s => { setCatalog(s); setLoading(false) })
  }, [])

  const categories = ['all', ...new Set(catalog.map(s => s.category))]

  const filtered = catalog.filter(s => {
    if (category !== 'all' && s.category !== category) return false
    if (search) {
      const q = search.toLowerCase()
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    }
    return true
  })

  const handleInstall = async (serverId, envVars) => {
    const result = await installServer(serverId, envVars)
    setStatus({ type: 'success', text: `✓ Установлен и запущен` })
    setTimeout(() => setStatus(null), 3000)
    // Refresh catalog to update installed status via parent
    if (result.status) { /* parent will refresh via onInstall callback */ }
  }

  const handleUninstall = async (id) => {
    try {
      await uninstallServer(id)
      setStatus({ type: 'success', text: `✓ Удалён` })
      setTimeout(() => setStatus(null), 3000)
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
      setTimeout(() => setStatus(null), 4000)
    }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-cream">🧩 MCP Marketplace</h3>
        {status && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${status.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
            {status.text}
          </span>
        )}
      </div>

      {/* Search */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Поиск серверов…"
        className="w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-1.5 text-[12px] text-cream placeholder:text-cream-faint/50 focus:border-cream/30 focus:outline-none"
      />

      {/* Category filters */}
      <div className="flex flex-wrap gap-1.5">
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              category === cat
                ? 'border-cream bg-cream text-graphite-900 font-medium'
                : 'border-white/10 text-cream-soft hover:bg-graphite-750'
            }`}
          >{CATEGORY_LABELS[cat] || cat}</button>
        ))}
      </div>

      {/* Server list */}
      {loading ? (
        <div className="py-4 text-center text-[12px] text-cream-faint">Загрузка каталога…</div>
      ) : filtered.length === 0 ? (
        <div className="py-4 text-center text-[12px] text-cream-faint">Ничего не найдено</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(server => (
            <ServerCard
              key={server.id}
              server={server}
              installedIds={installedIds}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
            />
          ))}
        </div>
      )}

      <p className="text-[10px] text-cream-faint/60">
        После установки MCP-сервер запускается автоматически. Нажми «↻ применить» вверху чтобы обновить список инструментов.
      </p>
    </div>
  )
}
