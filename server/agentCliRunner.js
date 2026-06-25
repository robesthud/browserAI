import { EventEmitter } from 'node:events'
import { runAgent } from './agentLoop.js'

function parseArgs(argv = []) {
  const opts = { jsonl: false, chatId: '', workspace: '', model: '', baseUrl: '', apiKey: '', apiKeyEnv: '', temperature: 0.3, maxSteps: 0, extraSystem: '', help: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--jsonl') opts.jsonl = true
    else if (a === '--chat') opts.chatId = argv[++i] || ''
    else if (a === '--workspace') opts.workspace = argv[++i] || ''
    else if (a === '--model') opts.model = argv[++i] || ''
    else if (a === '--base-url') opts.baseUrl = argv[++i] || ''
    else if (a === '--api-key') opts.apiKey = argv[++i] || ''
    else if (a === '--api-key-env') opts.apiKeyEnv = argv[++i] || ''
    else if (a === '--temperature') opts.temperature = Number(argv[++i] || 0.3)
    else if (a === '--max-steps') opts.maxSteps = Number(argv[++i] || 0)
    else if (a === '--system') opts.extraSystem = argv[++i] || ''
    else if (a === '--continue') opts.continueRunId = argv[++i] || ''
    else rest.push(a)
  }
  opts.prompt = rest.join(' ').trim()
  return opts
}

function helpText() {
  return `BrowserAI Agent CLI\n\nUsage:\n  browserai agent [options] "task"\n  browserai-agent [options] "task"\n\nOptions:\n  --jsonl                 Emit machine-readable JSONL events\n  --chat <id>             Workspace/chat id (default: cli-<timestamp>)\n  --workspace <id>        Alias for --chat\n  --base-url <url>        Provider base URL\n  --model <name>          Provider model\n  --api-key <key>         Provider API key (prefer --api-key-env)\n  --api-key-env <name>    Read API key from env var\n  --temperature <n>       Model temperature (default: 0.3)\n  --max-steps <n>         Agent max steps\n  --system <text>         Extra system instruction\n  -h, --help              Show help\n\nEnvironment defaults:\n  BROWSERAI_BASE_URL, BROWSERAI_MODEL, BROWSERAI_API_KEY\n  OPENAI_API_KEY + optional OPENAI_MODEL\n  ANTHROPIC_API_KEY + optional ANTHROPIC_MODEL\n  GEMINI_API_KEY + optional GEMINI_MODEL\n`
}

function providerFromOptions(opts = {}, env = process.env) {
  const apiKey = opts.apiKey || (opts.apiKeyEnv ? env[opts.apiKeyEnv] : '') || env.BROWSERAI_API_KEY || ''
  let baseUrl = opts.baseUrl || env.BROWSERAI_BASE_URL || ''
  let model = opts.model || env.BROWSERAI_MODEL || ''

  if (!baseUrl && !apiKey && env.OPENAI_API_KEY) {
    baseUrl = 'https://api.openai.com/v1'
    model = env.OPENAI_MODEL || 'gpt-4o-mini'
    return { baseUrl, apiKey: env.OPENAI_API_KEY, model, authType: 'bearer', temperature: opts.temperature }
  }
  if (!baseUrl && !apiKey && env.ANTHROPIC_API_KEY) {
    baseUrl = 'https://api.anthropic.com/v1'
    model = env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest'
    return { baseUrl, apiKey: env.ANTHROPIC_API_KEY, model, authType: 'bearer', temperature: opts.temperature }
  }
  if (!baseUrl && !apiKey && env.GEMINI_API_KEY) {
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
    model = env.GEMINI_MODEL || 'gemini-2.5-flash'
    return { baseUrl, apiKey: env.GEMINI_API_KEY, model, authType: 'bearer', temperature: opts.temperature }
  }

  return { baseUrl, apiKey, model, authType: 'bearer', temperature: opts.temperature }
}

function unwrapSsePayload(parsed) {
  if (parsed && typeof parsed === 'object' && parsed.payload && parsed.event) return parsed.payload
  return parsed
}

class CliSseResponse extends EventEmitter {
  constructor({ jsonl = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    super()
    this.jsonl = jsonl
    this.stdout = stdout
    this.stderr = stderr
    this.headersSent = false
    this.buffer = ''
    this.done = false
  }
  setHeader() {}
  flushHeaders() { this.headersSent = true }
  flush() {}
  status() { return this }
  json(obj) { this._emitCli('error', obj); this.end() }
  write(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
    this.buffer += text
    const blocks = this.buffer.split('\n\n')
    this.buffer = blocks.pop() || ''
    for (const block of blocks) this._consumeBlock(block)
    return true
  }
  end(chunk) {
    if (chunk) this.write(chunk)
    if (this.buffer.trim()) this._consumeBlock(this.buffer)
    this.buffer = ''
    if (!this.done) this._emitCli('done', { reason: 'stream-ended' })
    this.emit('finish')
  }
  _consumeBlock(block) {
    if (!block.trim() || block.trim().startsWith(':')) return
    let event = 'message'
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (!data.length) return
    const raw = data.join('\n')
    let parsed = raw
    try { parsed = JSON.parse(raw) } catch {}
    this._emitCli(event, unwrapSsePayload(parsed))
  }
  _emitCli(event, data = {}) {
    if (event === 'done') this.done = true
    if (this.jsonl) {
      this.stdout.write(JSON.stringify({ event, ...((data && typeof data === 'object') ? data : { data }) }) + '\n')
      return
    }
    this._emitHuman(event, data)
  }
  _emitHuman(event, data = {}) {
    if (event === 'assistant_delta') {
      this.stdout.write(String(data.chunk || ''))
      return
    }
    if (event === 'assistant') {
      const text = String(data.text || '')
      if (text && !this._sawAssistantDelta) this.stdout.write(text + '\n')
      return
    }
    if (event === 'thinking') this.stderr.write(`\nthinking step ${data.step ?? ''}\n`)
    else if (event === 'thought') this.stderr.write(`\n• ${String(data.text || '').trim()}\n`)
    else if (event === 'tool_preview') this.stderr.write(`\n→ ${data.name || 'tool'} ${JSON.stringify(data.args || {})}\n`)
    else if (event === 'tool_start') this.stderr.write(`\n$ ${data.name || 'tool'} ${JSON.stringify(data.args || {})}\n`)
    else if (event === 'tool_progress') this.stderr.write(String(data.chunk || ''))
    else if (event === 'tool_result') this.stderr.write(`\n${data.ok ? '✓' : '✗'} ${data.name || 'tool'}\n`)
    else if (event === 'file_change') this.stderr.write(`\nΔ files ${data.summary?.count || data.events?.length || 0}: ${(data.summary?.paths || []).slice(0, 6).join(', ')}\n`)
    else if (event === 'ask_user' || event === 'tool_approval') this.stderr.write(`\n? ${data.question || data.tool || event}\n`)
    else if (event === 'error') this.stderr.write(`\nERROR: ${data.message || data.error || JSON.stringify(data)}\n`)
    else if (event === 'done') this.stderr.write(`\n\ndone: ${data.reason || 'ok'}\n`)
  }
}

export async function runAgentCli(argv = process.argv.slice(2), io = {}) {
  const opts = parseArgs(argv)
  if (opts.help || !opts.prompt) {
    ;(io.stdout || process.stdout).write(helpText())
    return opts.help ? 0 : 2
  }
  const provider = providerFromOptions(opts)
  if (!provider.baseUrl || !provider.apiKey || !provider.model) {
    ;(io.stderr || process.stderr).write('Provider is not configured. Set BROWSERAI_BASE_URL/BROWSERAI_MODEL/BROWSERAI_API_KEY or OPENAI_API_KEY/ANTHROPIC_API_KEY/GEMINI_API_KEY.\n')
    return 2
  }
  const chatId = opts.chatId || opts.workspace || `cli-${Date.now().toString(36)}`
  const res = new CliSseResponse({ jsonl: opts.jsonl, stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr })
  await runAgent({
    provider,
    history: [{ role: 'user', content: opts.prompt }],
    extraSystem: opts.extraSystem,
    workspaceScope: chatId,
    userId: 'cli',
    maxSteps: opts.maxSteps || undefined,
    res,
  })
  return 0
}

export const __test = { parseArgs, providerFromOptions, CliSseResponse }
