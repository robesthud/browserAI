// Bug 5.2 — per-chat streaming state (orphaned stream on chat switch).
import { describe, it, expect } from 'vitest'
import { toggleStreaming, isActiveStreaming } from './streamingState.js'

describe('toggleStreaming', () => {
  it('adds and removes a chat id immutably', () => {
    const s0 = new Set()
    const s1 = toggleStreaming(s0, 'A', true)
    expect(s1.has('A')).toBe(true)
    expect(s0.has('A')).toBe(false) // original untouched
    const s2 = toggleStreaming(s1, 'A', false)
    expect(s2.has('A')).toBe(false)
  })

  it('ignores empty chatId', () => {
    const s = toggleStreaming(new Set(['A']), '', true)
    expect([...s]).toEqual(['A'])
  })

  it('tracks multiple concurrent chats', () => {
    let s = new Set()
    s = toggleStreaming(s, 'A', true)
    s = toggleStreaming(s, 'B', true)
    expect(s.has('A') && s.has('B')).toBe(true)
  })
})

describe('isActiveStreaming (Bug 5.2 scenarios)', () => {
  it('active chat streaming -> true', () => {
    expect(isActiveStreaming(new Set(['A']), 'A')).toBe(true)
  })

  it('switch to a NON-streaming chat while another streams -> false', () => {
    // Stream running in A, user switches to B: composer for B must NOT look busy.
    const streaming = new Set(['A'])
    expect(isActiveStreaming(streaming, 'B')).toBe(false)
  })

  it('chat A finishing does not affect B indicator', () => {
    // While viewing B, A finishes (removed from set): B still not streaming.
    let streaming = new Set(['A'])
    streaming = toggleStreaming(streaming, 'A', false)
    expect(isActiveStreaming(streaming, 'B')).toBe(false)
  })

  it('B starts streaming while viewing B -> true, independent of A', () => {
    let streaming = new Set(['A'])
    streaming = toggleStreaming(streaming, 'B', true)
    expect(isActiveStreaming(streaming, 'B')).toBe(true)
    expect(isActiveStreaming(streaming, 'A')).toBe(true)
  })

  it('falls back to global flag when there is no active chat yet', () => {
    expect(isActiveStreaming(new Set(), null, true)).toBe(true)
    expect(isActiveStreaming(new Set(), null, false)).toBe(false)
  })
})
