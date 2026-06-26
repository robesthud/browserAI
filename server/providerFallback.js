/**
 * providerFallback.js
 *
 * C — Automatic provider fallback when the active LLM is unavailable.
 *
 * Chain: user active key → DeepSeek Managed → null (give up)
 *
 * Triggered by:
 *  - 503 / 502 / 504 (server unavailable)
 *  - timeout / ECONNREFUSED / fetch failed
 *  - 429 rate-limited (retry same after delay)
 *
 * NOT triggered by:
 *  - 401 / 403 (wrong key — user must fix)
 *  - 400 (bad request — model / params issue)
 */

import { getSessionState, getActiveBearer, getCookieHeader } from './deepseekTokenRefresher.js'
import { isDeepSeekWebUrl } from './deepseekWeb.js'

const TRANSIENT_STATUSES = new Set([502, 503, 504, 0])
const RATE_LIMIT_STATUS  = 429

/**
 * Returns true if the error looks like a transient network / server problem
 * (safe to retry with a different provider).
 */
export function isTransientProviderError(err) {
  if (err == null || err === undefined) return false  // explicit null/undefined → not transient
  if (!err) return false
  const status = Number(err.status || err.statusCode || 0)
  if (TRANSIENT_STATUSES.has(status)) return true
  const msg = String(err.message || '').toLowerCase()
  return /fetch failed|econnrefused|econnreset|etimedout|network error|timeout|socket hang up/i.test(msg)
}

export function isRateLimitError(err = {}) {
  return Number(err.status || err.statusCode || 0) === RATE_LIMIT_STATUS
}

/**
 * Build a DeepSeek Managed provider object if the session is alive.
 */
function buildDeepSeekFallback() {
  const state = getSessionState()
  const bearer = getActiveBearer()
  if (!state?.alive || !bearer) return null
  return {
    baseUrl: 'https://chat.deepseek.com/api/v0',
    apiKey: bearer,
    authType: 'bearer',
    authHeader: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    extraHeaders: {
      Referer: 'https://chat.deepseek.com/',
      Origin: 'https://chat.deepseek.com',
      Cookie: getCookieHeader() || '',
    },
    _fallbackSource: 'deepseek_managed',
  }
}


/**
 * Given a provider that just failed and its error, return the next
 * provider to try — or null if no fallback is available.
 *
 * @param {object} failedProvider
 * @param {object} error   — normalized provider error from normalizeProviderError()
 * @returns {Promise<object|null>}
 */
export async function resolveNextProvider(failedProvider, error) {
  // Rate-limited: retry the SAME provider once, then fall through to alternatives
  // S2-D1: guard against infinite 429 loop — only retry-same once per chain
  if (isRateLimitError(error) && !failedProvider._retried) {
    const delay = Number(error.retryAfter || 2000)
    await new Promise(r => setTimeout(r, Math.min(delay, 10_000)))
    return { ...failedProvider, _fallbackSource: 'retry_same', _retried: true }
  }

  if (!isTransientProviderError(error)) return null  // auth / bad request — no fallback

  const alreadyTried = new Set([
    failedProvider._fallbackSource,
    isDeepSeekWebUrl(failedProvider.baseUrl) ? 'deepseek_managed' : null,
  ].filter(Boolean))

  // 1. Try DeepSeek Managed (free, usually available)
  if (!alreadyTried.has('deepseek_managed')) {
    const ds = buildDeepSeekFallback()
    if (ds) return ds
  }

  return null  // exhausted all fallbacks
}

export default { resolveNextProvider, isTransientProviderError, isRateLimitError }
