/**
 * mcpClient.js
 *
 * Lightweight MCP (Model Context Protocol) client for BrowserAI.
 *
 * Supports two transports:
 *   • stdio  → spawn a local process, JSON-RPC 2.0 framed by newline
 *   • sse    → connect to an HTTP server, POST /messages, listen on /sse
 *
 * Config lives at /data/mcp.json (gitignored, persisted across deploys):
 *   {
 *     "servers": {
 *       "filesystem":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"], "enabled": true },
 *       "postgres":    { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://…"], "enabled": false },
 *       "github":      { "command": "uvx",  "args": ["mcp-server-github"], "env": { "GITHUB_TOKEN": "…" }, "enabled": true },
 *       "linear":      { "url": "https://mcp.linear.app/sse", "transport": "sse", "enabled": false }
 *     }
 *   }
 *
 * Each enabled server is started at boot. We list its tools and inject
 * them into agentTools at runtime — every MCP tool becomes
 *   `mcp__${serverName}__${toolName}`
 * which the agent can invoke like any other tool.
 *
 * This gives BrowserAI access to the thousands of off-the-shelf MCP
 * servers in the public catalog (filesystem, postgres, github, linear,
 * slack, notion, brave-search, puppeteer, …).
 *
 * Public:
 *   startMcpHub()          — spawn all enabled servers (called from index.js boot)
 *   stopMcpHub()           — gracefully terminate all
 *   listMcpTools()         — { [fullName]: descriptor }
 *   invokeMcpTool(name, args) — RPC into the right server
 *   getMcpServerStatus()   — for UI
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CONFIG_PATH = process.env.MCP_CONFIG_PATH || '/data/mcp.json'

const servers = new Map() // name → { proc, transport, status, tools, capabilities, error }

// JSON-RPC bookkeeping per server
function makeRpcState() {
  return {
    nextId: 1,
    pending: new Map(),     // id → {resolve, reject, timer}
    buffer: '',
  }
}

async function loadConfig() {
  try {
    const txt = await fs.readFile(CONFIG_PATH, 'utf8')
    const cfg = JSON.parse(txt)
    return cfg?.servers || {}
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Write a stub so the user can find it.
      try {
        await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
        await fs.writeFile(CONFIG_PATH, JSON.stringify({
          _comment: 'BrowserAI MCP config. Add a server entry and restart. See https://modelcontextprotocol.io/servers',
          servers: {},
        }, null, 2))
      } catch { /* ignore */ }
      return {}
    }
    console.warn('[mcp] config load failed:', e.message)
    return {}
  }
}

async function saveConfig(serversObj) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ servers: serversObj }, null, 2))
}

// ── stdio transport ─────────────────────────────────────────────────────────
function startStdioServer(name, cfg) {
  const env = { ...process.env, ...(cfg.env || {}) }
  const proc = spawn(cfg.command, cfg.args || [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const rpc = makeRpcState()
  const slot = { name, transport: 'stdio', proc, rpc, status: 'starting', tools: [], capabilities: {}, error: null, cfg }
  servers.set(name, slot)

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    rpc.buffer += chunk
    let nlIdx
    while ((nlIdx = rpc.buffer.indexOf('\n')) >= 0) {
      const line = rpc.buffer.slice(0, nlIdx).trim()
      rpc.buffer = rpc.buffer.slice(nlIdx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        handleRpcMessage(slot, msg)
      } catch (e) {
        // Some servers print logging on stdout — non-JSON lines are ignored.
      }
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => {
    // Aggregate stderr into error for visibility, but don't kill server.
    const msg = String(chunk || '').slice(0, 4000)
    if (msg.toLowerCase().includes('error')) slot.error = msg.slice(0, 500)
  })
  proc.on('exit', (code) => {
    slot.status = 'exited'
    slot.error = (slot.error ? slot.error + ' | ' : '') + `process exited code=${code}`
    for (const p of rpc.pending.values()) p.reject(new Error('mcp server exited'))
    rpc.pending.clear()
  })
  proc.on('error', (e) => {
    slot.status = 'failed'
    slot.error = e.message
  })

  return slot
}

function rpcCall(slot, method, params, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = slot.rpc.nextId++
    const req = { jsonrpc: '2.0', id, method, params: params || {} }
    const timer = setTimeout(() => {
      slot.rpc.pending.delete(id)
      reject(new Error(`mcp ${slot.name} timeout on ${method}`))
    }, timeoutMs)
    slot.rpc.pending.set(id, { resolve, reject, timer })
    try {
      if (slot.transport === 'stdio') {
        slot.proc.stdin.write(JSON.stringify(req) + '\n')
      } else if (slot.transport === 'sse') {
        // POST to the server's /messages endpoint
        fetch(`${slot.cfg.url.replace(/\/sse$/, '')}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        }).catch((e) => {
          clearTimeout(timer)
          slot.rpc.pending.delete(id)
          reject(e)
        })
      }
    } catch (e) {
      clearTimeout(timer)
      slot.rpc.pending.delete(id)
      reject(e)
    }
  })
}

function rpcNotify(slot, method, params) {
  const req = { jsonrpc: '2.0', method, params: params || {} }
  try {
    if (slot.transport === 'stdio') slot.proc.stdin.write(JSON.stringify(req) + '\n')
    else if (slot.transport === 'sse') {
      fetch(`${slot.cfg.url.replace(/\/sse$/, '')}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      }).catch(() => { /* ignore */ })
    }
  } catch { /* ignore */ }
}

function handleRpcMessage(slot, msg) {
  if (msg.id != null && slot.rpc.pending.has(msg.id)) {
    const { resolve, reject, timer } = slot.rpc.pending.get(msg.id)
    clearTimeout(timer)
    slot.rpc.pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  // server-to-client notifications (e.g. tools/list_changed) — ignored for now
}

// ── SSE transport (minimal) ─────────────────────────────────────────────────
async function startSseServer(name, cfg) {
  const rpc = makeRpcState()
  const slot = { name, transport: 'sse', proc: null, rpc, status: 'starting', tools: [], capabilities: {}, error: null, cfg }
  servers.set(name, slot)
  try {
    const res = await fetch(cfg.url, { headers: { accept: 'text/event-stream' } })
    if (!res.ok || !res.body) throw new Error(`SSE connect failed ${res.status}`)
    ;(async () => {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() || ''
        for (const ev of events) {
          const dataLine = ev.split('\n').find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          try {
            handleRpcMessage(slot, JSON.parse(dataLine.slice(5).trim()))
          } catch { /* non-JSON keep-alive */ }
        }
      }
      slot.status = 'exited'
    })().catch((e) => { slot.status = 'failed'; slot.error = e.message })
    return slot
  } catch (e) {
    slot.status = 'failed'
    slot.error = e.message
    return slot
  }
}

// ── MCP handshake ───────────────────────────────────────────────────────────
async function handshake(slot) {
  try {
    const init = await rpcCall(slot, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: 'browserai', version: '1.0' },
    }, { timeoutMs: 15_000 })
    slot.capabilities = init?.capabilities || {}
    rpcNotify(slot, 'notifications/initialized', {})
    // Some servers need a moment between initialized and tools/list.
    await delay(50)
    const list = await rpcCall(slot, 'tools/list', {}, { timeoutMs: 10_000 })
    slot.tools = Array.isArray(list?.tools) ? list.tools : []
    slot.status = 'ready'
    slot.error = null
    return true
  } catch (e) {
    slot.status = 'failed'
    slot.error = e.message
    return false
  }
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function startMcpHub() {
  const cfg = await loadConfig()
  const entries = Object.entries(cfg).filter(([, c]) => c.enabled !== false)
  if (!entries.length) {
    console.log('[mcp] no servers enabled in', CONFIG_PATH)
    return
  }
  console.log(`[mcp] starting ${entries.length} server(s)…`)
  for (const [name, c] of entries) {
    try {
      let slot
      if (c.transport === 'sse' || c.url) slot = await startSseServer(name, c)
      else                                  slot = startStdioServer(name, c)
      // Give stdio a tick to come up before handshake.
      await delay(c.transport === 'sse' ? 200 : 300)
      const ok = await handshake(slot)
      if (ok) console.log(`[mcp] ${name}: ready (${slot.tools.length} tools)`)
      else    console.warn(`[mcp] ${name}: failed — ${slot.error}`)
    } catch (e) {
      console.warn(`[mcp] ${name}: spawn failed — ${e.message}`)
    }
  }
}

export function stopMcpHub() {
  for (const slot of servers.values()) {
    try { slot.proc?.kill?.('SIGTERM') } catch { /* ignore */ }
  }
  servers.clear()
}

/**
 * @returns {Record<string, {description, params, _mcp: {server, name}}>}
 *   tool descriptors compatible with our agentTools.TOOLS shape
 */
export function listMcpTools() {
  const out = {}
  for (const slot of servers.values()) {
    if (slot.status !== 'ready') continue
    for (const t of slot.tools) {
      const fullName = `mcp__${slot.name}__${t.name}`
      const properties = (t.inputSchema && t.inputSchema.properties) || {}
      const required = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [])
      const params = {}
      for (const [pn, ps] of Object.entries(properties)) {
        params[pn] = {
          type: ps.type || 'string',
          description: ps.description || '',
          required: required.has(pn) || undefined,
        }
      }
      out[fullName] = {
        description: `[MCP ${slot.name}] ${t.description || t.name}`,
        params,
        _mcp: { server: slot.name, name: t.name },
      }
    }
  }
  return out
}

export async function invokeMcpTool(fullName, args = {}) {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(fullName)
  if (!m) throw new Error(`not an mcp tool: ${fullName}`)
  const [, serverName, toolName] = m
  const slot = servers.get(serverName)
  if (!slot) throw new Error(`mcp server not loaded: ${serverName}`)
  if (slot.status !== 'ready') throw new Error(`mcp server not ready: ${serverName} (${slot.error || slot.status})`)
  const result = await rpcCall(slot, 'tools/call', { name: toolName, arguments: args }, { timeoutMs: 60_000 })
  // Flatten the MCP content block into a simple string for the LLM.
  if (Array.isArray(result?.content)) {
    return result.content.map((c) => {
      if (c.type === 'text') return c.text
      if (c.type === 'image') return `[image ${c.mimeType || 'png'}]`
      if (c.type === 'resource') return `[resource ${c.resource?.uri || ''}]`
      return JSON.stringify(c)
    }).join('\n')
  }
  return result
}

export function getMcpServerStatus() {
  const out = []
  for (const slot of servers.values()) {
    out.push({
      name: slot.name,
      transport: slot.transport,
      status: slot.status,
      toolCount: slot.tools.length,
      tools: slot.tools.map((t) => t.name),
      error: slot.error || null,
    })
  }
  return out
}

// ── Config management (used by /api/mcp/* endpoints) ────────────────────────
export async function getMcpConfig() {
  return await loadConfig()
}
export async function setMcpServer(name, cfg) {
  const all = await loadConfig()
  all[name] = cfg
  await saveConfig(all)
  return all
}
export async function deleteMcpServer(name) {
  const all = await loadConfig()
  delete all[name]
  await saveConfig(all)
  return all
}

export default { startMcpHub, stopMcpHub, listMcpTools, invokeMcpTool, getMcpServerStatus, getMcpConfig, setMcpServer, deleteMcpServer }
