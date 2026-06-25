import { redactSecrets } from './sandboxPolicy.js'

export function safeErrorMessage(error, fallback = 'Internal error') {
  const raw = String(error?.message || error || fallback)
  return redactSecrets(raw).slice(0, 2000)
}

export function safeProviderError(providerError = null) {
  if (!providerError || typeof providerError !== 'object') return null
  return {
    message: safeErrorMessage(providerError.message || ''),
    hint: providerError.hint ? safeErrorMessage(providerError.hint) : '',
    status: Number(providerError.status || 0) || undefined,
    transient: Boolean(providerError.transient),
    phase: providerError.phase ? String(providerError.phase) : '',
    model: providerError.model ? String(providerError.model) : '',
    baseUrl: providerError.baseUrl ? String(providerError.baseUrl) : '',
    providerKind: providerError.providerKind ? String(providerError.providerKind) : '',
    code: providerError.code ? String(providerError.code) : '',
  }
}

export function safeLogMeta(meta = {}) {
  const seen = new WeakSet()
  function walk(value, depth = 0) {
    if (depth > 4) return '[truncated]'
    if (typeof value === 'string') return redactSecrets(value)
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => walk(v, depth + 1))
    if (typeof value === 'object') {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (k === 'stack') continue
        if (/password|passwd|token|secret|api[_-]?key/i.test(k)) {
          out[k] = '<redacted>'
          continue
        }
        out[k] = walk(v, depth + 1)
      }
      return out
    }
    return redactSecrets(String(value))
  }
  return walk(meta)
}

export default safeErrorMessage
