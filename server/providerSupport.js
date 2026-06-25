/**
 * providerSupport.js
 *
 * Approach 7 — Trust UX + Prod Readiness. Canonical provider support matrix.
 *
 * Tier semantics:
 *   certified      — verified to work in production, regressions tested
 *   experimental   — works in our smoke suite but may have rough edges
 *   unsupported    — not in our matrix; treat as best-effort
 *   legacy         — historically supported, being phased out
 *
 * The matrix is the source of truth for UI badges and routing decisions.
 * Adding a provider here does NOT auto-certify it — operators must verify
 * before bumping to `certified`.
 *
 * Order matters: more-specific patterns (gemini, anthropic, ollama) come
 * BEFORE the catch-all openai_compat pattern, so the broad `/v1$/` regex
 * does not swallow them.
 */

export const PROVIDER_TIERS = ['certified', 'experimental', 'unsupported', 'legacy']

export const PROVIDER_SUPPORT_MATRIX = [
  {
    id: 'managed_deepseek',
    label: 'DeepSeek managed session',
    tier: 'certified',
    baseUrlPattern: /chat\.deepseek\.com\/api\/v0/,
    testedAt: '2026-06-20',
    notes: 'Primary production provider. Bearer + cookies auto-refreshed by deepseekTokenRefresher.',
    knownLimitations: [
      'No native function-calling — JSON-in-text fallback',
      'Stream chunks arrive with non-standard SSE framing',
    ],
    sampleRunId: null,
  },
  {
    id: 'gemini_official',
    label: 'Google Gemini (AI Studio)',
    tier: 'certified',
    baseUrlPattern: /generativelanguage\.googleapis\.com/,
    testedAt: '2026-06-20',
    notes: 'OpenAI-compatible proxy endpoint. Native tools supported.',
    knownLimitations: [
      'Free tier quota may saturate during parallel runs',
      'No Anthropic-compatible message format — translations may lose subtle formatting',
    ],
    sampleRunId: null,
  },
  {
    id: 'anthropic_official',
    label: 'Anthropic Claude (api.anthropic.com)',
    tier: 'experimental',
    baseUrlPattern: /api\.anthropic\.com/,
    testedAt: '2026-06-20',
    notes: 'Native Anthropic Messages API. Tool use supported.',
    knownLimitations: [
      'Not all Anthropic models support tool use — runtime cap enforced',
      'Different SSE event format; converted at transport boundary',
    ],
    sampleRunId: null,
  },
  {
    id: 'ollama_local',
    label: 'Ollama (local)',
    tier: 'experimental',
    baseUrlPattern: /(localhost|127\.0\.0\.1):11434/,
    testedAt: '2026-06-20',
    notes: 'Local LLM runtime. OpenAI-compatible surface. Capability detection happens at runtime.',
    knownLimitations: [
      'No native tools on older models — JSON-in-text fallback',
      'Quality depends entirely on the local model size and quantization',
    ],
    sampleRunId: null,
  },
  {
    id: 'openai_compat',
    label: 'OpenAI-compatible (OpenRouter / Together / Mistral / Grok / Zhipu)',
    tier: 'experimental',
    baseUrlPattern: /\/(v1|api\/v1)\/?$/,
    testedAt: '2026-06-20',
    notes: 'Catch-all for any OpenAI-compatible provider. Native function-calling supported where the upstream supports tools[] schema. Listed LAST so more specific patterns match first.',
    knownLimitations: [
      'Capabilities differ per upstream — check supportsNativeTools() per call',
      'Rate limits vary; no global circuit breaker',
    ],
    sampleRunId: null,
  },
]

/**
 * Find a matrix entry for a given provider id or baseUrl.
 * Falls back to tier 'unsupported' for unknown providers.
 */
export function lookupProviderSupport(provider = {}) {
  const baseUrl = String(provider?.baseUrl || '')
  const id = String(provider?.id || '')
  if (id) {
    const byId = PROVIDER_SUPPORT_MATRIX.find((m) => m.id === id)
    if (byId) return byId
  }
  for (const entry of PROVIDER_SUPPORT_MATRIX) {
    if (entry.baseUrlPattern && entry.baseUrlPattern.test(baseUrl)) return entry
  }
  return {
    id: id || 'unknown',
    label: baseUrl || 'unknown',
    tier: 'unsupported',
    baseUrlPattern: null,
    testedAt: null,
    notes: 'Not in support matrix — treat as best-effort.',
    knownLimitations: ['No certification testing has been performed.'],
    sampleRunId: null,
  }
}

export function listProviderSupport() {
  return PROVIDER_SUPPORT_MATRIX.slice()
}

export function isCertified(provider = {}) {
  return lookupProviderSupport(provider).tier === 'certified'
}

export function isExperimental(provider = {}) {
  return lookupProviderSupport(provider).tier === 'experimental'
}

export function isUnsupported(provider = {}) {
  return lookupProviderSupport(provider).tier === 'unsupported'
}

/**
 * UI warning text for non-certified tiers.
 * Returns null for certified (no warning needed).
 */
export function providerWarning(provider = {}) {
  const entry = lookupProviderSupport(provider)
  if (entry.tier === 'certified') return null
  if (entry.tier === 'experimental') {
    return {
      severity: 'warn',
      title: 'Experimental provider',
      body: `${entry.label} is in the experimental tier. Smoke-tested but may have rough edges. Known limitations: ${(entry.knownLimitations || []).join(' / ')}`,
    }
  }
  if (entry.tier === 'legacy') {
    return {
      severity: 'warn',
      title: 'Legacy provider',
      body: `${entry.label} is legacy and being phased out. Migrate to a certified or experimental provider.`,
    }
  }
  return {
    severity: 'error',
    title: 'Unsupported provider',
    body: `${entry.label} is not in the support matrix. Expect reduced reliability — no certification testing.`,
  }
}

export default {
  PROVIDER_TIERS,
  PROVIDER_SUPPORT_MATRIX,
  lookupProviderSupport,
  listProviderSupport,
  isCertified,
  isExperimental,
  isUnsupported,
  providerWarning,
}
