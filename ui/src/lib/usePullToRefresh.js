import { useEffect, useRef, useState } from 'react'

/**
 * Mobile pull-to-refresh primitive.
 *
 * Returns:
 *   - pullDistance: number    (0..THRESHOLD+) — used by the caller to render
 *                              a visual indicator at the top
 *   - refreshing: boolean     true while onRefresh() is running
 *
 * Behaviour:
 *   - active only when document.documentElement.scrollTop is 0 AND the
 *     touch starts there (avoids hijacking mid-scroll pulls)
 *   - drag distance is multiplied by 0.5 for that natural rubber-band feel
 *   - triggers onRefresh() when crossing THRESHOLD on release
 *   - automatically disabled on desktop pointer events
 */
const THRESHOLD = 70
const MAX_PULL  = 110

export default function usePullToRefresh(scrollRef, onRefresh) {
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startYRef = useRef(0)
  const activeRef = useRef(false)

  useEffect(() => {
    const el = scrollRef?.current
    if (!el || typeof window === 'undefined') return undefined

    const onTouchStart = (e) => {
      if (refreshing) return
      // Only engage when already at the very top
      if (el.scrollTop > 0) return
      startYRef.current = e.touches[0].clientY
      activeRef.current = true
    }

    const onTouchMove = (e) => {
      if (!activeRef.current || refreshing) return
      const dy = e.touches[0].clientY - startYRef.current
      if (dy <= 0) {
        setPullDistance(0)
        return
      }
      // Rubber-band scaling
      const distance = Math.min(MAX_PULL, dy * 0.5)
      setPullDistance(distance)
      // Prevent the page from also scrolling
      if (distance > 5) e.preventDefault()
    }

    const onTouchEnd = async () => {
      if (!activeRef.current) return
      activeRef.current = false
      const distance = pullDistance
      setPullDistance(0)
      if (distance >= THRESHOLD && onRefresh) {
        setRefreshing(true)
        try {
          await onRefresh()
        } finally {
          setRefreshing(false)
        }
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    // touchmove must be non-passive so we can preventDefault
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [scrollRef, onRefresh, refreshing, pullDistance])

  return { pullDistance, refreshing, threshold: THRESHOLD }
}
