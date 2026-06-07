function decodeHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
}

function stripHtml(html = '') {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function normalizeSearchResultUrl(rawUrl = '') {
  const decoded = decodeHtmlEntities(rawUrl)
  if (!decoded) return ''

  let absolute = decoded.startsWith('//') ? `https:${decoded}` : decoded

  try {
    const parsed = new URL(absolute)
    if (parsed.hostname.endsWith('duckduckgo.com')) {
      const target = parsed.searchParams.get('uddg')
      if (target) return decodeURIComponent(target)
    }
    return parsed.toString()
  } catch {
    return absolute
  }
}

function extractDuckDuckGoResults(html, limit) {
  const results = []
  const regex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi

  let match
  while ((match = regex.exec(html)) && results.length < limit) {
    const url = normalizeSearchResultUrl(match[1])
    const title = stripHtml(match[2])
    const snippet = stripHtml(match[3])
    if (!url || !title) continue
    results.push({ title, url, snippet })
  }

  return results
}

async function searchWeb(query, limit = 5) {
  const q = String(query || '').trim()
  const safeLimit = Math.min(10, Math.max(1, Number(limit) || 5))
  if (!q) return []

  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BrowserAI/1.0)',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const html = await response.text()
    return extractDuckDuckGoResults(html, safeLimit)
  } catch (error) {
    console.warn('Web search failed:', error?.message || error)
    return []
  }
}

// #13 FIX: проверяем URL перед fetch, чтобы исключить SSRF-атаки через fetchWebPage
import { isPrivateIp } from './ssrf.js'

function assertPublicWebUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed')
  }
  const host = parsed.hostname
  if (host === 'localhost' || host.endsWith('.local') || isPrivateIp(host)) {
    throw new Error('Access to internal networks is not allowed')
  }
}

async function fetchWebPage(url) {
  assertPublicWebUrl(url)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BrowserAI/1.0)',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const html = await response.text()
    return {
      url,
      content: stripHtml(html),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export { searchWeb, fetchWebPage }
