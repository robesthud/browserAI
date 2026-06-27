// Mobile viewport hardening for iPhone/iOS and Android browsers.
// Goal: make BrowserAI behave like a native full-height chat app:
// - keeps browser zoom available for accessibility;
// - correct dynamic viewport when Safari toolbars/keyboard appear;
// - prevent iOS from scrolling the whole app upward when focusing composer;
// - CSS variables for safe-area and keyboard-aware layouts.

function isEditable(el) {
  if (!el) return false
  const tag = String(el.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function lockPageScroll() {
  try {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  } catch { /* ignore */ }
}

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
  root.style.setProperty('--app-top', `${offsetTop}px`)
  root.style.setProperty('--vv-offset-top', `${offsetTop}px`)
  root.style.setProperty('--keyboard-height', `${keyboardHeight}px`)
  root.classList.toggle('keyboard-open', keyboardHeight > 80 || isEditable(document.activeElement))
}


function setupKeyboardStability() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  let focusTimer = 0
  const stabilize = () => {
    setAppViewportVars()
    lockPageScroll()
    clearTimeout(focusTimer)
    focusTimer = setTimeout(() => {
      setAppViewportVars()
      lockPageScroll()
    }, 80)
  }
  const onFocusIn = (e) => {
    if (!isEditable(e.target)) return
    document.documentElement.classList.add('keyboard-open')
    stabilize()
    setTimeout(stabilize, 280)
  }
  const onFocusOut = () => {
    clearTimeout(focusTimer)
    focusTimer = setTimeout(() => {
      setAppViewportVars()
      if (!isEditable(document.activeElement)) document.documentElement.classList.remove('keyboard-open')
      lockPageScroll()
    }, 180)
  }
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  return () => {
    clearTimeout(focusTimer)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
  }
}

export function setupMobileViewport() {
  if (typeof window === 'undefined') return () => {}
  setAppViewportVars()
  const onResize = () => {
    setAppViewportVars()
    if (isEditable(document.activeElement)) lockPageScroll()
  }
  const vv = window.visualViewport
  window.addEventListener('resize', onResize, { passive: true })
  window.addEventListener('orientationchange', onResize, { passive: true })
  vv?.addEventListener?.('resize', onResize, { passive: true })
  vv?.addEventListener?.('scroll', onResize, { passive: true })
  const cleanupKeyboard = setupKeyboardStability()
  return () => {
    window.removeEventListener('resize', onResize)
    window.removeEventListener('orientationchange', onResize)
    vv?.removeEventListener?.('resize', onResize)
    vv?.removeEventListener?.('scroll', onResize)
    cleanupKeyboard?.()
  }
}

export default setupMobileViewport
