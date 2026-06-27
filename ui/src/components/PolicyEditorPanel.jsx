import { useState, useEffect } from 'react'

/**
 * PolicyEditorPanel — Package H: Policy Editor UI
 * Управление политиками безопасности и бюджетами.
 */

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'include', ...opts })
  return r.json().catch(() => ({}))
}

const POLICY_PRESETS = [
  { id: 'safe',               label: 'Safe',               desc: 'Только чтение/планирование. PR, merge, deploy — вручную.' },
  { id: 'balanced',           label: 'Balanced (default)', desc: 'Код + PR + CI + auto-fix. Merge/deploy требуют подтверждения.' },
  { id: 'autonomous',         label: 'Autonomous',         desc: 'Авто-merge для нерискованных задач. Deploy требует подтверждения.' },
  { id: 'production_critical',label: 'Production Critical', desc: 'Строгий режим: CI + ревью обязательны, production writes всегда с подтверждением.' },
]

function Toggle({ value, onChange, label, desc }) {
  return (
    <label className="flex items-start justify-between gap-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-cream">{label}</div>
        {desc && <div className="text-[11px] text-cream-faint mt-0.5">{desc}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative mt-0.5 h-5 w-9 flex-shrink-0 rounded-full transition-colors ${value ? 'bg-emerald-500' : 'bg-graphite-700'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
    </label>
  )
}

function NumberField({ value, onChange, label, min = 0, max = 100, desc }) {
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-cream">{label}</div>
          {desc && <div className="text-[11px] text-cream-faint">{desc}</div>}
        </div>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={e => onChange(Number(e.target.value))}
          className="w-20 rounded border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream text-center focus:border-cream/30 focus:outline-none"
        />
      </div>
    </div>
  )
}

export default function PolicyEditorPanel() {
  const [projects, setProjects] = useState([])
  const [selectedId, setSelectedId] = useState('browserai')
  const [policy, setPolicy] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [auditLog, setAuditLog] = useState([])
  const [showAudit, setShowAudit] = useState(false)

  useEffect(() => {
    api('/api/operator/projects').then(d => {
      setProjects(d.projects || [])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedId) return
    api(`/api/operator/projects`).then(d => {
      const p = (d.projects || []).find(p => p.id === selectedId)
      if (p?.meta?.policy) setPolicy({ ...p.meta.policy })
    }).catch(() => {})
  }, [selectedId])

  useEffect(() => {
    if (!showAudit) return
    api('/api/ops/audit?limit=30').then(d => {
      setAuditLog(Array.isArray(d) ? d : [])
    }).catch(() => {})
  }, [showAudit])

  const applyPreset = (presetId) => {
    const presets = {
      safe: { allowed: { code: true, shell: true, createPr: false, waitCi: true, autoFixCi: false, merge: false, deploy: false, productionWrite: false }, requireApproval: { merge: true, deploy: true, productionWrite: true, highRiskReview: true }, limits: { maxRuntimeMin: 60, maxCiFixAttempts: 1, maxChangedFiles: 50 } },
      balanced: { allowed: { code: true, shell: true, createPr: true, waitCi: true, autoFixCi: true, merge: true, deploy: true, productionWrite: true }, requireApproval: { merge: true, deploy: true, productionWrite: true, highRiskReview: true }, limits: { maxRuntimeMin: 60, maxCiFixAttempts: 2, maxChangedFiles: 80 } },
      autonomous: { allowed: { code: true, shell: true, createPr: true, waitCi: true, autoFixCi: true, merge: true, deploy: true, productionWrite: true }, requireApproval: { merge: false, deploy: true, productionWrite: true, highRiskReview: true }, limits: { maxRuntimeMin: 120, maxCiFixAttempts: 3, maxChangedFiles: 100 } },
      production_critical: { allowed: { code: true, shell: true, createPr: true, waitCi: true, autoFixCi: true, merge: true, deploy: true, productionWrite: true }, requireApproval: { merge: true, deploy: true, productionWrite: true, highRiskReview: true }, limits: { maxRuntimeMin: 60, maxCiFixAttempts: 2, maxChangedFiles: 40 } },
    }
    setPolicy(p => ({ ...p, ...presets[presetId], preset: presetId }))
  }

  const save = async () => {
    if (!policy || !selectedId) return
    setSaving(true)
    try {
      await api(`/api/operator/projects/${encodeURIComponent(selectedId)}/policy`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* best-effort */ }
    finally { setSaving(false) }
  }

  const setAllowed = (key, val) => setPolicy(p => ({ ...p, allowed: { ...p.allowed, [key]: val } }))
  const setApproval = (key, val) => setPolicy(p => ({ ...p, requireApproval: { ...p.requireApproval, [key]: val } }))
  const setLimit = (key, val) => setPolicy(p => ({ ...p, limits: { ...p.limits, [key]: val } }))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-cream">🛡️ Редактор политик</h2>
        {saved && <span className="text-[12px] text-green-400">✓ Сохранено</span>}
      </div>

      {/* Project selector */}
      <div className="flex gap-2 flex-wrap">
        {projects.map(p => (
          <button key={p.id} onClick={() => setSelectedId(p.id)}
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${selectedId === p.id ? 'border-violet-400/40 bg-violet-500/20 text-violet-100' : 'border-white/10 text-cream-faint hover:bg-white/5'}`}
          >{p.name || p.id}</button>
        ))}
      </div>

      {policy && (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Preset buttons */}
          <div className="rounded-xl border border-white/10 bg-graphite-900/40 p-4 md:col-span-2">
            <div className="mb-3 text-[12px] font-medium text-cream-soft">Пресеты</div>
            <div className="flex flex-wrap gap-2">
              {POLICY_PRESETS.map(pr => (
                <button key={pr.id} onClick={() => applyPreset(pr.id)}
                  className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${policy.preset === pr.id ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-cream-faint hover:bg-white/5'}`}
                  title={pr.desc}
                >{pr.label}</button>
              ))}
            </div>
          </div>

          {/* Allowed actions */}
          <div className="rounded-xl border border-white/10 bg-graphite-900/40 p-4">
            <div className="mb-2 text-[12px] font-medium text-cream-soft">Разрешённые действия</div>
            <div className="divide-y divide-white/5">
              <Toggle value={policy.allowed?.code} onChange={v => setAllowed('code', v)} label="Изменение кода" desc="write_file, edit_file, bash" />
              <Toggle value={policy.allowed?.createPr} onChange={v => setAllowed('createPr', v)} label="Создание PR" desc="git push + PR creation" />
              <Toggle value={policy.allowed?.waitCi} onChange={v => setAllowed('waitCi', v)} label="Ожидание CI" />
              <Toggle value={policy.allowed?.autoFixCi} onChange={v => setAllowed('autoFixCi', v)} label="Авто-фикс CI" />
              <Toggle value={policy.allowed?.merge} onChange={v => setAllowed('merge', v)} label="Merge PR" />
              <Toggle value={policy.allowed?.deploy} onChange={v => setAllowed('deploy', v)} label="Deploy" />
              <Toggle value={policy.allowed?.productionWrite} onChange={v => setAllowed('productionWrite', v)} label="Production writes" />
            </div>
          </div>

          {/* Approval requirements */}
          <div className="rounded-xl border border-white/10 bg-graphite-900/40 p-4">
            <div className="mb-2 text-[12px] font-medium text-cream-soft">Требуют подтверждения</div>
            <div className="divide-y divide-white/5">
              <Toggle value={policy.requireApproval?.merge} onChange={v => setApproval('merge', v)} label="Merge PR" />
              <Toggle value={policy.requireApproval?.deploy} onChange={v => setApproval('deploy', v)} label="Deploy" />
              <Toggle value={policy.requireApproval?.productionWrite} onChange={v => setApproval('productionWrite', v)} label="Production writes" />
              <Toggle value={policy.requireApproval?.highRiskReview} onChange={v => setApproval('highRiskReview', v)} label="Высокий риск" desc="Блокирует merge/deploy без одобрения" />
            </div>
          </div>

          {/* Limits */}
          <div className="rounded-xl border border-white/10 bg-graphite-900/40 p-4">
            <div className="mb-2 text-[12px] font-medium text-cream-soft">Лимиты</div>
            <div className="divide-y divide-white/5">
              <NumberField value={policy.limits?.maxRuntimeMin || 60} onChange={v => setLimit('maxRuntimeMin', v)} label="Макс. время миссии (мин)" min={5} max={480} />
              <NumberField value={policy.limits?.maxCiFixAttempts || 2} onChange={v => setLimit('maxCiFixAttempts', v)} label="Макс. попыток CI auto-fix" min={0} max={5} />
              <NumberField value={policy.limits?.maxChangedFiles || 80} onChange={v => setLimit('maxChangedFiles', v)} label="Макс. изменённых файлов" min={1} max={500} />
            </div>
          </div>

          {/* Save button */}
          <div className="md:col-span-2 flex justify-end">
            <button onClick={save} disabled={saving}
              className="rounded-lg bg-violet-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
            >{saving ? 'Сохранение…' : 'Сохранить политику'}</button>
          </div>
        </div>
      )}

      {/* Audit Log */}
      <div className="rounded-xl border border-white/10 bg-graphite-900/40 p-4">
        <button onClick={() => setShowAudit(v => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <span className="text-[13px] font-medium text-cream">📋 Audit Log (ops actions)</span>
          <span className="text-cream-faint text-[11px]">{showAudit ? '▼ скрыть' : '▶ показать'}</span>
        </button>
        {showAudit && (
          <div className="mt-3 space-y-1 max-h-64 overflow-y-auto">
            {auditLog.length === 0
              ? <div className="text-[11px] text-cream-faint">Нет записей</div>
              : auditLog.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-cream-faint">
                  <span className="font-mono text-[10px] opacity-60">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className={`rounded px-1 ${e.status === 'ok' ? 'text-green-400' : 'text-red-400'}`}>{e.status}</span>
                  <span>{e.service}.{e.action}</span>
                  {e.ms && <span className="opacity-50">{e.ms}ms</span>}
                </div>
              ))
            }
          </div>
        )}
      </div>
    </div>
  )
}
