import fs from 'fs'

let code = fs.readFileSync('src/components/AgentAdmin.jsx', 'utf8')

// Add a hook to read settings from localStorage
code = code.replace(
  "const [loadingMeta, setLoadingMeta] = useState(false)",
  `const [loadingMeta, setLoadingMeta] = useState(false)
  const [providerDiag, setProviderDiag] = useState(null)
  const [loadingDiag, setLoadingDiag] = useState(false)`
)

const diagRefreshCode = `
  const refreshDiag = async () => {
    setLoadingDiag(true)
    setProviderDiag(null)
    try {
      const rawSettings = localStorage.getItem('browserai.settings')
      if (!rawSettings) throw new Error('No settings found in localStorage')
      const settings = JSON.parse(rawSettings)
      const providerId = settings.activeProvider || 'openrouter'
      const pData = settings.providers?.[providerId] || {}
      
      let baseUrl = pData.baseUrl
      let apiKey = pData.apiKey
      let model = pData.model
      
      // Fallbacks based on defaults
      if (providerId === 'openrouter') {
         baseUrl = baseUrl || 'https://openrouter.ai/api/v1'
         model = model || 'anthropic/claude-3.5-sonnet'
      } else if (providerId === 'anthropic') {
         baseUrl = baseUrl || 'https://api.anthropic.com/v1'
         model = model || 'claude-3-5-sonnet-latest'
      } else if (providerId === 'gemini') {
         baseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
         model = model || 'gemini-2.5-flash'
      } else if (providerId === 'deepseek') {
         baseUrl = baseUrl || 'https://api.deepseek.com/v1'
         model = model || 'deepseek-chat'
      }

      const r = await fetch('/api/agent/provider/diagnose', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          apiKey,
          model,
          runProbe: true
        })
      })
      const data = await r.json()
      setProviderDiag(data)
    } catch (e) {
      setProviderDiag({ ok: false, providerError: { message: e.message } })
    } finally {
      setLoadingDiag(false)
    }
  }

  useEffect(() => { 
    refreshMeta() 
    refreshDiag()
  }, [])
`

code = code.replace(
  "useEffect(() => { refreshMeta() }, [])",
  diagRefreshCode.trim()
)

const diagUiCode = `
          <div className="rounded-2xl border border-white/10 bg-graphite-800/45 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-medium">Provider Diagnostics</h2>
                <p className="text-[12px] text-cream-faint">Live check for current active model.</p>
              </div>
              <button
                type="button"
                onClick={refreshDiag}
                disabled={loadingDiag}
                className="rounded-lg border border-white/10 px-2.5 py-1 text-[12px] text-cream-soft hover:bg-graphite-750 disabled:opacity-50"
              >↻</button>
            </div>
            {providerDiag ? (
               <div className="space-y-3">
                 <div className="flex items-center gap-2">
                    <StatusPill ok={Boolean(providerDiag.ok)}>{providerDiag.ok ? 'OK' : 'ERROR'}</StatusPill>
                    <span className="text-[12px] text-cream-faint">{providerDiag.capabilities?.kind || 'unknown'}</span>
                 </div>
                 {providerDiag.providerError && (
                   <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-200">
                     {providerDiag.providerError.message}
                   </div>
                 )}
                 <details>
                   <summary className="cursor-pointer text-[12px] text-cream-faint">Raw JSON</summary>
                   <div className="mt-2"><JsonBlock data={providerDiag} /></div>
                 </details>
               </div>
            ) : <div className="text-[12px] text-cream-faint">загрузка…</div>}
          </div>
`

code = code.replace(
  "<div className=\"rounded-2xl border border-white/10 bg-graphite-800/45 p-4\">\n            <div className=\"mb-3\">\n              <h2 className=\"text-[15px] font-medium\">Workspace Metadata</h2>",
  diagUiCode + "\n\n          <div className=\"rounded-2xl border border-white/10 bg-graphite-800/45 p-4\">\n            <div className=\"mb-3\">\n              <h2 className=\"text-[15px] font-medium\">Workspace Metadata</h2>"
)

fs.writeFileSync('src/components/AgentAdmin.jsx', code)
