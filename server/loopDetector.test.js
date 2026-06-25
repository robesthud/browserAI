// Тесты для нового similarity-based loop detector
import { describe, expect, it } from 'vitest'

// Импортируем через test export из agentLoop.js
import { __test } from './agentLoop.js'

describe('agent loop detector (similarity-based)', () => {
  it('passes for unique calls', () => {
    const fp = __test.callFingerprint({ tool: 'shell', args: { action: 'run', command: 'ls' } })
    const family = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'ls' } })
    expect(__test.isStuckLoop([], fp, [], family)).toBe(false)
    expect(__test.isStuckLoop(['shell::x', 'shell::y', 'shell::z'], fp, ['f1', 'f2', 'f3'], family)).toBe(false)
  })

  it('detects 4+ consecutive identical calls', () => {
    const fp = __test.callFingerprint({ tool: 'shell', args: { action: 'run', command: 'git status' } })
    const family = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'git status' } })
    const recent = [fp, fp, fp] // 3 уже было, +1 текущий = 4
    const families = [family, family, family]
    expect(__test.isStuckLoop(recent, fp, families, family)).toBe(true)
  })

  it('detects similarity loop with different paths in same directory', () => {
    const family = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'ls /workspace' } })
    // 6 похожих вызовов (с разными путями в /workspace/*)
    const families = [
      family, family, family, family, family, family,
    ]
    expect(__test.isStuckLoop(['a', 'b', 'c', 'd', 'e', 'f'], 'g', families, family)).toBe(true)
  })

  it('groups paths in same directory as same family', () => {
    const family1 = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'ls /workspace/foo' } })
    const family2 = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'ls /workspace/bar' } })
    const family3 = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'ls /workspace/baz' } })
    // Все три — одна семья (одинаковый корень пути)
    expect(family1).toBe(family2)
    expect(family2).toBe(family3)
  })

  it('does NOT group different roots', () => {
    const family1 = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'ls /workspace/foo' } })
    const family2 = __test.callFamily({ tool: 'shell', args: { action: 'run', command: 'ls /home/foo' } })
    expect(family1).not.toBe(family2)
  })

  it('does NOT flag legitimate file re-reads (1-2 times)', () => {
    const fp = __test.callFingerprint({ tool: 'file', args: { action: 'read', path: 'foo.py' } })
    const family = __test.callFamily({ tool: 'file', args: { action: 'read', path: 'foo.py' } })
    // 2 подряд — нормально (перечитывание после правки)
    expect(__test.isStuckLoop([fp, fp], fp, [family, family], family)).toBe(false)
  })
})
