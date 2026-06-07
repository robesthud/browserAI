/**
 * Lightweight SSE client for /api/agent/chat.
 *
 * The endpoint emits named events:
 *   thinking      {step}
 *   tool_start    {step, name, args}
 *   tool_result   {step, name, ok, result?, error?}
 *   assistant     {text}
 *   done          {steps, reason}
 *   error         {message}
 *
 * Usage:
 *   const stop = streamAgent({
 *     history,
 *     model,
 *     onEvent: (kind, data) => { ... },
 *   })
 *   // call stop() to abort
 */
export function streamAgent({ chatId = '', history, provider, extraSystem = '', onEvent, signal }) {
  if (!provider || !provider.baseUrl || !provider.model) {
    onEvent?.('error', { message: 'Не выбран активный API-ключ или модель. Открой Настройки и выбери провайдера.' })
    onEvent?.('done', { reason: 'no-provider' })
    return () => {}
  }
  const controller = signal ? null : new AbortController()
  const actualSignal = signal || controller.signal

  ;(async () => {
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          history,
          extraSystem,
          // Provider config — flatten into the body so /api/agent/chat
          // can apply the same SSRF / managed-injection rules /api/chat uses.
          baseUrl:      provider.baseUrl,
          apiKey:       provider.apiKey || '',
          authType:     provider.authType || 'bearer',
          authHeader:   provider.authHeader || '',
          extraHeaders: provider.extraHeaders || {},
          model:        provider.model,
          temperature:  Number(provider.temperature ?? 0.3),
        }),
        signal: actualSignal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        onEvent?.('error', { message: `HTTP ${res.status}: ${text || res.statusText}` })
        onEvent?.('done', { reason: 'http-error' })
        return
      }
      const reader = res.body?.getReader()
      if (!reader) {
        onEvent?.('error', { message: 'No response body' })
        return
      }
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        for (const block of events) {
          if (!block.trim()) continue
          let evt = 'message'
          let dataLines = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) evt = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          }
          const raw = dataLines.join('\n')
          let parsed = raw
          try { parsed = JSON.parse(raw) } catch { /* keep string */ }
          onEvent?.(evt, parsed)
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        onEvent?.('done', { reason: 'aborted' })
      } else {
        onEvent?.('error', { message: e?.message || String(e) })
        onEvent?.('done', { reason: 'exception' })
      }
    }
  })()

  return () => { try { controller?.abort() } catch { /* already aborted */ } }
}
