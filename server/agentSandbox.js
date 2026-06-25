/**
 * agentSandbox.js
 *
 * Runs LLM-supplied shell commands inside an isolated docker container
 * ("agent-sandbox" service in docker-compose.yml). Communication uses
 * `docker exec`, which is the most reliable cross-runtime channel and
 * does not require us to open a network port on the sandbox.
 *
 * Safety properties:
 *   - sandbox image: alpine:3.20 + node + git + curl + grep/find
 *   - read-only root (filesystem of the image is immutable)
 *   - only /workspace is read/write, bind-mounted to the same
 *     directory the main app sees
 *   - commands run as uid 0:0 to match the workspace owner. The workspace
 *     is created by the API container as root, so a uid-1000 exec could
 *     READ but never WRITE it (npm install / build / git clone / file
 *     generation all failed with EACCES). The sandbox is still isolated:
 *     separate container, read-only image root, CPU/RAM/pids caps, and no
 *     route to internal infrastructure.
 *   - no network restrictions are applied here yet (curl works) —
 *     the perimeter relies on Timeweb's firewall + the absence of
 *     credentials on the container
 *   - per-command CPU/RAM caps come from docker-compose deploy.resources
 *
 * Output is streamed back; large outputs are capped at 8 KB stdout +
 * 4 KB stderr to keep the LLM context manageable.
 */
import { spawn } from 'node:child_process'
import { redactSecrets } from './sandboxPolicy.js'

let resolvedSandboxContainer = null
let sandboxContainerResolvedAt = 0
const SANDBOX_CONTAINER_TTL_MS = 5 * 60 * 1000 // 5 мин — re-resolve если контейнер перезапустился
const MAX_STDOUT = 16 * 1024
const MAX_STDERR = 4 * 1024

export async function getSandboxContainer() {
  // TTL: если кеш устарел — re-resolve (sandbox мог перезапуститься)
  if (resolvedSandboxContainer && Date.now() - sandboxContainerResolvedAt < SANDBOX_CONTAINER_TTL_MS) {
    return resolvedSandboxContainer
  }
  return new Promise((resolve) => {
    const defaultName = process.env.AGENT_SANDBOX_CONTAINER || 'agent-sandbox'
    const proc = spawn('docker', ['ps', '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.on('close', () => {
      const names = stdout.split('\n').map(n => n.trim()).filter(Boolean)
      const found = names.find(n => n.endsWith('agent-sandbox') || n === 'agent-sandbox')
      resolvedSandboxContainer = found || defaultName
      sandboxContainerResolvedAt = Date.now()
      resolve(resolvedSandboxContainer)
    })
    proc.on('error', () => {
      resolvedSandboxContainer = defaultName
      sandboxContainerResolvedAt = Date.now()
      resolve(resolvedSandboxContainer)
    })
  })
}

export function getSandboxEnv() {
  // Явный whitelist только нужных переменных — не используем /URL/i, /TOKEN/i, /SECRET/i
  // которые раскрывают внутренние URLs и секреты в sandbox где выполняется LLM-код.
  const EXPLICIT_KEYS = new Set([
    'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'LUMA_API_KEY', 'ELEVENLABS_API_KEY',
    'GITHUB_TOKEN', 'GITHUB_REPO',
    'NODE_ENV', 'WORKSPACE_ROOT',
    'CF_PROXY_URL',       // без CF_PROXY_SECRET
    'BROWSERAI_MAX_OUTPUT_TOKENS',
  ])
  const PREFIX_PATTERNS = [/^CUSTOM_TOOL_/, /^AGENT_ENV_/]
  const env = {}
  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue
    if (EXPLICIT_KEYS.has(key) || PREFIX_PATTERNS.some(p => p.test(key))) {
      // Санируем значения — убираем переносы строк
      env[key] = String(val).replace(/[\r\n]/g, ' ')
    }
  }
  return env
}

function clip(buf, max) {
  if (buf.length <= max) return { text: redactSecrets(buf.toString('utf8')), truncated: false }
  return {
    text: redactSecrets(buf.subarray(0, max).toString('utf8')) + `\n... [truncated, ${buf.length - max} more bytes]`,
    truncated: true,
  }
}

/**
 * Run a shell command inside the agent-sandbox container.
 *
 * @param {object} opts
 * @param {string} opts.command            shell command (passed to sh -c)
 * @param {number} [opts.timeoutMs=30000]  hard kill timer
 * @param {string} [opts.cwd='/workspace'] working directory inside container
 * @returns {Promise<{stdout, stderr, exitCode, truncated}>}
 */
export async function runSandboxCommand({ command, timeoutMs = 120_000, cwd = '/workspace', signal, onStdout, onStderr } = {}) {
  if (!command || typeof command !== 'string') {
    throw new Error('command must be a non-empty string')
  }
  const sandboxContainer = await getSandboxContainer()
  return new Promise((resolve, reject) => {
    // Все async операции завершены до Promise — executor синхронный
    const envs = getSandboxEnv()
    const args = [
      'exec',
      '--user', process.env.AGENT_SANDBOX_USER || '1000:1000',
    ]
    for (const [k, v] of Object.entries(envs)) {
      args.push('-e', `${k}=${String(v).replace(/[\r\n]/g, ' ')}`)
    }
    args.push(
      '-w', cwd,
      sandboxContainer,
      'sh', '-c', command,
    )

    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let killed = false
    let cancelled = false

    const timer = setTimeout(() => {
      killed = true
      try { proc.kill('SIGKILL') } catch { /* already exited */ }
    }, timeoutMs)

    // External cancellation: user clicked Stop → kill the child immediately.
    let onAbort = null
    if (signal) {
      onAbort = () => {
        cancelled = true
        try { proc.kill('SIGKILL') } catch { /* already exited */ }
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    proc.stdout.on('data', (c) => {
      outBytes += c.length
      if (outBytes <= MAX_STDOUT * 2) outChunks.push(c)
      try { onStdout?.(redactSecrets(c.toString('utf-8'))) } catch { /* listener errors ignored */ }
    })
    proc.stderr.on('data', (c) => {
      errBytes += c.length
      if (errBytes <= MAX_STDERR * 2) errChunks.push(c)
      try { onStderr?.(redactSecrets(c.toString('utf-8'))) } catch { /* listener errors ignored */ }
    })

    proc.on('error', (e) => {
      clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      // Likely: docker binary missing, or sandbox container not running.
      reject(new Error(`sandbox exec failed: ${e.message}. Is the agent-sandbox container running?`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      const stdout = clip(Buffer.concat(outChunks), MAX_STDOUT)
      const stderr = clip(Buffer.concat(errChunks), MAX_STDERR)
      const exitCode = killed || cancelled ? -1 : (code == null ? -1 : code)
      const truncated = stdout.truncated || stderr.truncated || killed
      const reason = cancelled ? `\n[sandbox] cancelled by user` : (killed ? `\n[sandbox] killed after ${timeoutMs}ms timeout` : '')
      resolve({
        stdout: stdout.text,
        stderr: stderr.text + reason,
        exitCode,
        truncated,
        cancelled,
      })
    })
  })
}

/**
 * Quick health check used at server boot to log whether the sandbox is
 * reachable. Does not throw — returns a status string instead.
 */
export async function sandboxHealth() {
  try {
    const r = await runSandboxCommand({ command: 'echo ok', timeoutMs: 5_000 })
    if (r.exitCode === 0 && r.stdout.trim() === 'ok') return 'ok'
    return `unexpected response: stdout=${JSON.stringify(r.stdout)} exit=${r.exitCode}`
  } catch (e) {
    return `unreachable: ${e.message}`
  }
}
