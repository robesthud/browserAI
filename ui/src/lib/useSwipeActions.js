import { useEffect, useRef, useState } from 'react'

/**
 * Swipe actions were originally mobile-first, but in practice they can fight
 * with native vertical scrolling inside long chats on some Android/iOS
 * browsers/WebViews. BrowserAI's minimalist mobile UI now exposes explicit
 * copy/edit actions directly, so preserving reliable touch scrolling takes
 * priority over hidden swipe affordances.
 *
 * Therefore:
 * - coarse pointer devices => swipe gestures disabled, native scroll wins
 * - fine pointer / desktop => no touch handlers anyway
 */
const MAX = 110

export default function useSwipeActions() {
  const ref = useRef(null)
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (window.matchMedia?.('(pointer: coarse)').matches) return undefined
    return undefined
  }, [])

  const reset = () => { setOffset(0); setOpen(false) }

  return { bind: { ref }, offset, open, reset, maxOffset: MAX }
}
