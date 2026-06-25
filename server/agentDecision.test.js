import { describe, expect, it } from 'vitest'

import {
  extractAgentDecision,
  extractInlineShell,
  extractMarkdownShellCommand,
  parseXmlFunctionCalls,
} from './agentDecision.js'

describe('agentDecision runtime extraction', () => {
  it('turns fenced bash markdown into a real shell decision', () => {
    const decision = extractAgentDecision({
      reply: { text: 'Сейчас проверю.\n```bash\npwd && ls -la\n```' },
      toolExists: (name) => name === 'shell',
    })

    expect(decision.type).toBe('tool_calls')
    expect(decision.source).toBe('markdown_shell')
    expect(decision.calls[0]).toMatchObject({ tool: 'shell', args: { action: 'run', command: 'pwd && ls -la' } })
  })

  it('extracts inline shell commands instead of leaking fake command text', () => {
    expect(extractInlineShell('Попробую `git status && npm test` прямо сейчас.')).toBe('git status && npm test')
    expect(extractMarkdownShellCommand('`cd /tmp && mkdir demo && ls`')).toBe('cd /tmp && mkdir demo && ls')
  })

  it('parses XML tool calls through the same decision layer', () => {
    const calls = parseXmlFunctionCalls('<xai:function_call><xai:tool_name>file</xai:tool_name><parameter name="action">read</parameter><parameter name="path">index.html</parameter></xai:function_call>')
    expect(calls).toEqual([{ tool: 'file', args: { action: 'read', path: 'index.html' } }])
  })

  it('parses DeepSeek direct unclosed tool tags and aliases', () => {
    const text = '<plan_set title="Игра">[{"idx":1,"title":"Сделать"}]<file_write path="index.html">hello</file_write>'
    const decision = extractAgentDecision({
      reply: { text },
      toolExists: (name) => ['plan_set', 'write_file'].includes(name),
      correctToolName: (name) => name === 'file_write' ? 'write_file' : name,
    })
    expect(decision.type).toBe('tool_calls')
    expect(decision.calls[0]).toMatchObject({ tool: 'plan_set', args: { title: 'Игра', steps: [{ idx: 1, title: 'Сделать' }] } })
    expect(decision.calls[1]).toMatchObject({ tool: 'write_file', args: { path: 'index.html', content: 'hello' } })
  })

  it('parses direct self-contained tag attributes as tool args', () => {
    const calls = parseXmlFunctionCalls('<file_write path="a.txt" content="hello">')
    expect(calls).toEqual([{ tool: 'file_write', args: { path: 'a.txt', content: 'hello' } }])
  })

  it('uses streaming pre-parsed calls before treating text as final', () => {
    const decision = extractAgentDecision({
      reply: { text: '', preParsedCalls: [{ kind: 'tool', tool: 'shell', args: { action: 'run', command: 'ls' } }] },
      toolExists: (name) => name === 'shell',
    })
    expect(decision).toMatchObject({ type: 'tool_calls', source: 'stream_parser' })
    expect(decision.calls[0].args.command).toBe('ls')
  })

  it('keeps ordinary assistant text as a final decision', () => {
    const decision = extractAgentDecision({ reply: { text: 'Это обычный ответ без действий.' } })
    expect(decision).toMatchObject({ type: 'final', source: 'assistant_text' })
  })
})
