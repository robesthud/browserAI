import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('mobile iOS viewport optimization', () => {
  it('locks viewport scaling and keeps viewport-fit cover', () => {
    const html = readFileSync('index.html', 'utf8')
    expect(html).toContain('maximum-scale=1')
    expect(html).toContain('user-scalable=no')
    expect(html).toContain('viewport-fit=cover')
  })

  it('installs mobile viewport hardening at app boot', () => {
    const main = readFileSync('src/main.jsx', 'utf8')
    const lib = readFileSync('src/lib/mobileViewport.js', 'utf8')
    expect(main).toContain('setupMobileViewport()')
    expect(lib).toContain('visualViewport')
    expect(lib).toContain('gesturestart')
    expect(lib).toContain('touches.length > 1')
    expect(lib).toContain('keyboard-open')
    expect(lib).toContain('lockPageScroll')
  })

  it('uses app-height css variable and 16px mobile inputs', () => {
    const css = readFileSync('src/index.css', 'utf8')
    expect(css).toContain('--app-height')
    expect(css).toContain('font-size: 16px')
    expect(css).toContain('touch-action: manipulation')
  })
})
