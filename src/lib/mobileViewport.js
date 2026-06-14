// Mobile viewport hardening for iPhone/iOS and Android browsers.
// Goal: make BrowserAI behave like a native full-height chat app:
// - no pinch/double-tap zoom;
// - correct dynamic viewport when Safari toolbars/keyboard appear;
// - CSS variables for safe-area and keyboard-aware layouts.

function setAppViewportVars() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const root = document.documentElement
  const vv = window.visualViewport
  const height = vv?.height || window.innerHeight || root.clientHeight || 0
  const width = vv?.width || window.innerWidth || root.clientWidth || 0
  const offsetTop = vv?.offsetTop || 0
  const keyboardHeight = Math.max(0, (window.innerHeight || height) - height - offsetTop)
  if (height) root.style.setProperty('--app-height', `${height}px`)
  if (width) root.style.setProperty('--app-width', `${width}px`)
  root.style.setProperty('--keyboard-height', `${keyboardHeight}px`)
}

function preventPinchZoom() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const prevent = (e) => { try { e.preventDefault() } catch { /* ignore */ } }
  const preventMultiTouch = (e) => {
    if (e.touches && e.touches.length > 1) prevent(e)
  }
  let lastTouchEnd = 0
  const preventDoubleTapZoom = (e) => {
    const now = Date.now()
    if (now - lastTouchEnd <= 300) prevent(e)
    lastTouchEnd = now
  }
  const preventCtrlWheelZoom = (e) => { if (e.ctrlKey) prevent(e) }

  // Safari-specific gesture events.
  document.addEventListener('gesturestart', prevent, { passive: false })
  document.addEventListener('gesturechange', prevent, { passive: false })
  document.addEventListener('gestureend', prevent, { passive: false })

  // Cross-browser multi-touch / double-tap zoom prevention.
  document.addEventListener('touchmove', preventMultiTouch, { passive: false })
  document.addEventListener('touchend', preventDoubleTapZoom, { passive: false })
  document.addEventListener('wheel', preventCtrlWheelZoom, { passive: false })

  return () => {
    document.removeEventListener('gesturestart', prevent)
    document.removeEventListener('gesturechange', prevent)
    document.removeEventListener('gestureend', prevent)
    document.removeEventListener('touchmove', preventMultiTouch)
    document.removeEventListener('touchend', preventDoubleTapZoom)
    document.removeEventListener('wheel', preventCtrlWheelZoom)
  }
}

export function setupMobileViewport() {
  if (typeof window === 'undefined') return () => {}
  setAppViewportVars()
  const onResize = () => setAppViewportVars()
  const vv = window.visualViewport
  window.addEventListener('resize', onResize, { passive: true })
  window.addEventListener('orientationchange', onResize, { passive: true })
  vv?.addEventListener?.('resize', onResize, { passive: true })
  vv?.addEventListener?.('scroll', onResize, { passive: true })
  const cleanupPinch = preventPinchZoom()
  return () => {
    window.removeEventListener('resize', onResize)
    window.removeEventListener('orientationchange', onResize)
    vv?.removeEventListener?.('resize', onResize)
    vv?.removeEventListener?.('scroll', onResize)
    cleanupPinch?.()
  }
}

export default setupMobileViewport
