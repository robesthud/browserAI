/**
 * sandboxPolicy.js
 *
 * Shared Workspace/Sandbox policy primitives:
 *   - secret redaction for command/tool output
 *   - public workspace policy metadata
 *   - safe path guard constants
 */

const SECRET_PATTERNS = [
  { name: 'github_pat', re: /github_pat_[A-Za-z0-9_]+/g },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'openai_key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'google_key', re: /AIza[0-9A-Za-z_-]{20,}/g },
  { name: 'telegram_bot', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: 'password_assignment', re: /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s'"`]{8,})/gi },
]

export function redactSecrets(value = '') {
  let text = String(value ?? '')
  for (const { name, re } of SECRET_PATTERNS) {
    text = text.replace(re, (m, key) => {
      if (name === 'password_assignment' && key) return `${key}=<redacted>`
      const s = String(m)
      if (s.length <= 12) return '<redacted>'
      return `${s.slice(0, 4)}…<redacted:${name}>…${s.slice(-4)}`
    })
  }
  return text
}

export const WORKSPACE_EXCLUDED_DIRS = [
  '.history', '.git', 'node_modules', 'dist', 'build', 'coverage', '.cache',
  '.next', '.nuxt', '.output', '.venv', '__pycache__', 'target',
]

export function publicWorkspacePolicy({ root = '/workspace', scoped = true, quotaMb = 500, maxFileMb = 50 } = {}) {
  return {
    schema: 'browserai.workspace_policy.v1',
    root,
    scoped,
    pathPolicy: {
      relativeOnly: true,
      disallowTraversal: true,
      disallowNul: true,
      disallowEncodedTraversal: true,
      maxPathLength: 1024,
    },
    quotas: {
      quotaMb,
      maxFileMb,
    },
    persistence: {
      persistedRoot: root,
      excludedDirs: WORKSPACE_EXCLUDED_DIRS,
      historyEnabled: true,
      maxHistoryRevisions: 30,
    },
    sandbox: {
      shell: 'docker exec agent-sandbox sh -c',
      stdin: 'closed',
      timeoutDefaultSec: 120,
      timeoutMaxSec: 1800,
      outputRedaction: true,
      outputClipping: true,
    },
  }
}
