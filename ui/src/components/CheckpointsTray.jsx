import { useEffect, useState } from 'react'

/**
 * Cline-style session checkpoints.
 *
 * Lists all (step, label, files[]) tuples for the current chat and
 * offers one-click restore that reverts every file touched on that
 * step back to its pre-edit snapshot. The restore itself is recorded
 * as another revision, so it's also undoable.
 *
 * Rendered as a small overlay anchored to the sidebar / topbar. Folds
 * collapsed by default — the user clicks 💾 to open it.
 */
export default function CheckpointsTray({ chatId, open, onClose }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(null) // step currently being restored
  const [toast, setToast] = useState(null)

  const refresh = async () => {
    if (!chatId) return
    setLoading(true)
    try {
      const r = await fetch(`/api/checkpoints/${encodeURIComponent(chatId)}`, { credentials: 'include' })
      if (!r.ok) { setItems([]); return }
      const j = await r.json()
      setItems(j.checkpoints || [])
    } catch { setItems([]) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (open) refresh() }, [open, chatId])

  const restore = async (step) => {
    if (!chatId) return
    if (!confirm(`Откатить все файлы хода #${step} к снапшоту?\nЭто перезапишет текущие версии. Сам откат тоже будет в истории (можно отменить через file_history).`)) return
    setBusy(step)
    try {
      const r = await fetch(`/api/checkpoints/${encodeURIComponent(chatId)}/restore`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step }),
      })
      const j = await r.json()
      if (j?.ok) {
        const n = (j.restored || []).length
        const f = (j.failed || []).length
        setToast({ kind: f ? 'warn' : 'ok', text: `Откат хода #${step}: восстановлено ${n}${f ? `, ошибки на ${f}` : ''}` })
      } else {
        setToast({ kind: 'err', text: j?.error || 'Ошибка отката' })
      }
      setTimeout(() => setToast(null), 4500)
    } catch (e) {
      setToast({ kind: 'err', text: e?.message || 'Сеть' })
      setTimeout(() => setToast(null), 4500)
    } finally { setBusy(null) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-end p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative mt-12 w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-graphite-800 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[14px] text-cream">💾 Контрольные точки</span>
            <button onClick={refresh} className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-cream-faint hover:bg-graphite-750 hover:text-cream">↻</button>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded text-cream-dim hover:bg-graphite-750 hover:text-cream">✕</button>
        </div>
        <div className="thin-scroll max-h-[60vh] space-y-1.5 overflow-y-auto px-4 py-3">
          {loading && <div className="text-[12px] text-cream-faint">загружаю…</div>}
          {!loading && items.length === 0 && (
            <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-cream-faint">
              Пока пусто. Контрольные точки создаются автоматически после
              каждого write/edit-вызова агента в этом чате.
            </div>
          )}
          {items.map((it) => (
            <div key={`${it.step}-${it.ts}`} className="rounded-lg border border-white/10 bg-graphite-900/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-graphite-800 px-1.5 py-0.5 font-mono text-[10px] text-cream-faint">#{it.step}</span>
                  <span className="font-mono text-[11px] text-cream">{it.label}</span>
                  <span className="text-[10px] text-cream-faint">{it.fileCount} файл(ов)</span>
                </div>
                <button
                  type="button"
                  onClick={() => restore(it.step)}
                  disabled={busy === it.step}
                  className="rounded-md border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition hover:bg-amber-500/25 disabled:opacity-50"
                  title="Откатить все файлы этого хода"
                >{busy === it.step ? '…' : '↶ откатить'}</button>
              </div>
              {it.files.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {it.files.slice(0, 8).map((f) => (
                    <code key={f} className="rounded bg-graphite-800 px-1 py-0.5 font-mono text-[10px] text-cream-soft">{f}</code>
                  ))}
                  {it.files.length > 8 && (
                    <span className="text-[10px] text-cream-faint">+{it.files.length - 8}</span>
                  )}
                </div>
              )}
              <div className="mt-1 text-[10px] text-cream-faint">{new Date(it.ts).toLocaleString()}</div>
            </div>
          ))}
        </div>
        {toast && (
          <div className={`border-t px-4 py-2 text-[11px] ${
            toast.kind === 'ok'   ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' :
            toast.kind === 'warn' ? 'border-amber-400/30 bg-amber-500/10 text-amber-200' :
                                    'border-red-400/30 bg-red-500/10 text-red-200'
          }`}>{toast.text}</div>
        )}
      </div>
    </div>
  )
}
