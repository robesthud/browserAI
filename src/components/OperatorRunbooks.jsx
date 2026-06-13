import { useEffect, useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

export default function OperatorRunbooks() {
  const [list, setList] = useState(null)
  const [active, setActive] = useState('lessons.md')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const refresh = async () => {
    try {
      const data = await api('/api/operator/runbooks')
      setList(data)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }
  const load = async (name) => {
    setActive(name)
    setSaved(false)
    try {
      const data = await api(`/api/operator/runbooks/${encodeURIComponent(name)}`)
      setText(data.runbook?.text || '')
    } catch (e) { setError(e.message || String(e)) }
  }
  const save = async () => {
    try {
      await api(`/api/operator/runbooks/${encodeURIComponent(active)}`, { method: 'POST', body: JSON.stringify({ text }) })
      setSaved(true); await refresh()
    } catch (e) { setError(e.message || String(e)) }
  }

  useEffect(() => { refresh().then(() => load('lessons.md')).catch(() => {}) }, [])
  const files = [{ name: 'lessons.md', path: '.browserai/lessons.md' }, ...(list?.runbooks || [])]
  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Runbook Memory</h2>
          <p className="text-[12px] text-cream-faint">Постоянная память оператора: deploy/CI/incident runbooks и lessons learned.</p>
        </div>
        <button onClick={() => void refresh()} className="rounded-lg border border-white/10 px-2.5 py-1 text-[12px] text-cream-soft hover:bg-graphite-750">↻</button>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
        <div className="space-y-1 rounded-xl border border-white/10 bg-black/15 p-2">
          {files.map((f) => (
            <button key={f.name} onClick={() => void load(f.name)} className={`block w-full rounded px-2 py-1.5 text-left text-[12px] ${active === f.name ? 'bg-violet-500/20 text-violet-100' : 'text-cream-soft hover:bg-white/5'}`}>
              {f.name}
            </button>
          ))}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-mono text-[11px] text-cream-faint">.browserai/{active === 'lessons.md' ? active : `runbooks/${active}`}</div>
            <button onClick={() => void save()} className="rounded border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-[12px] text-emerald-100 hover:bg-emerald-500/20">{saved ? 'Saved' : 'Save'}</button>
          </div>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setSaved(false) }} rows={18} className="w-full rounded-xl border border-white/10 bg-graphite-900 p-3 font-mono text-[12px] text-cream focus:outline-none" />
        </div>
      </div>
    </section>
  )
}
