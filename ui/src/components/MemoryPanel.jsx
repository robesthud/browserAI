import { useState, useEffect, useCallback } from 'react'

/**
 * MemoryPanel — UI управления памятью агента.
 * Показывает user_facts и semantic_memory, позволяет удалять.
 */

async function apiFetch(url, opts = {}) {
  const r = await fetch(url, { credentials: 'include', ...opts })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  return data
}

function FactRow({ item, onForget }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-graphite-900/40 px-2.5 py-2 text-[12px]">
      <div className="flex-1 min-w-0">
        <span className="font-mono text-cream-faint text-[10px]">{item.key}</span>
        <div className="truncate text-cream" title={item.value}>{item.value}</div>
      </div>
      <button
        onClick={() => onForget(item.key)}
        className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-red-500/20 hover:text-red-400 transition-colors"
        title="Забыть"
      >✕</button>
    </div>
  )
}

function MemoryRow({ item, onForget }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-graphite-900/40 px-2.5 py-2 text-[12px]">
      <div className="flex-1 min-w-0">
        <div className="truncate text-cream" title={item.text}>{item.text}</div>
        <div className="text-[10px] text-cream-faint mt-0.5">
          Использовано: {item.score_hits || 0} раз
        </div>
      </div>
      <button
        onClick={() => onForget(item.id)}
        className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-red-500/20 hover:text-red-400 transition-colors"
        title="Забыть"
      >✕</button>
    </div>
  )
}

export default function MemoryPanel() {
  const [tab, setTab] = useState('facts')
  const [facts, setFacts] = useState([])
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(null)

  const [projectFacts, setProjectFacts] = useState([])
  const chatId = (() => {
    try { return window.__currentChat?.id || '' } catch { return '' }
  })()

  const loadProjectFacts = useCallback(async () => {
    if (!chatId) return
    try {
      const d = await apiFetch(`/api/memory/project?chatId=${encodeURIComponent(chatId)}`)
      setProjectFacts(d.facts || [])
    } catch (e) { console.warn('[MemoryPanel] loadProjectFacts failed:', e.message) }
  }, [chatId])

  const loadFacts = useCallback(async () => {
    try {
      const d = await apiFetch('/api/memory/facts')
      setFacts(d.facts || [])
    } catch (e) {
      // BUG-7: surface load errors silently (user sees empty list)
      console.warn('[MemoryPanel] loadFacts failed:', e.message)
    }
  }, [])

  const loadMemories = useCallback(async () => {
    try {
      const d = await apiFetch('/api/memory/semantic?limit=30')
      setMemories(d.memories || [])
    } catch (e) {
      console.warn('[MemoryPanel] loadMemories failed:', e.message)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadFacts(), loadMemories(), loadProjectFacts()]).finally(() => setLoading(false))
  }, [loadFacts, loadMemories, loadProjectFacts])

  const forgetProjectFactFn = async (key) => {
    if (!chatId) return
    await apiFetch(`/api/memory/project/${encodeURIComponent(chatId)}/${encodeURIComponent(key)}`, { method: 'DELETE' })
    setStatus('Факт проекта удалён')
    setTimeout(() => setStatus(null), 2000)
    loadProjectFacts()
  }

  const forgetFact = async (key) => {
    await apiFetch(`/api/memory/facts/${encodeURIComponent(key)}`, { method: 'DELETE' })
    setStatus('Факт удалён')
    setTimeout(() => setStatus(null), 2000)
    loadFacts()
  }

  const forgetMemory = async (id) => {
    await apiFetch(`/api/memory/semantic/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setStatus('Воспоминание удалено')
    setTimeout(() => setStatus(null), 2000)
    loadMemories()
  }

  const clearAll = async () => {
    if (!confirm('Удалить всю память агента?')) return
    // BUG-8: snapshot current lists before async deletes to avoid stale-closure issues
    const currentFacts = [...facts]
    const currentMemories = [...memories]
    try {
      for (const f of currentFacts) await apiFetch(`/api/memory/facts/${encodeURIComponent(f.key)}`, { method: 'DELETE' })
      for (const m of currentMemories) await apiFetch(`/api/memory/semantic/${encodeURIComponent(m.id)}`, { method: 'DELETE' })
      setStatus('Память очищена')
    } catch (e) {
      setStatus(`Ошибка: ${e.message}`)
    }
    setTimeout(() => setStatus(null), 2000)
    loadFacts(); loadMemories()
  }

  const total = facts.length + memories.length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-cream">🧠 Память агента</h3>
        <div className="flex items-center gap-2">
          {status && <span className="text-[10px] text-green-400">{status}</span>}
          {total > 0 && (
            <button
              onClick={clearAll}
              className="rounded border border-red-500/20 px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10 transition-colors"
            >Очистить всё</button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {[
          { id: 'facts', label: `Факты (${facts.length})` },
          { id: 'semantic', label: `Воспоминания (${memories.length})` },
          ...(chatId ? [{ id: 'project', label: `Проект (${projectFacts.length})` }] : []),
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              tab === t.id
                ? 'border-cream bg-cream text-graphite-900 font-medium'
                : 'border-white/10 text-cream-soft hover:bg-graphite-750'
            }`}
          >{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="py-4 text-center text-[12px] text-cream-faint">Загрузка…</div>
      ) : tab === 'facts' ? (
        facts.length === 0
          ? <div className="py-3 text-center text-[11px] text-cream-faint">Нет сохранённых фактов.<br/><span className="opacity-60">Агент запоминает их через remember_fact или автоматически.</span></div>
          : <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {facts.map(f => <FactRow key={f.key} item={f} onForget={forgetFact} />)}
            </div>
      ) : tab === 'semantic' ? (
        memories.length === 0
          ? <div className="py-3 text-center text-[11px] text-cream-faint">Нет семантических воспоминаний.<br/><span className="opacity-60">Агент накапливает их после каждой сессии.</span></div>
          : <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {memories.map(m => <MemoryRow key={m.id} item={m} onForget={forgetMemory} />)}
            </div>
      ) : (
        projectFacts.length === 0
          ? <div className="py-3 text-center text-[11px] text-cream-faint">Нет контекста проекта.<br/><span className="opacity-60">Агент запоминает стек, сервер, команды этого чата.</span></div>
          : <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {projectFacts.map(f => <FactRow key={f.key} item={f} onForget={forgetProjectFactFn} />)}
            </div>
      )}
    </div>
  )
}
