import { getActiveKeyDecrypted, getKeyByIdDecrypted } from './db.js'
import { isDeepSeekWebUrl } from './deepseekWeb.js'
import { getActiveBearer, getCookieHeader } from './deepseekTokenRefresher.js'

export function resolveStoredProviderRef(input = {}) {
  const keyId = String(input?.keyId || '').trim()
  if (keyId) return getKeyByIdDecrypted(keyId, null)
  if (input?.useStoredSecret) return getActiveKeyDecrypted(null)
  return null
}

export function mergeProviderConfig(input = {}, stored = null) {
  let {
    baseUrl,
    apiKey,
    authType = 'bearer',
    authHeader = '',
    extraHeaders = {},
    model,
    temperature = 0.7,
    forceAgent = false,
  } = input || {}

  if ((!apiKey || input?.useStoredSecret) && stored) {
    baseUrl = baseUrl || stored.baseUrl
    apiKey = apiKey || stored.apiKey
    authType = authType || stored.authType || 'bearer'
    authHeader = authHeader || stored.authHeader || ''
    extraHeaders = Object.keys(extraHeaders || {}).length ? extraHeaders : (stored.extraHeaders || {})
    model = model || stored.model
  }

  return {
    baseUrl,
    apiKey,
    authType,
    authHeader,
    extraHeaders,
    model,
    temperature,
    forceAgent,
  }
}

export function applyManagedDeepSeekProvider(provider = {}, { requireBearer = false } = {}) {
  let next = { ...(provider || {}) }
  if (!isDeepSeekWebUrl(next.baseUrl) || (next.apiKey && next.apiKey !== '__managed__')) return next

  const managedBearer = getActiveBearer()
  const managedCookies = getCookieHeader()
  if (requireBearer && !managedBearer) {
    const err = new Error('DeepSeek session not configured')
    err.statusCode = 503
    throw err
  }
  next.apiKey = managedBearer || ''
  next.extraHeaders = { ...(next.extraHeaders || {}) }
  if (managedCookies) next.extraHeaders.Cookie = managedCookies
  return next
}

export function resolveProviderFromInput(input = {}, { requireBearer = false } = {}) {
  const stored = resolveStoredProviderRef(input)
  const merged = mergeProviderConfig(input, stored)
  return applyManagedDeepSeekProvider(merged, { requireBearer })
}

export default resolveProviderFromInput
