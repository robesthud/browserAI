import { useEffect, useState } from 'react'
import haptics from '../lib/haptics.js'

/**
 * Compact UI preferences strip shown at the bottom of the Sidebar:
 *   - Theme toggle (dark / light)
 *   - Font size (A− / A+)
 *   - Haptics toggle (on / off)
 *
 * All settings live in localStorage and are applied imperatively to
 * the <html> element so they survive route changes without any
 * context plumbing.
 */
const THEME_KEY = 'browserai.theme'
const FONT_KEY  = 'browserai.fontSize'
const MIN_FZ = 13
const MAX_FZ = 20
const DEFAULT_FZ = 16

function applyTheme(theme) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('theme-light', theme === 'light')
}

function applyFontSize(px) {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--browserai-base-fz', `${px}px`)
}

export default function SidebarUserPrefs() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark' } catch { return 'dark' }
  })
  const [fz, setFz] = useState(() => {
    try {
      const v = Number(localStorage.getItem(FONT_KEY))
      return Number.isFinite(v) && v >= MIN_FZ && v <= MAX_FZ ? v : DEFAULT_FZ
    } catch { return DEFAULT_FZ }
  })
  const [hapticOn, setHapticOn] = useState(() => haptics.isEnabled())

  // Apply preferences on mount and whenever they change
  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode / quota */ }
  }, [theme])
  useEffect(() => {
    applyFontSize(fz)
    try { localStorage.setItem(FONT_KEY, String(fz)) } catch { /* private mode / quota */ }
  }, [fz])
  useEffect(() => {
    haptics.setEnabled(hapticOn)
  }, [hapticOn])

  const dec = () => setFz((v) => Math.max(MIN_FZ, v - 1))
  const inc = () => setFz((v) => Math.min(MAX_FZ, v + 1))
  const reset = () => setFz(DEFAULT_FZ)

  return (
    <div className="flex items-center justify-between gap-2 border-t border-white/5 px-2.5 py-2 text-cream-soft">
      {/* Theme */}
      <button
        type="button"
        onClick={() => { setTheme((t) => t === 'dark' ? 'light' : 'dark'); haptics.tap() }}
        className="grid h-8 w-8 place-items-center rounded-lg hover:bg-graphite-750 hover:text-cream"
        title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
      >
        <span className="text-base leading-none">{theme === 'dark' ? '☀️' : '🌙'}</span>
      </button>

      {/* Font size */}
      <div className="flex items-center gap-0.5 rounded-lg border border-white/5">
        <button
          type="button"
          onClick={dec}
          disabled={fz <= MIN_FZ}
          className="grid h-7 w-7 place-items-center text-[12px] hover:bg-graphite-750 hover:text-cream disabled:opacity-30"
          title="Меньше шрифт"
        >A−</button>
        <button
          type="button"
          onClick={reset}
          className="grid h-7 min-w-[28px] place-items-center px-1 text-[10px] text-cream-faint hover:text-cream"
          title="Сбросить"
        >{fz}</button>
        <button
          type="button"
          onClick={inc}
          disabled={fz >= MAX_FZ}
          className="grid h-7 w-7 place-items-center text-[14px] hover:bg-graphite-750 hover:text-cream disabled:opacity-30"
          title="Больше шрифт"
        >A+</button>
      </div>

      {/* Haptics */}
      <button
        type="button"
        onClick={() => { setHapticOn((v) => !v); haptics.tap() }}
        className={`grid h-8 w-8 place-items-center rounded-lg transition-colors ${
          hapticOn ? 'text-cream hover:bg-graphite-750' : 'text-cream-faint hover:bg-graphite-750'
        }`}
        title={hapticOn ? 'Вибрация: вкл' : 'Вибрация: выкл'}
      >
        <span className="text-base leading-none">{hapticOn ? '📳' : '📴'}</span>
      </button>
    </div>
  )
}
