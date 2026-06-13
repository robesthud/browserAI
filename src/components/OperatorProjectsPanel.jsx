import { useEffect, useState } from 'react'

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

const empty = {
  id: 'browserai', name: 'BrowserAI', repo: 'robesthud/browserAI', localPath: '/workspace/projects/browserAI', productionPath: '/opt/browserai', defaultBranch: 'main',
  installCommand: 'npm ci --include=dev', testCommand: 'npm test', buildCommand: 'npm run build', lintCommand: 'npm run lint', healthUrl: 'http://127.0.0.1/api/health', branchPrefix: 'operator', deployRecipe: 'browserai_deploy_safe',
}

function formFromProject(p = {}) {
  return {
    id: p.id || empty.id,
    name: p.name || empty.name,
    repo: p.repo || empty.repo,
    localPath: p.localPath || empty.localPath,
    productionPath: p.productionPath || empty.productionPath,
    defaultBranch: p.defaultBranch || empty.defaultBranch,
    installCommand: p.meta?.commands?.install ?? empty.installCommand,
    testCommand: p.meta?.commands?.test ?? empty.testCommand,
    buildCommand: p.meta?.commands?.build ?? empty.buildCommand,
    lintCommand: p.meta?.commands?.lint ?? empty.lintCommand,
    healthUrl: p.meta?.deploy?.healthUrl ?? empty.healthUrl,
    branchPrefix: p.meta?.git?.branchPrefix ?? empty.branchPrefix,
    deployRecipe: p.meta?.deploy?.recipe ?? empty.deployRecipe,
  }
}

export default function OperatorProjectsPanel() {
  const [projects, setProjects] = useState([])
  const [templates, setTemplates] = useState([])
  const [adapters, setAdapters] = useState([])
  const [form, setForm] = useState(empty)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const refresh = async () => {
    try {
      const [data, tpl, adp] = await Promise.all([api('/api/operator/projects'), api('/api/operator/project-templates').catch(() => ({ templates: [] })), api('/api/operator/runtime-adapters').catch(() => ({ adapters: [] }))])
      setProjects(data.projects || [])
      setTemplates(tpl.templates || [])
      setAdapters(adp.adapters || [])
      if ((data.projects || []).length) setForm(formFromProject(data.projects[0]))
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }
  useEffect(() => { refresh().catch(() => {}) }, [])

  const save = async () => {
    try {
      const payload = {
        id: form.id, name: form.name, repo: form.repo, localPath: form.localPath, productionPath: form.productionPath, defaultBranch: form.defaultBranch,
        meta: {
          commands: { install: form.installCommand, test: form.testCommand, build: form.buildCommand, lint: form.lintCommand },
          deploy: { recipe: form.deployRecipe, healthUrl: form.healthUrl, productionPath: form.productionPath },
          git: { defaultBranch: form.defaultBranch, branchPrefix: form.branchPrefix, prBase: form.defaultBranch },
          runbooks: ['deploy.md', 'ci.md', 'incidents.md'],
        },
      }
      await api('/api/operator/projects', { method: 'POST', body: JSON.stringify(payload) })
      setSaved(true)
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
  }
  const analyze = async () => {
    if (!form.repo.trim()) { setError('Repo is required'); return }
    try {
      setSaved(false)
      const data = await api('/api/operator/projects/analyze', { method: 'POST', body: JSON.stringify({ repo: form.repo, id: form.id, name: form.name, localPath: form.localPath, productionPath: form.productionPath, defaultBranch: form.defaultBranch }) })
      setForm(formFromProject(data.project))
      setSaved(true)
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
  }
  const set = (key, val) => { setForm((f) => ({ ...f, [key]: val })); setSaved(false) }

  return (
    <section className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Operator Projects</h2>
          <p className="text-[12px] text-cream-faint">Project Registry v2: repo, paths, commands, health URL, deploy recipe and branch policy.</p>
        </div>
        <div className="flex gap-2"><button onClick={() => void analyze()} className="rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-1.5 text-[12px] text-violet-100 hover:bg-violet-500/20">Analyze project</button><button onClick={() => void save()} className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-100 hover:bg-emerald-500/20">{saved ? 'Saved' : 'Save project'}</button></div>
      </div>
      {error && <div className="mb-2 rounded border border-red-400/25 bg-red-500/10 p-2 text-[12px] text-red-200">{error}</div>}
      <div className="mb-3 flex flex-wrap gap-2">
        {projects.map((p) => <button key={p.id} onClick={() => setForm(formFromProject(p))} className="rounded border border-white/10 px-2 py-1 text-[11px] text-cream-soft hover:bg-white/5">{p.name}</button>)}
      </div>
      <div className="mb-3 rounded-xl border border-white/10 bg-black/15 p-3">
        <div className="mb-2 text-[12px] font-medium text-cream">Templates / presets</div>
        <div className="flex flex-wrap gap-1.5">
          {templates.map((t) => <button key={t.id} type="button" onClick={() => {
            set('installCommand', t.commands?.install || '')
            set('testCommand', t.commands?.test || '')
            set('buildCommand', t.commands?.build || '')
            set('lintCommand', t.commands?.lint || '')
          }} className="rounded border border-white/10 px-2 py-1 text-[11px] text-cream-soft hover:bg-white/5" title={(t.notes || []).join(' | ')}>{t.label}</button>)}
        </div>
      </div>

      <div className="mb-3 rounded-xl border border-white/10 bg-black/15 p-3">
        <div className="mb-2 text-[12px] font-medium text-cream">Runtime adapters</div>
        <div className="flex flex-wrap gap-1.5">
          {adapters.map((a) => <button key={a.id} type="button" onClick={() => {
            set('testCommand', a.commandHints?.test || form.testCommand)
            set('buildCommand', a.commandHints?.build || form.buildCommand)
            set('lintCommand', a.commandHints?.lint || form.lintCommand)
          }} className="rounded border border-white/10 px-2 py-1 text-[11px] text-cream-soft hover:bg-white/5" title={(a.riskHints || []).join(' | ')}>{a.label}</button>)}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        {[['id','ID'],['name','Name'],['repo','GitHub repo / URL'],['localPath','Workspace path'],['productionPath','Production path'],['defaultBranch','Default branch'],['branchPrefix','Branch prefix'],['healthUrl','Health URL'],['deployRecipe','Deploy recipe'],['installCommand','Install command'],['testCommand','Test command'],['buildCommand','Build command'],['lintCommand','Lint command']].map(([key,label]) => (
          <label key={key} className="text-[11px] text-cream-faint">{label}
            <input value={form[key] || ''} onChange={(e) => set(key, e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-graphite-900 px-2 py-1.5 text-[12px] text-cream focus:outline-none" />
          </label>
        ))}
      </div>
    </section>
  )
}
