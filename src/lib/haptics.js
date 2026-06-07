/**
 * Thin wrappers around navigator.vibrate. No-op on iOS Safari and other
 * platforms that don't expose the Vibration API. Respect the user's
 * preference stored in localStorage under 'browserai.haptics' ('on'|'off').
 *
 * Patterns are intentionally short so they read as feedback rather than
 * a notification.
 */
const STORAGE_KEY = 'browserai.haptics'

function enabled() {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
    const pref = localStorage.getItem(STORAGE_KEY)
    // Default: enabled. Explicit 'off' disables.
    return pref !== 'off'
  } catch { return false }
}

function vibrate(pattern) {
  if (!enabled()) return
  try { navigator.vibrate(pattern) } catch { /* ignore */ }
}

// Public API
export const haptics = {
  tap:       () => vibrate(15),
  success:   () => vibrate(50),
  warning:   () => vibrate([30, 50, 30]),
  error:     () => vibrate([60, 80, 60]),
  isEnabled: () => enabled(),
  setEnabled(value) {
    try { localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off') } catch {}
  },
}

export default haptics
