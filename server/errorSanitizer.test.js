import { describe, expect, it } from 'vitest'
import { safeErrorMessage, safeProviderError, safeLogMeta } from './errorSanitizer.js'

describe('errorSanitizer', () => {
  it('redacts token-like content from error messages', () => {
    const message = safeErrorMessage(new Error('bad key sk-1234567890abcdefghijklmnop'))
    expect(message).not.toContain('sk-1234567890abcdefghijklmnop')
    expect(message).toContain('<redacted:openai_key>')
  })

  it('strips stacks and redacts nested log metadata', () => {
    const meta = safeLogMeta({
      note: 'Bearer supersecrettokenvalue1234567890',
      nested: { password: 'hunter2supersecret' },
      stack: 'top secret stack',
    })
    expect(JSON.stringify(meta)).not.toContain('supersecrettokenvalue1234567890')
    expect(JSON.stringify(meta)).not.toContain('hunter2supersecret')
    expect(meta).not.toHaveProperty('stack')
  })

  it('returns only safe provider error fields', () => {
    const providerError = safeProviderError({
      message: 'invalid sk-1234567890abcdefghijklmnop',
      hint: 'rotate ghp_1234567890abcdefghijABCDEFGHIJ',
      status: 401,
      transient: false,
      phase: 'agent-llm-call',
      model: 'gpt',
      baseUrl: 'https://api.example.com/v1',
      stack: 'hidden',
    })
    expect(providerError.message).not.toContain('sk-1234567890abcdefghijklmnop')
    expect(providerError.hint).not.toContain('ghp_')
    expect(providerError.status).toBe(401)
    expect(providerError.baseUrl).toBe('https://api.example.com/v1')
    expect(providerError).not.toHaveProperty('stack')
  })
})
