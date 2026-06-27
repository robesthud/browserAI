import { useEffect, useState } from 'react'
import { subscribePush, unsubscribePush } from '../lib/pwa.js'

/**
 * Tiny push-notifications toggle for the sidebar. Three states:
 *   - 'unsupported' → no SW / PushManager → hide entirely
 *   - 'off'         → 🔕, click subscribes
 *   - 'on'          → 🔔, click unsubscribes
 *   - 'busy'        → spinner
 * Test button only shown when 'on'.
 */
export default function PushToggle() {
  const supported = typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window

  const [state, setState] = useState('off')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!supported) { setState('unsupported'); return }
    if (Notification.permission === 'denied') { setState('blocked'); return }
    ;(async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        setState(sub ? 'on' : 'off')
      } catch { setState('off') }
    })()
  }, [supported])

  if (!supported || state === 'unsupported') return null

  const click = async () => {
    setErr('')
    if (state === 'busy') return
    setState('busy')
    try {
      if (state === 'on') {
        await unsubscribePush()
        setState('off')
      } else {
        await subscribePush()
        setState('on')
      }
    } catch (e) {
      setErr(e?.message || 'не удалось')
      setState(Notification.permission === 'denied' ? 'blocked' : 'off')
    }
  }

  const sendTest = async () => {
    try {
      const r = await fetch('/api/push/test', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Привет из BrowserAI 👋' }),
      })
      if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`))
    } catch (e) { setErr(e.message) }
  }

  return (
    <div className="my-2 flex items-center gap-1.5 rounded-lg border border-white/10 bg-graphite-900/40 px-2 py-1.5 text-[12px] text-cream-soft">
      <button
        type="button"
        onClick={click}
        className="flex flex-1 items-center gap-1.5 text-left hover:text-cream"
        title={state === 'blocked' ? 'Уведомления заблокированы в настройках браузера' : ''}
      >
        <span className="shrink-0">{state === 'on' ? '🔔' : '🔕'}</span>
        <span className="truncate">
          {state === 'on' ? 'Push: вкл' : state === 'blocked' ? 'Push: заблокирован' : state === 'busy' ? 'Push: …' : 'Push: выкл'}
        </span>
      </button>
      {state === 'on' && (
        <button
          type="button"
          onClick={sendTest}
          className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-cream-faint hover:bg-white/5"
          title="Отправить тестовый push"
        >test</button>
      )}
      {err && <span className="ml-auto text-[10px] text-rose-300" title={err}>!</span>}
    </div>
  )
}
