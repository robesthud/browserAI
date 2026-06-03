/**
 * Cloudflare Worker — прокси для сессионных запросов к AI провайдерам.
 * Решает проблему гео-блокировки: Railway IP блокируется DeepSeek,
 * а Cloudflare Workers имеют IP по всему миру.
 *
 * Деплой:
 *   npx wrangler deploy
 *
 * Использование из BrowserAI:
 *   PROXY_URL=https://your-worker.your-subdomain.workers.dev
 *   Сервер шлёт POST на PROXY_URL с телом { targetUrl, headers, body }
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      })
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405)
    }

    // Проверяем секретный ключ (чтобы прокси не использовали посторонние)
    const authKey = request.headers.get('X-Proxy-Key') || ''
    const expectedKey = env.PROXY_SECRET || ''
    if (expectedKey && authKey !== expectedKey) {
      return json({ error: 'Unauthorized proxy access' }, 403)
    }

    try {
      const payload = await request.json()
      const { targetUrl, headers = {}, body } = payload

      if (!targetUrl) {
        return json({ error: 'targetUrl required' }, 400)
      }

      // Проксируем запрос к целевому URL
      const upstreamResponse = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })

      // Пробрасываем ответ как есть (включая streaming)
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
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Key',
  }
}
