import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 180_000
const SSH_HOST = process.env.OPS_SSH_HOST || '72.56.116.15'
const SSH_USER = process.env.OPS_SSH_USER || 'root'
const SSH_KEY = process.env.OPS_SSH_KEY || '/data/ops/timeweb_ed25519'
const APP_DIR = process.env.OPS_APP_DIR || '/opt/browserai'
const TG_TOKEN = process.env.TG_USER_BOT_TOKEN || process.env.TG_BOT_TOKEN || ''
const TG_ADMIN_CHAT_ID = process.env.TG_ADMIN_CHAT_ID || process.env.TG_CHAT_ID || ''

function clip(s = '', max = 12000) {
  const str = String(s || '')
  return str.length > max ? str.slice(0, max) + `\n... [truncated ${str.length - max} chars]` : str
}

function shQuote(value = '') {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function runLocal(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let killed = false
    const timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL') } catch { /* already exited */ } }, timeoutMs)
    proc.stdout.on('data', (c) => out.push(c))
    proc.stderr.on('data', (c) => err.push(c))
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: clip(Buffer.concat(out).toString('utf8')),
        stderr: clip(Buffer.concat(err).toString('utf8') + (killed ? `\n[killed after ${timeoutMs}ms]` : '')),
        exitCode: killed ? -1 : (code ?? -1),
      })
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: e.message, exitCode: -1 })
    })
  })
}

function runSsh(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sshCmd = [
    'ssh',
    '-i', shQuote(SSH_KEY),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    `${SSH_USER}@${SSH_HOST}`,
    shQuote(command),
  ].join(' ')
  return runLocal(sshCmd, { timeoutMs })
}

async function telegramNotify({ text = '' } = {}) {
  if (!TG_TOKEN || !TG_ADMIN_CHAT_ID) {
    return { stdout: '', stderr: 'Telegram token/admin chat is not configured', exitCode: 2 }
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_ADMIN_CHAT_ID, text: String(text || '').slice(0, 3900) }),
    signal: AbortSignal.timeout(15_000),
  })
  const raw = await r.text()
  return { stdout: raw, stderr: r.ok ? '' : raw, exitCode: r.ok ? 0 : r.status }
}

export const OPS_SERVICES = {
  browserai: {
    label: 'BrowserAI VPS / Docker',
    actions: {
      health: { safe: true, description: 'Check BrowserAI and Gemini health' },
      docker_ps: { safe: true, description: 'Show docker compose ps' },
      docker_logs: { safe: true, description: 'Show container logs. params: service, tail' },
      git_status: { safe: true, description: 'Show git status in app dir' },
      deploy: { safe: false, description: 'git reset to origin/main, rebuild and restart BrowserAI' },
      restart: { safe: false, description: 'Restart browserai container' },
      gemini_restart: { safe: false, description: 'Restart gemini-web-proxy.service' },
    },
  },
  telegram: {
    label: 'Telegram admin notifications',
    actions: {
      notify_admin: { safe: true, description: 'Send message to TG_ADMIN_CHAT_ID. params: text' },
    },
  },
}

export function listOpsServices() {
  return Object.entries(OPS_SERVICES).map(([id, svc]) => ({
    id,
    label: svc.label,
    actions: Object.entries(svc.actions).map(([action, meta]) => ({ action, ...meta })),
  }))
}

export async function runOpsAction({ service, action, params = {}, confirm = false } = {}) {
  const svc = OPS_SERVICES[service]
  if (!svc) throw new Error(`Unknown ops service: ${service}`)
  const meta = svc.actions[action]
  if (!meta) throw new Error(`Unknown action ${action} for service ${service}`)
  if (!meta.safe && confirm !== true) {
    return {
      requiresConfirmation: true,
      message: `Action ${service}.${action} is potentially dangerous. Re-run with confirm:true after user confirmation.`,
    }
  }

  if (service === 'telegram' && action === 'notify_admin') {
    return telegramNotify({ text: params.text || params.message || '' })
  }

  if (service !== 'browserai') throw new Error(`Unsupported service: ${service}`)
  const tail = Math.min(500, Math.max(20, Number(params.tail) || 120))
  const serviceName = String(params.service || 'browserai').replace(/[^a-zA-Z0-9_-]/g, '') || 'browserai'

  const commands = {
    health: `set -e; echo 'BrowserAI:'; curl -fsS http://localhost/api/health; echo; echo 'Gemini:'; curl -fsS http://172.17.0.1:8080/health || true; echo`,
    docker_ps: `cd ${shQuote(APP_DIR)} && docker compose ps`,
    docker_logs: `cd ${shQuote(APP_DIR)} && docker compose logs --tail=${tail} ${shQuote(serviceName)}`,
    git_status: `cd ${shQuote(APP_DIR)} && git log -1 --oneline && git status --short`,
    deploy: `set -e; cd ${shQuote(APP_DIR)}; git fetch --quiet origin main; git reset --hard origin/main; git log -1 --oneline; scripts/apply-gemini-web-proxy-patch.sh /opt/gemini-web-proxy || true; systemctl restart gemini-web-proxy.service; docker compose build; docker compose up -d; sleep 8; curl -fsS http://localhost/api/health; echo; curl -fsS http://172.17.0.1:8080/health; echo`,
    restart: `cd ${shQuote(APP_DIR)} && docker compose restart browserai && sleep 5 && curl -fsS http://localhost/api/health`,
    gemini_restart: `systemctl restart gemini-web-proxy.service && sleep 10 && curl -fsS http://172.17.0.1:8080/health`,
  }
  const command = commands[action]
  if (!command) throw new Error(`Action not implemented: ${service}.${action}`)
  return runSsh(command, { timeoutMs: action === 'deploy' ? 20 * 60_000 : DEFAULT_TIMEOUT_MS })
}
