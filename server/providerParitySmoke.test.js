import { describe, expect, it } from 'vitest'
import { listProviderParityTargets, runProviderParityMatrix } from './providerParitySmoke.js'

describe('providerParitySmoke', () => {
  it('returns a descriptor list without exposing raw secrets', () => {
    const targets = listProviderParityTargets({ activeOnly: false })
    expect(Array.isArray(targets)).toBe(true)
    for (const t of targets) {
      expect(t).not.toHaveProperty('apiKey')
      expect(t).toHaveProperty('keyId')
      expect(t).toHaveProperty('baseUrl')
      expect(t).toHaveProperty('model')
    }
  })

  it('returns an empty but valid matrix summary when no providers match', async () => {
    const result = await runProviderParityMatrix({ keyIds: ['does-not-exist'], scenarioIds: ['chat_ok'], maxProviders: 1 })
    expect(result.schema).toBe('browserai.provider_parity_smoke.v2')
    expect(result.count).toBe(0)
    expect(Array.isArray(result.scenarioSummary)).toBe(true)
  })
})
