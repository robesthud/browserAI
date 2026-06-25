import { describe, expect, it } from 'vitest'
import { __test } from './agentCliRunner.js'

describe('agentCliRunner', () => {
  it('parses cli flags and prompt', () => {
    const opts = __test.parseArgs(['--jsonl', '--chat', 'demo', '--model', 'm1', 'hello', 'world'])
    expect(opts.jsonl).toBe(true)
    expect(opts.chatId).toBe('demo')
    expect(opts.model).toBe('m1')
    expect(opts.prompt).toBe('hello world')
  })

  it('resolves OpenAI env defaults', () => {
    const provider = __test.providerFromOptions({ temperature: 0.2 }, { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-test' })
    expect(provider.baseUrl).toBe('https://api.openai.com/v1')
    expect(provider.apiKey).toBe('sk-test')
    expect(provider.model).toBe('gpt-test')
  })

  it('converts SSE blocks into JSONL events', () => {
    let out = ''
    const res = new __test.CliSseResponse({ jsonl: true, stdout: { write: (s) => { out += s } }, stderr: { write: () => {} } })
    res.write('event: tool_result\ndata: {"event":"tool_result","payload":{"name":"bash","ok":true}}\n\n')
    expect(out.trim()).toBe(JSON.stringify({ event: 'tool_result', name: 'bash', ok: true }))
  })
})
