import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Quick chat search (Ctrl+K). Searches across:
 *   - chat title
 *   - every message content
 *   - tool-call args/results (preview)
 * Ranks by recency; clicking jumps to the chat.
 *
 * Pure-client component — uses the same `chats` array App already holds.
 */
export default function ChatSearchModal({ open, onClose, chats, onSelectChat }) {
  const [q, setQ] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    setQ('')
    // Focus the input as soon as the modal mounts.
    const id = setTimeout(() => inputRef.current?.focus(), 60)
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(id); window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  const results = useMemo(() => {
    if (!open) return []
    const needle = q.trim().toLowerCase()
    if (!needle) {
      // No query → most-recent chats
      return [...(chats || [])]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 25)
        .map((c) => ({ chat: c, hit: '', score: 0 }))
    }
    const hits = []
    for (const c of chats || []) {
      let score = 0
      let hit = ''
      const inTitle = String(c.title || '').toLowerCase().includes(needle)
      if (inTitle) { score += 10; hit = c.title }
      for (const m of c.messages || []) {
        const s = String(m.content || '').toLowerCase()
        if (s.includes(needle)) {
          score += m.role === 'user' ? 3 : 2
          if (!hit) {
            const idx = s.indexOf(needle)
            const start = Math.max(0, idx - 40)
            hit = (start > 0 ? '…' : '') + String(m.content).slice(start, idx + needle.length + 60)
          }
        }
        for (const tc of m.toolCalls || []) {
          const blob = JSON.stringify(tc.args || {}) + ' ' + JSON.stringify(tc.result || {})
          if (blob.toLowerCase().includes(needle)) { score += 1; if (!hit) hit = `tool ${tc.name}` }
        }
      }
      if (score > 0) hits.push({ chat: c, hit, score: score + (c.updatedAt || 0) / 1e13 })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 25)
  }, [open, q, chats])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-graphite-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="text-cream-faint">🔎</span>
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по чатам, сообщениям, tool-calls…"
            className="w-full bg-transparent text-[14px] text-cream placeholder:text-cream-faint focus:outline-none"
          />
          <kbd className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-cream-faint">Esc</kbd>
        </div>
        <div className="thin-scroll max-h-[60vh] overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-cream-faint">Ничего не найдено</div>
          ) : results.map(({ chat, hit }) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => { onSelectChat?.(chat.id); onClose?.() }}
              className="block w-full border-b border-white/5 px-4 py-2.5 text-left hover:bg-white/5"
            >
              <div className="truncate text-[13px] font-medium text-cream">{chat.title || 'Новый чат'}</div>
              {hit && (
                <div className="mt-0.5 truncate text-[11px] text-cream-faint">{hit}</div>
              )}
              <div className="mt-0.5 text-[10px] text-cream-faint/70">
                {chat.messages?.length || 0} сообщений · {new Date(chat.updatedAt || 0).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
