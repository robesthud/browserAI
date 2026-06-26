import { describe, expect, it } from 'vitest'
import {
  PROVIDER_SUPPORT_MATRIX,
  PROVIDER_TIERS,
  lookupProviderSupport,
  listProviderSupport,
  isCertified,
  isExperimental,
  isUnsupported,
  providerWarning,
} from './providerSupport.js'

describe('providerSupport: matrix integrity', () => {
  it('contains only the 4 canonical tiers', () => {
    expect(PROVIDER_TIERS).toEqual(['certified', 'experimental', 'unsupported', 'legacy'])
    for (const entry of PROVIDER_SUPPORT_MATRIX) {
      expect(PROVIDER_TIERS).toContain(entry.tier)
    }
  })

  it('every matrix entry has id, label, tier, knownLimitations', () => {
    for (const entry of PROVIDER_SUPPORT_MATRIX) {
      expect(entry.id).toBeTypeOf('string')
      expect(entry.label).toBeTypeOf('string')
      expect(Array.isArray(entry.knownLimitations)).toBe(true)
    }
  })

  it('every matrix entry has a testedAt date', () => {
    for (const entry of PROVIDER_SUPPORT_MATRIX) {
      expect(entry.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('production-critical provider (managed_deepseek) is certified', () => {
    const entry = lookupProviderSupport({ id: 'managed_deepseek' })
    expect(entry.tier).toBe('certified')
  })

  it('at least one experimental provider exists', () => {
    const exp = PROVIDER_SUPPORT_MATRIX.filter((e) => e.tier === 'experimental')
    expect(exp.length).toBeGreaterThanOrEqual(1)
  })
})

describe('providerSupport: lookupProviderSupport', () => {
  it('matches by id', () => {
    const e = lookupProviderSupport({ id: 'managed_deepseek' })
    expect(e.id).toBe('managed_deepseek')
    expect(e.tier).toBe('certified')
  })

  it('matches by baseUrl pattern', () => {
    const e = lookupProviderSupport({ baseUrl: 'https://chat.deepseek.com/api/v0' })
    expect(e.id).toBe('managed_deepseek')
  })

  it('matches Gemini by baseUrl pattern', () => {
    const e = lookupProviderSupport({ baseUrl: 'https://generativelanguage.googleapis.com/v1' })
    expect(e.id).toBe('gemini_official')
  })

  it('matches Anthropic by baseUrl pattern', () => {
    const e = lookupProviderSupport({ baseUrl: 'https://api.anthropic.com/v1' })
    expect(e.id).toBe('anthropic_official')
  })

  it('matches OpenAI-compat providers by baseUrl', () => {
    const a = lookupProviderSupport({ baseUrl: 'https://openrouter.ai/api/v1' })
    expect(a.id).toBe('openai_compat')
    const b = lookupProviderSupport({ baseUrl: 'https://api.together.xyz/v1' })
    expect(b.id).toBe('openai_compat')
  })

  it('returns unsupported entry for unknown provider', () => {
    // Use a URL that matches NONE of the patterns in PROVIDER_SUPPORT_MATRIX.
    const e = lookupProviderSupport({ baseUrl: 'https://totally-not-recognised.example.com/api', id: 'mystery' })
    expect(e.tier).toBe('unsupported')
    expect(e.knownLimitations.length).toBeGreaterThan(0)
  })

  it('returns openai_compat for URLs ending in /v1 (catch-all)', () => {
    const e = lookupProviderSupport({ baseUrl: 'https://mystery.example/v1' })
    expect(e.id).toBe('openai_compat')
    expect(e.tier).toBe('experimental')
  })

  it('returns unsupported entry for empty input', () => {
    const e = lookupProviderSupport({})
    expect(e.tier).toBe('unsupported')
  })
})

describe('providerSupport: tier predicates', () => {
  it('isCertified matches certified providers', () => {
    expect(isCertified({ id: 'managed_deepseek' })).toBe(true)
    expect(isCertified({ id: 'gemini_official' })).toBe(true)
    expect(isCertified({ id: 'anthropic_official' })).toBe(false)
    expect(isCertified({ id: 'openai_compat' })).toBe(false)
    expect(isCertified({ id: 'unknown' })).toBe(false)
  })

  it('isExperimental matches experimental providers', () => {
    expect(isExperimental({ id: 'openai_compat' })).toBe(true)
    expect(isExperimental({ id: 'anthropic_official' })).toBe(true)
    expect(isExperimental({ id: 'managed_deepseek' })).toBe(false)
    expect(isExperimental({ id: 'unknown' })).toBe(false)
  })

  it('isUnsupported matches unknown providers', () => {
    expect(isUnsupported({ id: 'mystery' })).toBe(true)
    expect(isUnsupported({ id: 'managed_deepseek' })).toBe(false)
  })
})

describe('providerSupport: providerWarning', () => {
  it('returns null for certified', () => {
    expect(providerWarning({ id: 'managed_deepseek' })).toBeNull()
    expect(providerWarning({ id: 'gemini_official' })).toBeNull()
  })

  it('returns warn for experimental', () => {
    const w = providerWarning({ id: 'openai_compat' })
    expect(w).not.toBeNull()
    expect(w.severity).toBe('warn')
    expect(w.title).toMatch(/Experimental/)
  })

  it('returns error for unsupported', () => {
    const w = providerWarning({ id: 'unknown_provider' })
    expect(w).not.toBeNull()
    expect(w.severity).toBe('error')
    expect(w.title).toMatch(/Unsupported/)
  })
})

describe('providerSupport: listProviderSupport', () => {
  it('returns a copy of the matrix', () => {
    const list = listProviderSupport()
    expect(list.length).toBe(PROVIDER_SUPPORT_MATRIX.length)
    expect(list).not.toBe(PROVIDER_SUPPORT_MATRIX)  // defensive copy
  })
})
