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

  // CRITICAL: the caller's promise resolves only when a 'done' event
  // arrives. If the connection drops mid-stream (server redeploy, flaky
  // mobile network, proxy timeout) the reader just ends — without a
  // synthetic 'done' the UI spinner would spin forever and silently
  // swallow every next message (Composer ignores submits while
  // isStreaming). Track it and always emit one.
  let sawDone = false

  // Phase 1.4 — Streaming UX: coalesce high-frequency delta events to one
  // browser paint. This keeps long assistant/thinking/tool streams smooth on
  // mobile and avoids React re-render storms. Non-delta/control events flush the
  // buffers first so ordering remains deterministic.
  const scheduleFrame = (cb) => {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb)
    return setTimeout(cb, 16)
  }
  const cancelFrame = (id) => {
    if (id == null) return
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
    else clearTimeout(id)
  }

  let frameId = null
  let assistantDeltaBuffer = ''
  let assistantDeltaMeta = null
  let thinkingDeltaBuffer = ''
  let thinkingDeltaMeta = null
  const toolProgressBuffers = new Map()

  const rawEmit = (kind, data) => {
    if (kind === 'done') sawDone = true
    onEvent?.(kind, data)
  }

  const toolProgressKey = (data = {}) => `${data.step ?? ''}:${data.sub ?? ''}:${data.name || ''}`

  const flushDelta = () => {
    if (frameId != null) {
      cancelFrame(frameId)
      frameId = null
    }
    if (assistantDeltaBuffer) {
      const meta = assistantDeltaMeta || {}
      const chunk = assistantDeltaBuffer
      assistantDeltaBuffer = ''
      assistantDeltaMeta = null
      rawEmit('assistant_delta', { ...meta, chunk })
    }
    if (thinkingDeltaBuffer) {
      const meta = thinkingDeltaMeta || {}
      const chunk = thinkingDeltaBuffer
      thinkingDeltaBuffer = ''
      thinkingDeltaMeta = null
      rawEmit('thinking_delta', { ...meta, chunk })
    }
    if (toolProgressBuffers.size) {
      const batch = Array.from(toolProgressBuffers.values())
      toolProgressBuffers.clear()
      for (const item of batch) rawEmit('tool_progress', item)
    }
  }

  const scheduleDeltaFlush = () => {
    if (frameId != null) return
    frameId = scheduleFrame(() => {
      frameId = null
      flushDelta()
    })
  }

  const emit = (kind, data) => {
    if (kind === 'assistant_delta') {
      assistantDeltaBuffer += String(data?.chunk || '')
      assistantDeltaMeta = { ...(assistantDeltaMeta || {}), ...(data || {}) }
      scheduleDeltaFlush()
      return
    }
    if (kind === 'thinking_delta') {
      thinkingDeltaBuffer += String(data?.chunk || '')
      thinkingDeltaMeta = { ...(thinkingDeltaMeta || {}), ...(data || {}) }
      scheduleDeltaFlush()
      return
    }
    if (kind === 'tool_progress' && data && Object.prototype.hasOwnProperty.call(data, 'chunk')) {
      const key = toolProgressKey(data)
      const prev = toolProgressBuffers.get(key) || { ...data, chunk: '' }
      toolProgressBuffers.set(key, { ...prev, ...data, chunk: String(prev.chunk || '') + String(data.chunk || '') })
      scheduleDeltaFlush()
      return
    }
    flushDelta()
    rawEmit(kind, data)
  }

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
          keyId:        provider.keyId || '',
          useStoredSecret: Boolean(provider.useStoredSecret),
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
        emit('error', { message: `HTTP ${res.status}: ${text || res.statusText}` })
        emit('done', { reason: 'http-error' })
        return
      }
      const reader = res.body?.getReader()
      if (!reader) {
        emit('error', { message: 'No response body' })
        emit('done', { reason: 'no-body' })
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
          emit(evt, parsed)
        }
      }
      // Stream ended without an explicit 'done' (connection cut mid-run,
      // server restarted, LB idle-timeout). Surface it instead of hanging.
      if (!sawDone) {
        emit('error', { message: 'Поток оборвался до завершения ответа (сервер перезапущен или потеряна связь). Попробуйте ещё раз.' })
        emit('done', { reason: 'stream-cut' })
      }
    } catch (e) {
      if (sawDone) {
        return
      }
      if (e?.name === 'AbortError') {
        emit('done', { reason: 'aborted' })
      } else {
        emit('error', { message: e?.message || String(e) })
        emit('done', { reason: 'exception' })
      }
    }
  })()

  return () => {
    try { flushDelta() } catch { /* ignore flush errors on abort */ }
    try { controller?.abort() } catch { /* already aborted */ }
  }
}
