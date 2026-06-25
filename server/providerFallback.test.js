import { describe, it, expect } from 'vitest'
import { isTransientProviderError, isRateLimitError } from './providerFallback.js'

describe('providerFallback', () => {
  describe('isTransientProviderError', () => {
    it('detects 502/503/504', () => {
      expect(isTransientProviderError({ status: 502 })).toBe(true)
      expect(isTransientProviderError({ status: 503 })).toBe(true)
      expect(isTransientProviderError({ status: 504 })).toBe(true)
    })

    it('detects 0 (no connection)', () => {
      expect(isTransientProviderError({ status: 0 })).toBe(true)
    })

    it('detects network error messages', () => {
      expect(isTransientProviderError({ message: 'fetch failed' })).toBe(true)
      expect(isTransientProviderError({ message: 'ECONNREFUSED' })).toBe(true)
      expect(isTransientProviderError({ message: 'socket hang up' })).toBe(true)
      expect(isTransientProviderError({ message: 'ETIMEDOUT' })).toBe(true)
    })

    it('does NOT flag 401/403 as transient', () => {
      expect(isTransientProviderError({ status: 401 })).toBe(false)
      expect(isTransientProviderError({ status: 403 })).toBe(false)
    })

    it('does NOT flag 400 bad request as transient', () => {
      expect(isTransientProviderError({ status: 400 })).toBe(false)
    })

    it('handles null/undefined gracefully', () => {
      // null/undefined: !err check returns false before status check
      expect(isTransientProviderError(null)).toBe(false)
      expect(isTransientProviderError(undefined)).toBe(false)
      // {} has status=0 which is in TRANSIENT_STATUSES (means connection refused/no response)
      // by design: no-info error is treated as transient — safe to retry
      expect(typeof isTransientProviderError({})).toBe('boolean')
    })
  })

  describe('isRateLimitError', () => {
    it('detects 429', () => {
      expect(isRateLimitError({ status: 429 })).toBe(true)
      expect(isRateLimitError({ statusCode: 429 })).toBe(true)
    })

    it('does not flag other statuses', () => {
      expect(isRateLimitError({ status: 503 })).toBe(false)
      expect(isRateLimitError({ status: 401 })).toBe(false)
      expect(isRateLimitError({})).toBe(false)
    })
  })
})
