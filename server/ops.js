import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import AdmZip from 'adm-zip'

const DEFAULT_TIMEOUT_MS = 180_000
const SSH_HOST = process.env.OPS_SSH_HOST || '72.56.116.15'
const SSH_USER = process.env.OPS_SSH_USER || 'root'
const SSH_KEY = process.env.OPS_SSH_KEY || '/data/ops/timeweb_ed25519'
const APP_DIR = process.env.OPS_APP_DIR || '/opt/browserai'
const TG_TOKEN = process.env.TG_USER_BOT_TOKEN || process.env.TG_BOT_TOKEN || ''
const TG_ADMIN_CHAT_ID = process.env.TG_ADMIN_CHAT_ID || process.env.TG_CHAT_ID || ''
const OPS_SERVICES_FILE = process.env.OPS_SERVICES_FILE || '/data/ops/services.json'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''
const GITHUB_REPO = process.env.GITHUB_REPO || 'robesthud/browserAI'
const OPS_AUDIT_LOG = process.env.OPS_AUDIT_LOG || '/data/ops-audit.log'

// Redact secrets from any text returned to the agent/LLM or written to the
// audit log. The model never needs raw tokens, and ops output (docker logs,
// git diff, GitHub file content, deploy output) can incidentally contain them.
const SECRET_ENV_NAMES = [
  'GITHUB_TOKEN', 'TG_BOT_TOKEN', 'TG_USER_BOT_TOKEN', 'AUTH_SECRET',
  'SESSION_SECRET', 'CF_PROXY_SECRET', 'DEEPSEEK_USER_TOKEN', 'SMTP_PASS',
  'TWILIO_AUTH_TOKEN',
]
function redactSecrets(text = '') {
  let s = String(text || '')
  if (!s) return s
  // 1) Exact known env-var values currently set in the process.
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name]
    if (v && v.length >= 6) s = s.split(v).join('<redacted>')
  }
  // 2) Token-shaped patterns (GitHub PATs, Bearer tokens, JWTs, long cookies).
  s = s
    .replace(/github_pat_[A-Za-z0-9_]+/g, '<redacted-gh-pat>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted-gh-token>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '<redacted-jwt>')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>')
    .replace(/((?:cf_clearance|ds_session_id|smidV2|aws-waf-token)=)[^;\s"']+/gi, '$1<redacted>')
  return s
}

function clip(s = '', max = 12000) {
  const str = redactSecrets(String(s || ''))
  return str.length > max ? str.slice(0, max) + `\n... [truncated ${str.length - max} chars]` : str
}

function auditOps(event = {}) {
  try {
    appendFileSync(OPS_AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
  } catch { /* audit log best effort */ }
}

// Read the most recent audit-log entries (JSON-lines), newest first.
// Best-effort: returns [] if the log doesn't exist yet.
export function readOpsAudit({ limit = 100 } = {}) {
  try {
    if (!existsSync(OPS_AUDIT_LOG)) return []
    const max = Math.min(1000, Math.max(1, Number(limit) || 100))
    const lines = readFileSync(OPS_AUDIT_LOG, 'utf8').split('\n').filter(Boolean)
    const recent = lines.slice(-max).reverse()
    return recent.map((l) => { try { return JSON.parse(l) } catch { return { raw: l.slice(0, 500) } } })
  } catch {
    return []
  }
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



function renderTemplate(str = '', params = {}) {
  return String(str || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => encodeURIComponent(params[key] ?? ''))
}

function loadDynamicServices() {
  if (!existsSync(OPS_SERVICES_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(OPS_SERVICES_FILE, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : (parsed.services || [])
    const out = {}
    for (const svc of list) {
      if (!svc?.id || !svc?.type) continue
      out[svc.id] = svc
    }
    return out
  } catch {
    return {}
  }
}

async function runRestServiceAction(svc, action, params = {}) {
  const def = svc.actions?.[action]
  if (!def) throw new Error(`Unknown REST action: ${svc.id}.${action}`)
  const base = String(svc.baseUrl || '').replace(/\/$/, '')
  const path = renderTemplate(def.path || '/', params)
  const headers = { ...(svc.headers || {}), ...(def.headers || {}) }
  const auth = def.auth || svc.auth || {}
  if (auth.type === 'bearer') {
    const token = process.env[auth.env || ''] || auth.token || ''
    if (!token) throw new Error(`Missing bearer token env: ${auth.env}`)
    headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`
  } else if (auth.type === 'header') {
    const token = process.env[auth.env || ''] || auth.value || ''
    if (!token) throw new Error(`Missing auth header env: ${auth.env}`)
    headers[auth.header || 'Authorization'] = token
  } else if (auth.type === 'basic') {
    const user = process.env[auth.userEnv || ''] || auth.user || ''
    const pass = process.env[auth.passEnv || ''] || auth.pass || ''
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  }
  const method = (def.method || 'GET').toUpperCase()
  const body = def.body ? renderTemplate(JSON.stringify(def.body), params) : (params.body ? JSON.stringify(params.body) : undefined)
  if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const r = await fetch(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(Number(def.timeoutMs) || 60_000) })
  const text = await r.text()
  return { stdout: clip(text, Number(def.maxChars) || 12000), stderr: r.ok ? '' : clip(text, 4000), exitCode: r.ok ? 0 : r.status }
}

async function githubApi(path, { method = 'GET', body = null, accept = 'application/vnd.github+json' } = {}) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured')
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`GitHub ${r.status}: ${text.slice(0, 1000)}`)
  }
  return r
}

function repoPath(params = {}) {
  return String(params.repo || GITHUB_REPO).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
}

async function githubAction(action, params = {}) {
  const repo = repoPath(params)
  if (action === 'repo_status') {
    const j = await (await githubApi(`/repos/${repo}`)).json()
    return { stdout: JSON.stringify({ full_name: j.full_name, private: j.private, default_branch: j.default_branch, pushed_at: j.pushed_at, updated_at: j.updated_at, permissions: j.permissions }, null, 2), stderr: '', exitCode: 0 }
  }
  if (action === 'actions_runs') {
    const workflow = params.workflow ? `&workflow_id=${encodeURIComponent(params.workflow)}` : ''
    const j = await (await githubApi(`/repos/${repo}/actions/runs?per_page=${Number(params.limit) || 10}${workflow}`)).json()
    const runs = (j.workflow_runs || []).map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch, sha: r.head_sha?.slice(0, 7), created_at: r.created_at, url: r.html_url }))
    return { stdout: JSON.stringify(runs, null, 2), stderr: '', exitCode: 0 }
  }
  if (action === 'workflow_logs') {
    const runId = params.run_id || params.runId
    if (!runId) throw new Error('run_id required')
    const r = await githubApi(`/repos/${repo}/actions/runs/${runId}/logs`, { accept: 'application/zip' })
    const buf = Buffer.from(await r.arrayBuffer())
    const zip = new AdmZip(buf)
    const parts = []
    for (const entry of zip.getEntries().slice(0, 30)) {
      if (entry.isDirectory) continue
      const text = entry.getData().toString('utf8')
      parts.push(`===== ${entry.entryName} =====\n${clip(text, Number(params.maxCharsPerFile) || 4000)}`)
    }
    return { stdout: clip(parts.join('\n\n'), 30000), stderr: '', exitCode: 0 }
  }
  if (action === 'get_file') {
    const filePath = params.path
    if (!filePath) throw new Error('path required')
    const ref = params.ref || 'main'
    const j = await (await githubApi(`/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`)).json()
    const content = j.content ? Buffer.from(j.content, 'base64').toString('utf8') : ''
    return { stdout: clip(content, Number(params.maxChars) || 30000), stderr: '', exitCode: 0, sha: j.sha }
  }
  if (action === 'put_file') {
    const filePath = params.path
    const content = params.content
    const message = params.message || `Update ${filePath}`
    const branch = params.branch || 'main'
    if (!filePath || content == null) throw new Error('path and content required')
    let sha
    try {
      const existing = await (await githubApi(`/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`)).json()
      sha = existing.sha
    } catch { /* new file */ }
    const body = { message, content: Buffer.from(String(content), 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) }
    const j = await (await githubApi(`/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`, { method: 'PUT', body })).json()
    return { stdout: JSON.stringify({ commit: j.commit?.sha, path: j.content?.path, html_url: j.content?.html_url }, null, 2), stderr: '', exitCode: 0 }
  }
  if (action === 'rerun_workflow') {
    const runId = params.run_id || params.runId
    if (!runId) throw new Error('run_id required')
    await githubApi(`/repos/${repo}/actions/runs/${runId}/rerun`, { method: 'POST' })
    return { stdout: `Requested rerun for ${runId}`, stderr: '', exitCode: 0 }
  }
  if (action === 'create_pull_request') {
    const head = params.head
    const base = params.base || 'main'
    const title = params.title
    const body  = params.body || ''
    if (!head || !title) throw new Error('head and title required')
    const r = await githubApi(`/repos/${repo}/pulls`, {
      method: 'POST',
      body: { head, base, title, body },
    })
    const j = await r.json()
    return {
      stdout: JSON.stringify({ number: j.number, url: j.html_url, head: j.head?.ref, base: j.base?.ref }, null, 2),
      stderr: '',
      exitCode: 0,
      pull_request: { number: j.number, url: j.html_url, head: j.head?.ref, base: j.base?.ref, state: j.state },
    }
  }
  throw new Error(`GitHub action not implemented: ${action}`)
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
  return { stdout: clip(raw, 4000), stderr: r.ok ? '' : clip(raw, 4000), exitCode: r.ok ? 0 : r.status }
}

export const OPS_SERVICES = {
  github: {
    label: 'GitHub repository / Actions',
    actions: {
      repo_status: { safe: true, description: 'Show repository metadata. params: repo?' },
      actions_runs: { safe: true, description: 'List recent GitHub Actions runs. params: repo?, limit?, workflow?' },
      workflow_logs: { safe: true, description: 'Download and summarize workflow logs. params: run_id, repo?' },
      get_file: { safe: true, description: 'Read a file from GitHub repo. params: path, ref?, repo?' },
      put_file: { safe: false, description: 'Create/update a file in GitHub repo. params: path, content, message?, branch?, repo?' },
      rerun_workflow: { safe: false, description: 'Rerun a GitHub Actions workflow run. params: run_id, repo?' },
      create_pull_request: { safe: false, description: 'Open a pull request. params: head, title, body?, base?, repo?' },
    },
  },
  browserai: {
    label: 'BrowserAI VPS / Docker',
    actions: {
      health: { safe: true, description: 'Check BrowserAI and Gemini health' },
      docker_ps: { safe: true, description: 'Show docker compose ps' },
      docker_logs: { safe: true, description: 'Show container logs. params: service, tail' },
      git_status: { safe: true, description: 'Show git status in app dir' },
      sync_check: { safe: true, description: 'Check that the deployed checkout matches origin/main and the app is healthy. Reports local commit, origin/main commit, in-sync yes/no, dirty files, and /api/health.' },
      deploy: { safe: false, description: 'git reset to origin/main, rebuild and restart BrowserAI' },
      deploy_safe: { safe: false, description: 'Deploy with automatic rollback: record current commit, pull+build+up, health-check; if health fails, reset to the previous commit, rebuild and restart, then re-check. Mirrors a careful deploy-and-revert-on-failure flow.' },
      repair_deploy: { safe: false, description: 'Run a deploy with diagnostics: pre-status, build/up, health checks, and failure logs. Use after confirmation when user asks to deploy/fix deploy.' },
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
  const all = { ...OPS_SERVICES, ...loadDynamicServices() }
  return Object.entries(all).map(([id, svc]) => ({
    id,
    label: svc.label,
    actions: Object.entries(svc.actions || {}).map(([action, meta]) => ({ action, ...meta })),
  }))
}

export async function runOpsAction({ service, action, params = {}, confirm = false } = {}) {
  const dynamicServices = loadDynamicServices()
  const svc = OPS_SERVICES[service] || dynamicServices[service]
  if (!svc) throw new Error(`Unknown ops service: ${service}`)
  const meta = svc.actions[action]
  if (!meta) throw new Error(`Unknown action ${action} for service ${service}`)
  if (!meta.safe && confirm !== true) {
    auditOps({ service, action, status: 'needs_confirmation' })
    return {
      requiresConfirmation: true,
      message: `Action ${service}.${action} is potentially dangerous. Re-run with confirm:true after user confirmation.`,
    }
  }

  const started = Date.now()
  try {
    let result
    if (dynamicServices[service]?.type === 'rest') {
      result = await runRestServiceAction(dynamicServices[service], action, params)
    } else if (service === 'telegram' && action === 'notify_admin') {
      result = await telegramNotify({ text: params.text || params.message || '' })
    } else if (service === 'github') {
      result = await githubAction(action, params)
    } else if (service === 'browserai') {
      result = null
    } else {
      throw new Error(`Unsupported service: ${service}`)
    }
    if (result) {
      auditOps({ service, action, status: result.exitCode === 0 ? 'ok' : 'error', exitCode: result.exitCode, ms: Date.now() - started })
      return result
    }
  } catch (e) {
    auditOps({ service, action, status: 'throw', error: redactSecrets(e.message), ms: Date.now() - started })
    throw e
  }

  const tail = Math.min(500, Math.max(20, Number(params.tail) || 120))
  const serviceName = String(params.service || 'browserai').replace(/[^a-zA-Z0-9_-]/g, '') || 'browserai'

  const commands = {
    health: `set -e; echo 'BrowserAI:'; curl -fsS http://localhost/api/health; echo; echo 'Gemini:'; curl -fsS http://172.17.0.1:8080/health || true; echo`,
    docker_ps: `cd ${shQuote(APP_DIR)} && docker compose ps`,
    docker_logs: `cd ${shQuote(APP_DIR)} && docker compose logs --tail=${tail} ${shQuote(serviceName)}`,
    git_status: `cd ${shQuote(APP_DIR)} && git log -1 --oneline && git status --short`,
    sync_check: `cd ${shQuote(APP_DIR)}
set +e
git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
echo "local:  $LOCAL"
echo "origin: $REMOTE"
if [ "$LOCAL" = "$REMOTE" ]; then echo "in_sync: yes"; else echo "in_sync: NO (deployed checkout differs from origin/main)"; fi
DIRTY=$(git status --short); if [ -n "$DIRTY" ]; then echo "dirty_files:"; echo "$DIRTY"; else echo "dirty_files: none"; fi
echo -n "health: "; curl -fsS http://localhost/api/health && echo || echo "UNHEALTHY"
[ "$LOCAL" = "$REMOTE" ]`,
    deploy: `set -e; cd ${shQuote(APP_DIR)}; git fetch --quiet origin main; git reset --hard origin/main; git log -1 --oneline; scripts/apply-gemini-web-proxy-patch.sh /opt/gemini-web-proxy || true; systemctl restart gemini-web-proxy.service; docker compose build; docker compose up -d; sleep 8; curl -fsS http://localhost/api/health; echo; curl -fsS http://172.17.0.1:8080/health; echo`,
    deploy_safe: `cd ${shQuote(APP_DIR)}
set +e
PREV=$(git rev-parse HEAD); echo "== prev commit == $PREV"
git fetch --quiet origin main; git reset --hard origin/main; NEW=$(git rev-parse HEAD); echo "== new commit == $NEW"; git log -1 --oneline
scripts/apply-gemini-web-proxy-patch.sh /opt/gemini-web-proxy || true
echo "== build =="; docker compose build; BUILD=$?
echo "== up =="; docker compose up -d; UP=$?
sleep 8
echo "== health =="; curl -fsS http://localhost/api/health; H1=$?; echo
if [ $BUILD -eq 0 ] && [ $UP -eq 0 ] && [ $H1 -eq 0 ]; then
  docker image prune -f >/dev/null 2>&1
  echo "== DEPLOY OK == $NEW"
  exit 0
fi
echo "!! DEPLOY FAILED (build:$BUILD up:$UP health:$H1) — ROLLING BACK to $PREV"
git reset --hard "$PREV"; git log -1 --oneline
docker compose build; RB_BUILD=$?
docker compose up -d; RB_UP=$?
sleep 8
curl -fsS http://localhost/api/health; RB_H=$?; echo
if [ $RB_BUILD -eq 0 ] && [ $RB_UP -eq 0 ] && [ $RB_H -eq 0 ]; then
  echo "== ROLLBACK OK == restored $PREV"
else
  echo "!! ROLLBACK ALSO FAILED (build:$RB_BUILD up:$RB_UP health:$RB_H) — manual intervention needed"
fi
exit 1`,
    repair_deploy: `cd ${shQuote(APP_DIR)}
set +e
echo '== pre git =='; git log -1 --oneline; git status --short
echo '== pre containers =='; docker compose ps
echo '== fetch/reset =='; git fetch origin main; FETCH=$?; git reset --hard origin/main; RESET=$?; git log -1 --oneline
echo '== apply gemini patch =='; scripts/apply-gemini-web-proxy-patch.sh /opt/gemini-web-proxy; PATCH=$?; systemctl restart gemini-web-proxy.service; GEMINI_RESTART=$?
echo '== build =='; docker compose build; BUILD=$?
echo '== up =='; docker compose up -d; UP=$?
sleep 8
echo '== health =='; curl -fsS http://localhost/api/health; H1=$?; echo; curl -fsS http://172.17.0.1:8080/health; H2=$?; echo
echo '== containers =='; docker compose ps
echo '== browserai logs =='; docker compose logs --tail=160 browserai
echo '== gemini logs =='; journalctl -u gemini-web-proxy.service -n 120 --no-pager
echo "== summary == fetch:$FETCH reset:$RESET patch:$PATCH gemini_restart:$GEMINI_RESTART build:$BUILD up:$UP health_browserai:$H1 health_gemini:$H2"
if [ $FETCH -ne 0 ] || [ $RESET -ne 0 ] || [ $BUILD -ne 0 ] || [ $UP -ne 0 ] || [ $H1 -ne 0 ] || [ $H2 -ne 0 ]; then exit 1; fi
exit 0`,
    restart: `cd ${shQuote(APP_DIR)} && docker compose restart browserai && sleep 5 && curl -fsS http://localhost/api/health`,
    gemini_restart: `systemctl restart gemini-web-proxy.service && sleep 10 && curl -fsS http://172.17.0.1:8080/health`,
  }
  const command = commands[action]
  if (!command) throw new Error(`Action not implemented: ${service}.${action}`)
  const result = await runSsh(command, { timeoutMs: ['deploy', 'repair_deploy', 'deploy_safe'].includes(action) ? 20 * 60_000 : DEFAULT_TIMEOUT_MS })
  auditOps({ service, action, status: result.exitCode === 0 ? 'ok' : 'error', exitCode: result.exitCode, ms: Date.now() - started })
  return result
}

