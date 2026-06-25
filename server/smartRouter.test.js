import { describe, expect, it } from 'vitest'
import { routeUserMessage } from './smartRouter.js'

describe('smartRouter', () => {
  it('defaults ambiguous/simple turns to full agent mode', () => {
    const routed = routeUserMessage('привет')
    expect(routed.mode).toBe('agent')
    expect(routed.reason).toBe('default-agent')
  })

  it('still detects explicit web/current-info requests', () => {
    expect(routeUserMessage('какая погода сейчас?').mode).toBe('web')
  })
})
