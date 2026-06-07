import { useEffect, useRef, useState } from 'react'

/**
 * Lightweight horizontal swipe handler for a message row.
 *
 * Returns:
 *   bind  : { ref }              — attach to the swiped element
 *   offset: number               — current x-translate (0..MAX)
 *   open  : boolean              — true when the swipe revealed the actions panel
 *   reset : () => void           — close the panel programmatically
 *
 * Behaviour:
 *   - Only horizontal drags trigger (slope check vs. vertical scroll)
 *   - Negative offsets only (swipe-left)
 *   - Snaps open if released past THRESHOLD, otherwise snaps closed
 */
const THRESHOLD = 40
const MAX = 110
const SLOPE_RATIO = 1.3

export default function useSwipeActions() {
  const ref = useRef(null)
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState(false)
  const stateRef = useRef({ startX: 0, startY: 0, dragging: false })

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined

    const onStart = (e) => {
      const t = e.touches[0]
      if (!t) return
      stateRef.current.startX = t.clientX
      stateRef.current.startY = t.clientY
      stateRef.current.dragging = false
    }
    const onMove = (e) => {
      const t = e.touches[0]
      if (!t) return
      const dx = t.clientX - stateRef.current.startX
      const dy = Math.abs(t.clientY - stateRef.current.startY)
      // Decide once: if mostly horizontal, hijack. Otherwise let the page scroll.
      if (!stateRef.current.dragging) {
        if (Math.abs(dx) < 8) return
        if (Math.abs(dx) < dy * SLOPE_RATIO) return
        stateRef.current.dragging = true
      }
      // Allow swipe-left only (or right-back-to-zero if already open)
      const adjusted = open ? Math.min(0, dx - MAX) : Math.min(0, dx)
      const clamped = Math.max(-MAX, adjusted)
      setOffset(clamped)
      e.preventDefault()
    }
    const onEnd = () => {
      if (!stateRef.current.dragging) return
      stateRef.current.dragging = false
      if (Math.abs(offset) >= THRESHOLD) {
        setOffset(-MAX)
        setOpen(true)
      } else {
        setOffset(0)
        setOpen(false)
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [offset, open])

  const reset = () => { setOffset(0); setOpen(false) }

  return { bind: { ref }, offset, open, reset, maxOffset: MAX }
}
