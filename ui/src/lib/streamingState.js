// Bug 5.2 — per-chat streaming state helpers.
//
// The bug: `isStreaming` was a single global boolean. A stream running in
// chat A made chat B's composer look busy after switching to B, and A
// finishing wrongly cleared B's indicator. These pure helpers model the
// per-chat set so the behavior is unit-testable in isolation from the hook.

/** Return a new Set with `chatId` added (on=true) or removed (on=false). */
export function toggleStreaming(set, chatId, on) {
  const next = new Set(set)
  if (!chatId) return next
  if (on) next.add(chatId)
  else next.delete(chatId)
  return next
}

/**
 * Is the CURRENTLY ACTIVE chat streaming?
 * Falls back to the global flag for chatless streams (no activeId yet).
 */
export function isActiveStreaming(streamingChatIds, activeId, globalFlag = false) {
  if (activeId && streamingChatIds.has(activeId)) return true
  return Boolean(globalFlag)
}
