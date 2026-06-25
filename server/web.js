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
      signal: AbortSignal.timeout(15_000),  // C — 15s timeout on web search
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
import dns from 'node:dns/promises'
import { isPrivateIp } from './ssrf.js'

async function assertPublicWebUrl(rawUrl) {
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

  // Защита от DNS Rebinding / SSRF обхода через локальные IP
  try {
    const lookup = await dns.lookup(host)
    if (lookup && isPrivateIp(lookup.address)) {
      throw new Error('Access to internal networks is not allowed (resolved private IP)')
    }
  } catch (err) {
    if (err.message && err.message.includes('not allowed')) throw err
    // Ошибки резолва пропускаем — fetch сам упадет
  }
}

async function fetchWebPage(url) {
  await assertPublicWebUrl(url)

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

    // C — cap response size to 5 MB to prevent OOM on huge pages
    const MAX_FETCH_BYTES = 5 * 1024 * 1024
    const buf = await response.arrayBuffer()
    if (buf.byteLength > MAX_FETCH_BYTES) {
      const truncated = new TextDecoder().decode(buf.slice(0, MAX_FETCH_BYTES))
      return { url, content: stripHtml(truncated) + '\n...[truncated: response exceeded 5 MB]' }
    }
    const html = new TextDecoder().decode(buf)
    return {
      url,
      content: stripHtml(html),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export { searchWeb, fetchWebPage }
