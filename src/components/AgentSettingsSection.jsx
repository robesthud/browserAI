import { useEffect, useState } from 'react'

/**
 * Agent-mode settings: approval policy + MCP servers.
 *
 * Approval policy: each tool category (read/write/bash/git/deploy/mcp/net)
 * can be set to 'auto' (run silently) or 'ask' (show Approve/Deny pill
 * in the chat). Defaults match Cline's safer-by-default profile.
 *
 * MCP servers: list of registered servers from /api/mcp/status; allow
 * adding a stdio entry (command + args + env) or an SSE URL, enable/
 * disable, delete, and restart the hub to apply.
 */

const CAT_LABELS = {
  read:   ['Чтение',     'list_files, read_file, search_files, kb_search, …'],
  write:  ['Запись',     'edit_file, write_file, delete_file, replace_across_files'],
  net:    ['Сеть',       'web_search, web_fetch, download_url, browser_*'],
  bash:   ['Shell',      'bash, run_tests'],
  git:    ['Git',        'git_commit, git_push, github_pr_create'],
  mcp:    ['MCP-серверы','mcp__*'],
  deploy: ['Деплой',     'ops_run_action (build / deploy / restart)'],
}

const PRESETS = {
  yolo:   { label: 'YOLO',      hint: 'всё авто-апрув', values: { read:'auto', write:'auto', net:'auto', bash:'auto', git:'auto', mcp:'auto', deploy:'auto' } },
  safe:   { label: 'Безопасный',hint: 'cline-default',  values: { read:'auto', write:'auto', net:'auto', bash:'ask',  git:'ask',  mcp:'ask',  deploy:'ask'  } },
  strict: { label: 'Строгий',   hint: 'спрашивать всё', values: { read:'ask',  write:'ask',  net:'ask',  bash:'ask',  git:'ask',  mcp:'ask',  deploy:'ask'  } },
}

function policyMatchesPreset(p, preset) {
  return Object.keys(preset.values).every((k) => p[k] === preset.values[k])
}

export default function AgentSettingsSection() {

  // ── Approval policy ─────────────────────────────────────────────────
  const [policy, setPolicy] = useState(null)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [selfTest, setSelfTest] = useState(null)
  const [selfTestRunning, setSelfTestRunning] = useState(false)
  useEffect(() => {
    fetch('/api/approval/policy', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (j?.policy) setPolicy(j.policy) })
      .catch(() => { /* ignore */ })
  }, [])

  const savePolicy = async (nextPolicy = policy) => {
    if (!nextPolicy) return
    setSavingPolicy(true)
    try {
      setPolicy(nextPolicy)
      const r = await fetch('/api/approval/policy', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: nextPolicy }),
      })
      if (r.ok) {
        const j = await r.json()
        if (j?.policy) setPolicy(j.policy)
      }
    } finally { setSavingPolicy(false) }
  }

  const applyPreset = (name) => {
    const p = PRESETS[name]
    if (p) savePolicy({ ...p.values })
  }

  const updatePolicyCategory = (cat, value) => {
    if (!policy) return
    savePolicy({ ...policy, [cat]: value })
  }

  const runSelfTest = async () => {
    setSelfTestRunning(true)
    setSelfTest(null)
    try {
      const r = await fetch('/api/agent/self-test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json().catch(() => null)
      setSelfTest(j || { ok: false, error: `HTTP ${r.status}` })
    } catch (e) {
      setSelfTest({ ok: false, error: e?.message || String(e) })
    } finally {
      setSelfTestRunning(false)
    }
  }

  // v2.18: Export full agent trace — one-to-one with Arena Agent Mode
  const exportAgentTrace = () => {
    try {
      // Try to get current chat data from global (set by App/useChats)
      const chatData = window.__currentChat || null
      const messages = window.__currentMessages || []

      const trace = {
        exportedAt: new Date().toISOString(),
        schema: 'browserai.agent_trace.v1',
        version: 1,
        chatId: chatData?.id || null,
        title: chatData?.title || 'Untitled',
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          agentState: m.agentState || null,
          agentContext: m.agentContext || null,
          toolCalls: m.toolCalls || [],
          thoughts: m.thoughts || []
        })),
        note: 'Complete agent execution trace. Can be used for debugging and replay.'
      }

      const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `agent-trace-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Failed to export trace: ' + (e?.message || e))
    }
  }

  // ── MCP servers ─────────────────────────────────────────────────────
  const [mcp, setMcp] = useState({ servers: [] })
  const [mcpConfig, setMcpConfig] = useState({})
  const [restarting, setRestarting] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState('stdio')
  const [newCmd, setNewCmd] = useState('')
  const [newArgs, setNewArgs] = useState('')
  const [newEnv, setNewEnv] = useState('')
  const [newUrl, setNewUrl] = useState('')

  const refreshMcp = async () => {
    try {
      const [s, c] = await Promise.all([
        fetch('/api/mcp/status',  { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/mcp/config',  { credentials: 'include' }).then((r) => r.json()),
      ])
      setMcp(s || { servers: [] })
      setMcpConfig(c?.servers || {})
    } catch { /* ignore */ }
  }
  useEffect(() => { refreshMcp() }, [])

  const addMcp = async () => {
    if (!newName.trim()) return
    const cfg = newKind === 'sse'
      ? { url: newUrl.trim(), transport: 'sse', enabled: true }
      : {
          command: newCmd.trim(),
          args: newArgs.trim() ? newArgs.trim().split(/\s+/) : [],
          env: parseEnvLines(newEnv),
          enabled: true,
        }
    await fetch(`/api/mcp/server/${encodeURIComponent(newName.trim())}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    setNewName(''); setNewCmd(''); setNewArgs(''); setNewEnv(''); setNewUrl('')
    await refreshMcp()
  }

  const toggleEnabled = async (name, enabled) => {
    const cur = mcpConfig[name] || {}
    await fetch(`/api/mcp/server/${encodeURIComponent(name)}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cur, enabled }),
    })
    await refreshMcp()
  }

  const deleteMcp = async (name) => {
    if (!confirm(`Удалить MCP-сервер «${name}»?`)) return
    await fetch(`/api/mcp/server/${encodeURIComponent(name)}`, {
      method: 'DELETE', credentials: 'include',
    })
    await refreshMcp()
  }

  const restartMcp = async () => {
    setRestarting(true)
    try {
      await fetch('/api/mcp/restart', { method: 'POST', credentials: 'include' })
      await new Promise((r) => setTimeout(r, 800))
      await refreshMcp()
    } finally { setRestarting(false) }
  }

  return (
    <section className="space-y-5 border-t border-white/5 pt-4">
      {/* ── Approval policy ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-cream">Подтверждение действий агента</h3>
          <div className="flex flex-wrap justify-end gap-1">
            {Object.entries(PRESETS).map(([k, p]) => (
              <button
                key={k}
                type="button"
                onClick={() => applyPreset(k)}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
                  policy && policyMatchesPreset(policy, p)
                    ? 'border-cream bg-cream text-graphite-900'
                    : 'border-white/15 text-cream-soft hover:bg-graphite-700 hover:text-cream'
                }`}
                title={p.hint}
              >{p.label}</button>
            ))}
          </div>
        </div>
        {!policy ? (
          <div className="text-[12px] text-cream-faint">загружаю…</div>
        ) : (
          <div className="space-y-1">
            {Object.entries(CAT_LABELS).map(([cat, [label, hint]]) => (
              <div key={cat} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-graphite-900/40 px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-cream">{label}</div>
                  <div className="truncate text-[10px] text-cream-faint">{hint}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {['auto', 'ask'].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => updatePolicyCategory(cat, v)}
                      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition ${
                        policy[cat] === v
                          ? (v === 'auto' ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200' : 'border-amber-400/50 bg-amber-500/20 text-amber-200')
                          : 'border-white/10 text-cream-faint hover:bg-graphite-750'
                      }`}
                    >{v === 'auto' ? 'авто' : 'спрашивать'}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-[10px] text-cream-faint">Изменения применяются сразу.</span>
              <button
                type="button"
                onClick={() => savePolicy()}
                disabled={savingPolicy}
                className="rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition hover:scale-[1.02] disabled:opacity-50"
              >{savingPolicy ? 'Сохраняю…' : 'Сохранено'}</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Agent self-test ── */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-graphite-900/35 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-medium text-cream">Инструменты Агента</h3>
            <p className="mt-0.5 text-[11px] text-cream-faint">
              Диагностика и экспорт хода выполнения задач.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={runSelfTest}
              disabled={selfTestRunning}
              className="shrink-0 rounded-lg bg-cream px-3 py-1.5 text-[12px] font-medium text-graphite-900 transition hover:scale-[1.02] disabled:opacity-50"
            >{selfTestRunning ? 'Проверяю…' : 'Run self-test'}</button>
            <button
              type="button"
              onClick={exportAgentTrace}
              className="shrink-0 rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-medium text-cream transition hover:bg-white/10"
            >
              Export trace
            </button>
          </div>
        </div>

        {selfTest && (
          <div className={`rounded-lg border px-3 py-2 text-[11px] ${
            selfTest.ok
              ? 'border-emerald-400/30 bg-emerald-900/15 text-emerald-100'
              : 'border-red-400/30 bg-red-900/15 text-red-100'
          }`}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium">
                {selfTest.ok ? '✓ Agent self-test passed' : '✗ Agent self-test failed'}
              </span>
              <span className="font-mono text-[10px] opacity-80">
                {selfTest.passed ?? 0}/{(selfTest.passed ?? 0) + (selfTest.failed ?? 0)} checks
              </span>
            </div>
            {selfTest.error && <div className="mb-1">{selfTest.error}</div>}
            {Array.isArray(selfTest.checks) && (
              <details className="mt-1">
                <summary className="cursor-pointer select-none opacity-80">Показать checks</summary>
                <div className="mt-1 max-h-64 space-y-1 overflow-auto rounded bg-black/20 p-2">
                  {selfTest.checks.map((c) => (
                    <div key={c.name} className={c.ok ? 'text-emerald-200' : 'text-red-200'}>
                      {c.ok ? '✓' : '✗'} <span className="font-mono">{c.name}</span>
                      <span className="ml-1 opacity-70">{c.durationMs}ms</span>
                      {c.error && <div className="ml-4 text-red-200/90">{c.error}</div>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {/* ── MCP servers ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-cream">MCP-серверы</h3>
          <button
            type="button"
            onClick={restartMcp}
            disabled={restarting}
            className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-cream-soft hover:bg-graphite-750 hover:text-cream disabled:opacity-50"
          >{restarting ? 'Перезапуск…' : '↻ применить'}</button>
        </div>
        <div className="space-y-1">
          {mcp.servers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-[11px] text-cream-faint">
              Серверы не настроены. Добавьте ниже и нажмите «применить».
              <div className="mt-1 text-[10px] opacity-70">
                Примеры: <code>npx @modelcontextprotocol/server-filesystem /workspace</code>,
                <code> uvx mcp-server-github</code>, или SSE-URL.
              </div>
            </div>
          ) : (
            mcp.servers.map((s) => (
              <div key={s.name} className="flex items-center gap-2 rounded-lg border border-white/10 bg-graphite-900/40 px-2.5 py-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  s.status === 'ready' ? 'bg-emerald-400'
                  : s.status === 'starting' ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-400'
                }`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[12px] text-cream">{s.name}</span>
                    <span className="rounded bg-graphite-800 px-1 py-0.5 text-[9px] uppercase text-cream-faint">{s.transport}</span>
                    {s.status === 'ready' && (
                      <span className="text-[10px] text-cream-faint">{s.toolCount} tools</span>
                    )}
                  </div>
                  {s.error && (
                    <div className="truncate text-[10px] text-red-300" title={s.error}>{s.error}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => toggleEnabled(s.name, mcpConfig[s.name]?.enabled === false)}
                  className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-cream-soft hover:bg-graphite-750"
                >{mcpConfig[s.name]?.enabled === false ? '○ off' : '● on'}</button>
                <button
                  type="button"
                  onClick={() => deleteMcp(s.name)}
                  className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/30"
                >✕</button>
              </div>
            ))
          )}
        </div>

        {/* Add new */}
        <details className="rounded-lg border border-white/10 bg-graphite-900/30 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[11px] text-cream-soft">+ Добавить MCP-сервер</summary>
          <div className="mt-2 space-y-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="имя (например, filesystem)"
              className="w-full rounded border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
            />
            <div className="flex gap-1">
              {['stdio', 'sse'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setNewKind(k)}
                  className={`rounded border px-2 py-0.5 text-[11px] font-medium transition ${
                    newKind === k ? 'border-cream bg-cream text-graphite-900' : 'border-white/10 text-cream-soft hover:bg-graphite-750'
                  }`}
                >{k}</button>
              ))}
            </div>
            {newKind === 'stdio' ? (
              <>
                <input value={newCmd} onChange={(e) => setNewCmd(e.target.value)} placeholder="command (например, npx)" className="w-full rounded border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none" />
                <input value={newArgs} onChange={(e) => setNewArgs(e.target.value)} placeholder="args через пробел (например, -y @modelcontextprotocol/server-filesystem /workspace)" className="w-full rounded border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none" />
                <textarea value={newEnv} onChange={(e) => setNewEnv(e.target.value)} placeholder="env (KEY=VALUE на строку, опционально)" rows={2} className="w-full resize-none rounded border border-white/10 bg-graphite-900 px-2 py-1 text-[11px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none" />
              </>
            ) : (
              <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://example.com/sse" className="w-full rounded border border-white/10 bg-graphite-900 px-2 py-1 text-[12px] text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none" />
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={addMcp}
                disabled={!newName.trim() || (newKind === 'stdio' ? !newCmd.trim() : !newUrl.trim())}
                className="rounded-lg bg-cream px-3 py-1 text-[11px] font-medium text-graphite-900 transition hover:scale-[1.02] disabled:opacity-40"
              >Добавить</button>
            </div>
          </div>
        </details>
      </div>
    </section>
  )
}

function parseEnvLines(s) {
  const env = {}
  for (const line of String(s || '').split('\n')) {
    const t = line.trim()
    if (!t || !t.includes('=')) continue
    const idx = t.indexOf('=')
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim()
  }
  return env
}
