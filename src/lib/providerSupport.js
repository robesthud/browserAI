/**
 * providerSupport.js (frontend mirror)
 *
 * Approach 7 — Trust UX. Browser-side mirror of server/providerSupport.js.
 * Used by SettingsModal and AgentEvidenceBlock to show tier badges without
 * a server roundtrip.
 *
 * The lookup logic MUST stay in sync with server/providerSupport.js. The
 * frontend only mirrors the user-facing subset (id + tier + baseUrlPattern
 * + warning text) and skips the testing-only fields (sampleRunId, etc.).
 */

export const PROVIDER_TIERS = ['certified', 'experimental', 'unsupported', 'legacy']

export const PROVIDER_SUPPORT_MATRIX = [
  {
    id: 'managed_deepseek',
    label: 'DeepSeek managed session',
    tier: 'certified',
    baseUrlPattern: /chat\.deepseek\.com\/api\/v0/,
    knownLimitations: ['No native function-calling — JSON-in-text fallback'],
  },
  {
    id: 'gemini_official',
    label: 'Google Gemini (AI Studio)',
    tier: 'certified',
    baseUrlPattern: /generativelanguage\.googleapis\.com/,
    knownLimitations: ['Free-tier quota may saturate during parallel runs'],
  },
  {
    id: 'anthropic_official',
    label: 'Anthropic Claude',
    tier: 'experimental',
    baseUrlPattern: /api\.anthropic\.com/,
    knownLimitations: ['Not all Anthropic models support tool use'],
  },
  {
    id: 'ollama_local',
    label: 'Ollama (local)',
    tier: 'experimental',
    baseUrlPattern: /(localhost|127\.0\.0\.1):11434/,
    knownLimitations: ['Quality depends on local model size and quantization'],
  },
  {
    id: 'openai_compat',
    label: 'OpenAI-compatible',
    tier: 'experimental',
    baseUrlPattern: /\/(v1|api\/v1)\/?$/,
    knownLimitations: ['Capabilities differ per upstream'],
  },
]

export function lookupProviderTier(provider = {}) {
  const baseUrl = String(provider?.baseUrl || '')
  const id = String(provider?.id || '')
  if (id) {
    const byId = PROVIDER_SUPPORT_MATRIX.find((m) => m.id === id)
    if (byId) return byId
  }
  for (const entry of PROVIDER_SUPPORT_MATRIX) {
    if (entry.baseUrlPattern && entry.baseUrlPattern.test(baseUrl)) return entry
  }
  return { tier: 'unsupported', label: 'unknown', knownLimitations: [], baseUrlPattern: null }
}

export function providerBadgeClass(tier = '') {
  if (tier === 'certified') return 'tier-badge tier-certified'
  if (tier === 'experimental') return 'tier-badge tier-experimental'
  if (tier === 'legacy') return 'tier-badge tier-legacy'
  return 'tier-badge tier-unsupported'
}

export function providerBadgeText(tier = '') {
  if (tier === 'certified') return '✓ certified'
  if (tier === 'experimental') return '⚠ experimental'
  if (tier === 'legacy') return 'legacy'
  return 'unsupported'
}

export default {
  PROVIDER_TIERS,
  PROVIDER_SUPPORT_MATRIX,
  lookupProviderTier,
  providerBadgeClass,
  providerBadgeText,
}
