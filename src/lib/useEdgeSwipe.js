import { useEffect } from 'react'

/**
 * iOS-style edge-swipe gesture. Listens at the document level for
 * touchstart events in the EDGE pixels from `side` ('left' or 'right'),
 * then watches the drag distance. If the user crosses MIN_DISTANCE
 * within MAX_DURATION_MS, fires onTrigger().
 *
 * No-op on desktop (no touch events). Designed to coexist with the
 * pull-to-refresh hook because that one only engages when scrollTop===0
 * and within the scroll container; this one looks at horizontal drags
 * from the screen edge.
 */
const EDGE = 24            // px from screen edge to engage
const MIN_DISTANCE = 50    // px horizontal travel needed
const MAX_DURATION_MS = 700
const SLOPE_RATIO = 1.5    // |dx| must exceed |dy| * ratio to count as horizontal

export default function useEdgeSwipe({ side = 'left', enabled = true, onTrigger }) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof onTrigger !== 'function') return undefined
    // Native touch scrolling must win on mobile/coarse devices. Edge-swipe
    // navigation is nice-to-have, but not at the cost of broken touch UX.
    if (window.matchMedia?.('(pointer: coarse)').matches) return undefined

    let startX = 0
    let startY = 0
    let startT = 0
    let armed = false

    const onStart = (e) => {
      const t = e.touches[0]
      if (!t) return
      if (side === 'left' && t.clientX > EDGE) return
      if (side === 'right' && t.clientX < window.innerWidth - EDGE) return
      startX = t.clientX
      startY = t.clientY
      startT = Date.now()
      armed = true
    }
    const onMove = (e) => {
      if (!armed) return
      const t = e.touches[0]
      if (!t) return
      const dx = t.clientX - startX
      const dy = Math.abs(t.clientY - startY)
      // Drift too vertical -> cancel so we don't fight the scroll
      if (Math.abs(dx) < dy * SLOPE_RATIO) {
        armed = false
        return
      }
      const horizontal = side === 'left' ? dx : -dx
      const elapsed = Date.now() - startT
      if (horizontal >= MIN_DISTANCE && elapsed <= MAX_DURATION_MS) {
        armed = false
        onTrigger()
      } else if (elapsed > MAX_DURATION_MS) {
        armed = false
      }
    }
    const onEnd = () => { armed = false }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [side, enabled, onTrigger])
}
