import { describe, expect, it } from 'vitest'

import { composeEvidenceBackedFinal, isWeakFinal } from './agentFinalComposer.js'

describe('agentFinalComposer', () => {
  it('expands weak final answers with runtime evidence', () => {
    const text = composeEvidenceBackedFinal({
      draft: 'Готово.',
      agentContext: { task: { obligations: { verify: true } } },
      recentToolHistory: [
        { tool: 'file', ok: true, args: '{"action":"write","path":"src/app.js"}', outcome: '120 bytes written' },
        { tool: 'shell', ok: true, args: '{"action":"run","command":"npm test"}', outcome: 'exit=0 duration=1s' },
      ],
      agentState: {},
    })

    expect(isWeakFinal('Готово.')).toBe(true)
    expect(text).toMatch(/что подтверждено реальными действиями/i)
    expect(text).toContain('src/app.js')
    expect(text).toContain('npm test')
    expect(text).toMatch(/### Runtime evidence/)
  })

  it('keeps strong drafts but still appends collapsed evidence marker', () => {
    const draft = 'Изменил файл src/app.js и запустил проверку npm test — команда завершилась успешно.'
    const text = composeEvidenceBackedFinal({
      draft,
      agentContext: { task: { obligations: {} } },
      recentToolHistory: [
        { tool: 'shell', ok: true, args: '{"action":"run","command":"npm test"}', outcome: 'exit=0' },
      ],
      agentState: {},
    })
    expect(text.startsWith(draft)).toBe(true)
    expect(text).toMatch(/### Runtime evidence/)
  })
})
