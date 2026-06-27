import { useCallback, useEffect, useState } from 'react'

const card = 'rounded-2xl border border-white/10 bg-graphite-800/60 p-5 shadow-lg'
const input = 'w-full rounded-lg border border-white/10 bg-graphite-900 px-3 py-2 text-cream placeholder:text-cream-faint focus:border-amber-400/40 focus:outline-none'
const btn = 'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition'
const btnPrimary = `${btn} bg-amber-400 text-graphite-900 hover:bg-amber-300`
const btnGhost = `${btn} border border-white/15 text-cream-soft hover:border-white/30 hover:text-cream`

function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 py-2 text-sm last:border-b-0">
      <span className="text-cream-faint">{label}</span>
      <span className={`text-right ${mono ? 'font-mono text-[12px]' : ''} text-cream`}>{value ?? '—'}</span>
    </div>
  )
}

function StatusPill({ alive }) {
  if (alive === null || alive === undefined) {
    return <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-cream-faint">неизвестно</span>
  }
  if (alive) {
    return <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300">активна</span>
  }
  return <span className="rounded-full bg-rose-500/15 px-3 py-1 text-xs text-rose-300">истекла / нет</span>
}

export default function DeepSeekAdmin() {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [userToken, setUserToken] = useState('')
  const [cookies, setCookies] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetch('/api/admin/deepseek/status', { credentials: 'include' })
      if (r.status === 401) {
        setError('Не авторизован. Войдите в аккаунт.')
        setState(null)
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setState(await r.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Intentional setState in effect: one-shot fetch + polling timer
    // for the admin dashboard. The eslint rule warns about cascading
    // renders but in this case the cascade is exactly what we want
    // (server state -> React state).
     
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  async function doRefresh() {
    setBusy(true); setMsg(''); setError('')
    try {
      const r = await fetch('/api/admin/deepseek/refresh', { method: 'POST', credentials: 'include' })
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setState(data.state)
      setMsg('Обновлено.')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function doSave() {
    if (!userToken.trim() && !cookies.trim()) {
      setError('Введите userToken и/или Cookie')
      return
    }
    setBusy(true); setMsg(''); setError('')
    try {
      const r = await fetch('/api/admin/deepseek/token', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: userToken.trim(),
          cookies: cookies.trim() || null,
        }),
      })
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setState(data.state)
      setUserToken('')
      setCookies('')
      setMsg('Сессия сохранена. Heartbeat выполнен.')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-graphite-900 px-6 py-10 text-cream">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">DeepSeek — серверная сессия</h1>
          <p className="mt-1 text-sm text-cream-faint">
            Управление managed-токеном <code className="font-mono text-[12px]">chat.deepseek.com</code>.
            Heartbeat каждые 10 мин, обновление моделей каждый час.
          </p>
        </div>
        <a className={btnGhost} href="/">← В чат</a>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}
      {msg && (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {msg}
        </div>
      )}

      <section className={`${card} mb-6`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">Статус</h2>
          <div className="flex items-center gap-3">
            <StatusPill alive={state?.alive} />
            <button className={btnGhost} onClick={load} disabled={loading}>
              {loading ? 'Загрузка…' : 'Обновить'}
            </button>
            <button className={btnPrimary} onClick={doRefresh} disabled={busy}>
              {busy ? '…' : 'Force refresh'}
            </button>
          </div>
        </div>

        <Row label="Bearer токен" value={state?.hasToken ? '✓ задан' : '— отсутствует'} />
        <Row label="Cookies" value={state?.hasCookies ? state.cookieNames.join(', ') : '— нет'} mono={state?.hasCookies} />
        <Row label="Истекает" value={state?.expiresAt ? `${state.expiresAt} (${state.expiresInSec ? Math.round(state.expiresInSec / 60) + ' мин' : '?'})` : 'неизвестно'} />
        <Row label="Последний heartbeat" value={state?.lastSeenAt} />
        <Row label="Последнее обновление" value={state?.lastRefreshAt} />
        <Row label="Пользователь" value={state?.user ? (state.user.email || state.user.name || state.user.id) : '—'} />
        <Row label="Моделей в кэше" value={state?.models?.length ?? 0} />
        <Row label="Источник последнего обновления" value={state?.updatedBy || '—'} mono />
        {state?.lastError ? <Row label="Последняя ошибка" value={state.lastError} mono /> : null}
      </section>

      <section className={`${card} mb-6`}>
        <h2 className="mb-3 text-lg font-medium">Обновить токен и/или cookies</h2>
        <p className="mb-4 text-xs text-cream-faint">
          Возьми из DevTools на <code>chat.deepseek.com</code>: Application → Local Storage → ключ
          <code> userToken</code> (полный JWT); и Application → Cookies → строка вида
          <code> cf_clearance=...; ds_session_id=...; smidV2=...</code>
        </p>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[13px] text-cream-soft">userToken (Bearer JWT)</span>
            <input
              className={`${input} font-mono text-[12px]`}
              type="password"
              autoComplete="off"
              value={userToken}
              onChange={(e) => setUserToken(e.target.value)}
              placeholder="eyJhbGciOi..."
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] text-cream-soft">Cookies</span>
            <textarea
              className={`${input} h-24 font-mono text-[12px]`}
              autoComplete="off"
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              placeholder="cf_clearance=...; ds_session_id=...; smidV2=..."
            />
          </label>
          <div className="flex justify-end gap-3">
            <button className={btnGhost} onClick={() => { setUserToken(''); setCookies(''); setError(''); setMsg('') }}>
              Очистить
            </button>
            <button className={btnPrimary} onClick={doSave} disabled={busy}>
              {busy ? 'Сохранение…' : 'Сохранить и проверить'}
            </button>
          </div>
        </div>
      </section>

      {state?.models?.length ? (
        <section className={card}>
          <h2 className="mb-3 text-lg font-medium">Кэш моделей</h2>
          <ul className="space-y-1 text-sm">
            {state.models.map((m) => (
              <li key={m.id} className="flex items-center justify-between border-b border-white/5 py-1 last:border-b-0">
                <span className="font-mono text-[12px] text-cream">{m.id}</span>
                <span className="text-cream-faint">{m.name}</span>
              </li>
            ))}
          </ul>
          {state.modelsFetchedAt && (
            <p className="mt-2 text-[11px] text-cream-faint">обновлено: {state.modelsFetchedAt}</p>
          )}
        </section>
      ) : null}
    </div>
  )
}
