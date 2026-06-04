/**
 * Cloudflare Worker — прокси для запросов к AI провайдерам.
 */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() })
    }

    // Проверяем ключ
    const authKey = request.headers.get('X-Proxy-Key') || ''
    const expectedKey = env.PROXY_SECRET || ''
    if (expectedKey && authKey !== expectedKey) {
      return json({ error: 'Unauthorized proxy access' }, 403)
    }

    try {
      let targetUrl, headers = {}, body = null, method = 'POST'

      if (request.method === 'GET') {
        // GET: targetUrl и headers из query params
        const url = new URL(request.url)
        targetUrl = url.searchParams.get('url')
        method = 'GET'
        if (!targetUrl) return json({ error: 'url param required' }, 400)
      } else {
        const payload = await request.json()
        targetUrl = payload.targetUrl
        headers = payload.headers || {}
        body = payload.body
        method = payload.method || 'POST'
      }

      if (!targetUrl) return json({ error: 'targetUrl required' }, 400)

      const fetchOptions = {
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          ...headers,
        },
      }
      if (body && method !== 'GET') {
        fetchOptions.headers['Content-Type'] = fetchOptions.headers['Content-Type'] || 'application/json'
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body)
      }

      const upstreamResponse = await fetch(targetUrl, fetchOptions)
      const responseHeaders = new Headers()
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      const ct = upstreamResponse.headers.get('content-type') || ''
      responseHeaders.set('Content-Type', ct)
      responseHeaders.set('X-Upstream-Status', String(upstreamResponse.status))

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      })
    } catch (e) {
      return json({ error: e.message || 'Proxy error' }, 502)
    }
  },
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Key',
  }
}
