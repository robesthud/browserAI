import { EventEmitter } from 'node:events'

export function parseSseBlock(block = '') {
  let event = 'message'
  const data = []
  for (const line of String(block || '').split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  const raw = data.join('\n')
  try { return { event, data: JSON.parse(raw) } } catch { return { event, data: raw } }
}

export function createAgentSseCapture({ onEvent = null } = {}) {
  const emitter = new EventEmitter()
  let buffer = ''
  let assistant = ''
  const events = []

  const capture = (evt) => {
    events.push(evt)
    try { onEvent?.(evt) } catch { /* ignore observer failures */ }
  }

  return {
    setHeader() {},
    flushHeaders() {},
    on: (...args) => emitter.on(...args),
    emitClose: () => emitter.emit('close'),
    write(chunk) {
      buffer += String(chunk || '')
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      for (const block of blocks) {
        if (!block.trim() || block.startsWith(':')) continue
        const evt = parseSseBlock(block)
        const payload = evt.data?.payload || evt.data || {}
        capture({ event: evt.event, payload })
        if (evt.event === 'assistant_delta') assistant += String(payload.chunk || '')
        else if (evt.event === 'assistant') assistant = String(payload.text || assistant || '')
      }
    },
    end() { emitter.emit('close') },
    status() { return this },
    json(obj) { this.write(`event: json\ndata: ${JSON.stringify(obj)}\n\n`); this.end(); return this },
    getAssistantText: () => assistant,
    getEvents: () => events.slice(),
  }
}

export default createAgentSseCapture
