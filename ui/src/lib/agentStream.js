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
export function streamAgent({ chatId = '', history, provider, extraSystem = '', onEvent, signal, turnId = '' }) {
  if (!provider || !provider.baseUrl || !provider.model) {
    onEvent?.('error', { code: 'no_provider', message: 'No active API key or model selected. Open Settings and choose a provider.' })
    onEvent?.('done', { reason: 'no-provider' })
    return () => {}
  }
  const controller = signal ? null : new AbortController()
  const actualSignal = signal || controller.signal
  // Generate a unique turn ID for idempotency: if the SSE connection
  // drops and the client retries, the same turnId tells the server
  // "this is the same request, don't re-send the message to OpenHands."
  const effectiveTurnId = turnId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

  // CRITICAL: the caller's promise resolves only when a 'done' event
  // arrives. If the connection drops mid-stream (server redeploy, flaky
  // mobile network, proxy timeout) the reader just ends — without a
  // synthetic 'done' the UI spinner would spin forever and silently
  // swallow every next message (Composer ignores submits while
  // isStreaming). Track it and always emit one.
  let sawDone = false

  // Phase 1: rAF-based event batching for smoother UI rendering.
  // Instead of emitting every SSE event immediately (which can cause
  // 60+ React state updates per second on fast streams), we batch events
  // and flush them on the next animation frame.
  const pendingEvents = []
  let rafScheduled = false
  const flushEvents = () => {
    rafScheduled = false
    if (!pendingEvents.length) return
    const batch = pendingEvents.splice(0)
    for (const { kind, data } of batch) {
      if (kind === 'done') sawDone = true
      onEvent?.(kind, data)
    }
  }
  const scheduleFlush = () => {
    if (rafScheduled) return
    rafScheduled = (typeof requestAnimationFrame !== 'undefined')
      ? requestAnimationFrame(flushEvents)
      : setTimeout(flushEvents, 16)
  }
  const emit = (kind, data) => {
    // Critical events flush immediately for instant feedback
    if (kind === 'done' || kind === 'error' || kind === 'assistant') {
      if (rafScheduled) {
        (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame : clearTimeout)(rafScheduled)
        rafScheduled = false
      }
      pendingEvents.push({ kind, data })
      flushEvents()
      return
    }
    pendingEvents.push({ kind, data })
    scheduleFlush()
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
          turnId:       effectiveTurnId,
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
      const processBlock = (block) => {
        if (!block.trim()) return
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

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        for (const block of events) processBlock(block)
      }

      // Some proxies / runtimes close the stream right after writing the final
      // SSE frame without an extra delimiter. Flush the trailing buffer so the
      // terminal `done` event is not lost, otherwise the UI keeps spinning even
      // though the assistant text is already visible.
      if (buffer.trim()) {
        processBlock(buffer)
        buffer = ''
      }
      // Stream ended without an explicit 'done' (connection cut mid-run,
      // server restarted, LB idle-timeout). Surface it instead of hanging.
      if (!sawDone) {
        emit('error', { code: 'stream_cut', message: 'Stream ended before completion (server restarted or connection lost). Please retry.' })
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

  return () => { try { controller?.abort() } catch { /* already aborted */ } }
}

/**
 * Resume an in-flight agent conversation WITHOUT sending a new message.
 * Called after answering an ask_user question so the post-answer work streams
 * live into the same assistant message. Reuses the SSE frame parser above.
 *
 *   const stop = resumeAgent({ chatId, onEvent, signal })
 */
export function resumeAgent({ chatId = '', onEvent, signal }) {
  if (!chatId) { onEvent?.('done', { reason: 'no-chat' }); return () => {} }
  const controller = signal ? null : new AbortController()
  const actualSignal = signal || controller.signal
  let sawDone = false
  const emit = (kind, data) => { if (kind === 'done') sawDone = true; onEvent?.(kind, data) }

  ;(async () => {
    try {
      const res = await fetch('/api/agent/resume', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
        signal: actualSignal,
      })
      if (!res.ok) { emit('error', { message: `HTTP ${res.status}` }); emit('done', { reason: 'http-error' }); return }
      const reader = res.body?.getReader()
      if (!reader) { emit('done', { reason: 'no-body' }); return }
      const decoder = new TextDecoder()
      let buffer = ''
      const processBlock = (block) => {
        if (!block.trim()) return
        let evt = 'message'; const dataLines = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) evt = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        const raw = dataLines.join('\n')
        let parsed = raw
        try { parsed = JSON.parse(raw) } catch { /* keep string */ }
        emit(evt, parsed)
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        for (const block of events) processBlock(block)
      }
      if (buffer.trim()) processBlock(buffer)
      if (!sawDone) { emit('done', { reason: 'stream-cut' }) }
    } catch (e) {
      if (sawDone) return
      if (e?.name === 'AbortError') emit('done', { reason: 'aborted' })
      else { emit('error', { message: e?.message || String(e) }); emit('done', { reason: 'exception' }) }
    }
  })()

  return () => { try { controller?.abort() } catch { /* already aborted */ } }
}
