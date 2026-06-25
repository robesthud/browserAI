// Тесты для finalClaimValidator — антигаллюцинатор
import { describe, expect, it } from 'vitest'

import { validateFinalClaims } from './finalClaimValidator.js'

describe('finalClaimValidator', () => {
  it('passes when text matches tool history', () => {
    const result = validateFinalClaims(
      'Файл hello.py создан. Всё готово.',
      {
        touchedFiles: new Set(['hello.py']),
        recentToolHistory: [
          { tool: 'file', ok: true, args: '{"action":"write","path":"hello.py"}', outcome: '120 bytes' },
        ],
      }
    )
    expect(result.issues).toEqual([])
    expect(result.verified).toBe(true)
  })

  it('flags citedFileMissing when path is not in history', () => {
    const result = validateFinalClaims(
      'Файл magic.py создан успешно.',
      {
        touchedFiles: new Set(['hello.py']),
        recentToolHistory: [
          { tool: 'file', ok: true, args: '{"action":"write","path":"hello.py"}', outcome: '120 bytes' },
        ],
      }
    )
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0].type).toBe('citedFileMissing')
  })

  it('flags claimedSuccessButNoRealWork', () => {
    const result = validateFinalClaims(
      'Всё успешно сделано. Готово.',
      {
        touchedFiles: new Set(),
        recentToolHistory: [
          { tool: 'list_files', ok: true, args: '{}', outcome: 'empty' },
        ],
      }
    )
    const errs = result.issues.filter((i) => i.severity === 'error')
    expect(errs.length).toBeGreaterThan(0)
    expect(result.verified).toBe(false)
  })

  it('flags claimedSuccessForFailedTool', () => {
    const result = validateFinalClaims(
      'Я успешно выполнил git clone репозитория.',
      {
        touchedFiles: new Set(),
        recentToolHistory: [
          { tool: 'git_clone', ok: false, args: '{}', outcome: 'permission denied exit=23' },
        ],
      }
    )
    const errs = result.issues.filter((i) => i.severity === 'error')
    expect(errs.length).toBeGreaterThan(0)
    expect(result.issues.some((i) => i.type === 'claimedSuccessForFailedTool')).toBe(true)
  })

  it('flags claimedCommitButNoGitCommit', () => {
    const result = validateFinalClaims(
      'SHA коммита: `abc1234 test commit`',
      {
        touchedFiles: new Set(),
        recentToolHistory: [
          { tool: 'git', ok: true, args: '{"action":"clone"}', outcome: 'cloned' },
        ],
      }
    )
    expect(result.issues.some((i) => i.type === 'claimedCommitButNoGitCommit')).toBe(true)
  })

  it('passes when git commit is proven by a successful shell command', () => {
    const result = validateFinalClaims(
      'Коммит создан: `abc1234 initial commit`.',
      {
        touchedFiles: new Set(),
        recentToolHistory: [
          { tool: 'shell', ok: true, args: '{"action":"run","command":"git add . && git commit -m init"}', semantic: { command: 'git add . && git commit -m init' }, outcome: 'exit=0 [main abc1234] initial commit' },
        ],
      }
    )
    expect(result.issues.some((i) => i.type === 'claimedCommitButNoGitCommit')).toBe(false)
  })

  it('passes for honest failure report', () => {
    const result = validateFinalClaims(
      'Не удалось склонировать — permission denied. Нужны права sudo.',
      {
        touchedFiles: new Set(),
        recentToolHistory: [
          { tool: 'shell', ok: false, args: '{"action":"run","command":"git clone"}', outcome: 'permission denied exit=1' },
        ],
      }
    )
    expect(result.issues.filter((i) => i.severity === 'error').length).toBe(0)
  })
})
