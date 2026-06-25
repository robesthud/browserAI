import { describe, expect, it } from 'vitest'
import { mergeProviderConfig } from './providerResolution.js'

describe('providerResolution', () => {
  it('reuses stored provider secret when requested without overwriting explicit overrides', () => {
    const stored = {
      baseUrl: 'https://example.com/v1',
      apiKey: 'stored-secret',
      authType: 'bearer',
      authHeader: '',
      extraHeaders: { Referer: 'https://example.com/' },
      model: 'model-a',
    }

    const merged = mergeProviderConfig({
      keyId: 'k1',
      useStoredSecret: true,
      baseUrl: stored.baseUrl,
      model: 'model-b',
      extraHeaders: { 'X-Test': '1' },
    }, stored)

    expect(merged.apiKey).toBe('stored-secret')
    expect(merged.model).toBe('model-b')
    expect(merged.extraHeaders).toEqual({ 'X-Test': '1' })
  })

  it('keeps explicit inline secrets when they are provided', () => {
    const stored = {
      baseUrl: 'https://example.com/v1',
      apiKey: 'stored-secret',
      authType: 'bearer',
      authHeader: '',
      extraHeaders: {},
      model: 'model-a',
    }

    const merged = mergeProviderConfig({
      baseUrl: stored.baseUrl,
      apiKey: 'inline-secret',
      model: 'model-a',
    }, stored)

    expect(merged.apiKey).toBe('inline-secret')
  })
})
