import fs from 'node:fs/promises'
import path from 'node:path'
import { safePath } from './workspace.js'

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.history', '.snapshots'])
const SENSITIVE_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa|id_ed25519|\.netrc|credentials|secrets?\.(json|ya?ml|env))$/i
const PATTERNS = [
  { type: 'github_token', re: /gh[pousr]_[A-Za-z0-9_]{20,}/g, severity: 'high' },
  { type: 'github_pat', re: /github_pat_[A-Za-z0-9_]+/g, severity: 'high' },
  { type: 'openai_key', re: /sk-[A-Za-z0-9_-]{20,}/g, severity: 'high' },
  { type: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, severity: 'high' },
  { type: 'google_key', re: /AIza[0-9A-Za-z_-]{20,}/g, severity: 'high' },
  { type: 'telegram_bot', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, severity: 'high' },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, severity: 'medium' },
  { type: 'secret_assignment', re: /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s'"`]{8,})/gi, severity: 'medium' },
]

function mask(value = '') {
  const s = String(value)
  if (s.length <= 10) return '<redacted>'
  return `${s.slice(0, 3)}…${s.slice(-3)}`
}

async function walk(abs, rel, out, { maxFiles, maxBytes }) {
  if (out.scannedFiles >= maxFiles) return
  let st
  try { st = await fs.stat(abs) } catch { return }
  if (st.isDirectory()) {
    if (EXCLUDED_DIRS.has(path.basename(abs))) return
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const e of entries) await walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, out, { maxFiles, maxBytes })
    return
  }
  if (!st.isFile()) return
  out.scannedFiles += 1
  if (SENSITIVE_FILE_RE.test(rel)) out.findings.push({ path: rel, type: 'sensitive_filename', severity: 'high', match: path.basename(rel) })
  if (st.size > maxBytes) return
  let text
  try { text = await fs.readFile(abs, 'utf8') } catch { return }
  for (const p of PATTERNS) {
    let m
    p.re.lastIndex = 0
    while ((m = p.re.exec(text)) != null) {
      out.findings.push({ path: rel, type: p.type, severity: p.severity, match: mask(m[0]), index: m.index })
      if (out.findings.length >= 200) return
    }
  }
}

export async function scanSecrets({ root = '', maxFiles = 5000, maxBytes = 512 * 1024 } = {}) {
  const out = { schema: 'browserai.secret_scan.v1', root: root || '.', scannedFiles: 0, findings: [] }
  await walk(safePath(root || ''), root || '', out, { maxFiles, maxBytes })
  out.high = out.findings.filter((f) => f.severity === 'high').length
  out.medium = out.findings.filter((f) => f.severity === 'medium').length
  out.ok = out.high === 0
  return out
}

export default { scanSecrets }
