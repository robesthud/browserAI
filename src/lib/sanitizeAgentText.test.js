// Тесты для sanitizeAgentText
import { describe, expect, it } from 'vitest'
import { sanitizeAssistantDelta, segmentAssistantText } from './sanitizeAgentText.js'

describe('sanitizeAgentText', () => {
  it('strips <xai:function_call> blocks from assistant_delta', () => {
    const input = 'Сначала проверю файлы.\n<xai:function_call>\n<xai:tool_name>shell</xai:tool_name>\n<parameter name="command">ls -la</parameter>\n</xai:function_call>\nГотово.'
    const { text, stripped } = sanitizeAssistantDelta(input)
    expect(text).not.toContain('<xai:function_call>')
    expect(text).not.toContain('<xai:tool_name>')
    expect(text).not.toContain('<parameter')
    expect(text).toContain('[tool:0]')
    expect(stripped.length).toBeGreaterThan(0)
  })

  it('strips thinking blocks', () => {
    const input = 'Сначала анализ.\n<thinking>Мне нужно проверить репозиторий</thinking>\nГотово.'
    const { text } = sanitizeAssistantDelta(input)
    expect(text).not.toContain('<thinking>')
    expect(text).not.toContain('Мне нужно проверить')
    expect(text).toContain('Сначала анализ')
    expect(text).toContain('Готово')
  })

  it('preserves normal text untouched', () => {
    const input = 'Просто обычный текст ответа с кодом:\n```js\nconst x = 1;\n```'
    const { text, stripped } = sanitizeAssistantDelta(input)
    expect(text).toBe(input)
    expect(stripped).toEqual([])
  })

  it('segments text into text + tool segments', () => {
    const input = 'Начало.\n<xai:function_call>\n<xai:tool_name>shell</xai:tool_name>\n<parameter name="command">pwd</parameter>\n</xai:function_call>\nПродолжение.'
    const segments = segmentAssistantText(input)
    expect(segments.length).toBeGreaterThanOrEqual(2)
    expect(segments[0].type).toBe('text')
    expect(segments.find((s) => s.type === 'tool')).toBeTruthy()
  })

  it('strips stray XML tags', () => {
    const input = 'Текст <xai:foo bar="x"> и ещё <reasoning>foo</reasoning> конец'
    const { text } = sanitizeAssistantDelta(input)
    expect(text).not.toContain('<xai:foo')
    expect(text).not.toContain('<reasoning>')
    expect(text).toContain('Текст')
    expect(text).toContain('конец')
  })

  it('handles unclosed tool_call block', () => {
    const input = 'Начало <xai:function_call>\n<xai:tool_name>shell</xai:tool_name>\n'
    const { text, stripped } = sanitizeAssistantDelta(input)
    expect(text).not.toContain('<xai:function_call>')
    expect(stripped.length).toBe(1)
    expect(stripped[0].name).toBe('shell')
  })
})
