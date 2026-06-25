import crypto from 'node:crypto'
import { safeErrorMessage, safeProviderError } from './errorSanitizer.js'

/**
 * errorTaxonomy.js
 *
 * Approach 6 — Observability. One canonical classification for every error
 * the agent runtime can produce, plus a stable fingerprint for grouping.
 *
 * Categories (taxonomy):
 *   auth              — auth/credentials, key invalid, token expired
 *   provider          — LLM provider failures (network, 5xx, rate limit)
 *   route             — HTTP route failures (404, 405, bad request shape)
 *   workspace_scope   — workspace scope problems (missing scope, cross-scope leak)
 *   tool_schema       — tool args schema invalid, action unknown
 *   tool_execution    — tool handler threw / returned failure
 *   loop_stuck        — max-steps, repeated same tool, oscillation
 *   llm_runtime       — LLM call crashed (parse error, no tool calls, etc.)
 *   verification_missing — post-edit verification not done
 *   false_finalization   — task completed but evidence missing
 *   deploy_runtime    — deploy/restart/health-check failures
 *   unknown           — everything else
 *
 * Severity:
 *   info | warn | error | critical
 *
 * Fingerprint:
 *   sha256(category | normalized-reason | tool-or-empty) truncated to 16 chars.
 *   Stable across calls so identical errors collapse in incident dashboards.
 */

export const ERROR_CATEGORIES = [
  'auth',
  'provider',
  'route',
  'workspace_scope',
  'tool_schema',
  'tool_execution',
  'loop_stuck',
  'llm_runtime',
  'verification_missing',
  'false_finalization',
  'deploy_runtime',
  'aborted',   // ET-1: cap-reached exits classify as this; must be in whitelist
  'unknown',
]

export const SEVERITIES = ['info', 'warn', 'error', 'critical']

const AUTH_PATTERNS = [/401|403|unauthorized|forbidden|invalid[_ ]?token|api[_ ]?key|expired[_ ]?credential|permission[_ ]?denied/i]
const PROVIDER_PATTERNS = [/5\d\d|provider[_ ]?error|rate[_ ]?limit|429|timeout|connect[_ ]?econnrefused|eai_again|fetch[_ ]?failed|open[_ ]?ai|anthropic|gemini|deepseek|openrouter/i]
const ROUTE_PATTERNS = [/\b404\b|\b405\b|\b400\b|invalid[_ ]?request[_ ]?body|missing[_ ]?field|malformed/i]
const WORKSPACE_SCOPE_PATTERNS = [/workspace[_ ]?scope|chats?[_ ]?dir|cross[_ ]?scope|out[_ ]?of[_ ]?scope|invalid[_ ]?scope/i]
const TOOL_SCHEMA_PATTERNS = [/unknown[_ ]?action|invalid[_ ]?args?|missing[_ ]?required|tool[_ ]?requires|unknown[_ ]?tool/i]
const LOOP_STUCK_PATTERNS = [/max[_ ]?steps|step[_ ]?limit|stuck|oscillat|repeated[_ ]?same[_ ]?tool|too[_ ]?many[_ ]?retries/i]
const LLM_RUNTIME_PATTERNS = [/json[_ ]?parse|tool[_ ]?call[_ ]?parse|no[_ ]?tool[_ ]?call|empty[_ ]?reply|blank[_ ]?reply|llm[_ ]?error/i]
const VERIFICATION_MISSING_PATTERNS = [/missing[_ ]?verif|no[_ ]?verif[_ ]?after[_ ]?edit|verify[_ ]?missing/i]
const FALSE_FINAL_PATTERNS = [/fabrication|fabricat|false[_ ]?final|ungrounded[_ ]?claim/i]
const DEPLOY_PATTERNS = [/deploy[_ ]?sh|docker[_ ]?compose[_ ]?up|systemctl|restart[_ ]?failed|health[_ ]?check[_ ]?fail|deploy[_ ]?error/i]

// Approach 6 — strict sanitization for the safeReason field.
// We additionally scrub common URL-embedded secrets (`?key=...&token=...`)
// that safeErrorMessage() does not handle.
function scrubUrlSecrets(text = '') {
  return String(text || '')
    .replace(/\?[^\s]*?(key|token|apikey|api_key|access_token|sid|signature)=[^&\s"']*/gi, '?<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer <redacted>')
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-<redacted>')
    .replace(/ghp_[A-Za-z0-9]{8,}/g, 'ghp_<redacted>')
}

function matchAny(patterns, text) {
  return patterns.some((re) => re.test(text))
}

export function classifyError(input = {}) {
  const err = input?.err || input?.error
  const reason = String(input?.reason || err?.message || err || '').slice(0, 800)
  const tool = String(input?.tool || input?.context?.tool || '')
  const exitReason = String(input?.exitReason || input?.context?.reason || '')
  const route = String(input?.route || input?.context?.route || '')

  const text = `${reason} ${tool} ${exitReason} ${route}`.toLowerCase()

  let category = 'unknown'
  let severity = 'warn'
  const matched = []

  if (matchAny(AUTH_PATTERNS, text)) { category = 'auth'; matched.push('auth'); severity = 'error' }
  if (matchAny(PROVIDER_PATTERNS, text)) { category = 'provider'; matched.push('provider'); severity = 'error' }
  if (matchAny(ROUTE_PATTERNS, text)) { category = 'route'; matched.push('route'); severity = 'warn' }
  if (matchAny(WORKSPACE_SCOPE_PATTERNS, text)) { category = 'workspace_scope'; matched.push('workspace_scope'); severity = 'error' }
  if (matchAny(TOOL_SCHEMA_PATTERNS, text)) { category = 'tool_schema'; matched.push('tool_schema'); severity = 'warn' }
  if (matchAny(LOOP_STUCK_PATTERNS, text)) { category = 'loop_stuck'; matched.push('loop_stuck'); severity = 'warn' }
  if (matchAny(LLM_RUNTIME_PATTERNS, text)) { category = 'llm_runtime'; matched.push('llm_runtime'); severity = 'error' }
  if (matchAny(VERIFICATION_MISSING_PATTERNS, text)) { category = 'verification_missing'; matched.push('verification_missing'); severity = 'warn' }
  if (matchAny(FALSE_FINAL_PATTERNS, text)) { category = 'false_finalization'; matched.push('false_finalization'); severity = 'error' }
  if (matchAny(DEPLOY_PATTERNS, text)) { category = 'deploy_runtime'; matched.push('deploy_runtime'); severity = 'error' }

  // Sanitize and lift severity for blocker-shaped reasons.
  const safeReason = scrubUrlSecrets(safeErrorMessage(err?.message || reason))
  if (exitReason === 'deadline' || exitReason === 'max-steps') { category = 'loop_stuck'; severity = 'warn' }
  if (exitReason === 'llm-error' || exitReason === 'crash') { category = 'llm_runtime'; severity = 'error' }
  if (exitReason === 'cap-reached') { category = 'aborted'; severity = 'info' }
  if (exitReason === 'no-provider') { category = 'provider'; severity = 'error' }

  const fingerprint = crypto
    .createHash('sha256')
    .update(`${category}|${safeReason.toLowerCase().replace(/\s+/g, ' ').trim()}|${tool}`)
    .digest('hex')
    .slice(0, 16)

  return {
    category,
    severity,
    fingerprint,
    reason: safeReason.slice(0, 240),
    tool: tool || null,
    exitReason: exitReason || null,
    route: route || null,
    safeProviderError: err?.response ? safeProviderError(err.response) : null,
  }
}

export function groupByFingerprint(errors = []) {
  const groups = new Map()
  for (const e of errors) {
    const f = e?.fingerprint || 'unknown'
    if (!groups.has(f)) groups.set(f, { fingerprint: f, category: e.category, count: 0, samples: [] })
    const g = groups.get(f)
    g.count += 1
    if (g.samples.length < 3) g.samples.push({ reason: e.reason, ts: e.ts || null, tool: e.tool })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

export function isCritical(category = '', severity = '') {
  return severity === 'critical' || ['false_finalization', 'deploy_runtime'].includes(category)
}

export default classifyError
