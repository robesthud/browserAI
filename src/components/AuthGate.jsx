import { useEffect, useMemo, useState } from 'react'
import { backend } from '../lib/backend.js'

const SETTINGS_KEY = 'browserai.settings.v2'
const CHATS_KEY = 'browserai.chats.v1'
const AUTH_FLAG = 'browserai.auth.enabled'

function writeCloudToLocal(data) {
  if (!data) return
  if (data.settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings))
  if (Array.isArray(data.chats)) localStorage.setItem(CHATS_KEY, JSON.stringify(data.chats))
}

function AuthPanel({ onAuthenticated }) {
  const resetToken = useMemo(() => new URLSearchParams(window.location.search).get('reset_token') || '', [])
  const [mode, setMode] = useState(resetToken ? 'reset' : 'login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [registrationSecret, setRegistrationSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (mode === 'login') {
        await backend.authLogin({ email, password })
        await onAuthenticated()
        return
      }
      if (mode === 'register') {
        await backend.authRegister({ email, name, password, registrationSecret })
        await onAuthenticated()
        return
      }
      if (mode === 'forgot') {
        await backend.authForgotPassword(email)
        setMessage('Если email зарегистрирован и SMTP настроен, ссылка восстановления отправлена.')
        return
      }
      if (mode === 'reset') {
        await backend.authResetPassword(resetToken, password)
        setMessage('Пароль изменён. Теперь войдите с новым паролем.')
        window.history.replaceState({}, '', window.location.pathname)
        setMode('login')
        setPassword('')
      }
    } catch (e) {
      setError(e.message || 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-graphite-900 px-4 py-8 text-cream">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-graphite-800 p-6 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-3xl font-semibold">BrowserAI</div>
          <div className="mt-2 text-sm text-cream-faint">
            Войдите, чтобы синхронизировать ключи, настройки и чаты между Android и компьютером.
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === 'register' && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Имя"
              className="w-full rounded-xl border border-white/10 bg-graphite-900 px-4 py-3 text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
            />
          )}

          {mode !== 'reset' && (
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="w-full rounded-xl border border-white/10 bg-graphite-900 px-4 py-3 text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
            />
          )}

          {mode !== 'forgot' && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'reset' ? 'Новый пароль' : 'Пароль'}
              required
              minLength={8}
              className="w-full rounded-xl border border-white/10 bg-graphite-900 px-4 py-3 text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
            />
          )}

          {mode === 'register' && (
            <input
              type="password"
              value={registrationSecret}
              onChange={(e) => setRegistrationSecret(e.target.value)}
              placeholder="Секрет регистрации (нужен после первого пользователя)"
              className="w-full rounded-xl border border-white/10 bg-graphite-900 px-4 py-3 text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none"
            />
          )}

          {error && <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}
          {message && <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{message}</div>}

          <button
            disabled={busy}
            className="w-full rounded-xl bg-cream px-4 py-3 font-medium text-graphite-900 transition-opacity disabled:opacity-60"
          >
            {busy
              ? 'Подождите…'
              : mode === 'login'
                ? 'Войти'
                : mode === 'register'
                  ? 'Зарегистрироваться'
                  : mode === 'forgot'
                    ? 'Отправить ссылку'
                    : 'Сменить пароль'}
          </button>
        </form>

        <div className="mt-5 flex flex-wrap justify-center gap-3 text-sm text-cream-dim">
          {mode !== 'login' && <button onClick={() => setMode('login')} className="hover:text-cream">Войти</button>}
          {mode !== 'register' && <button onClick={() => setMode('register')} className="hover:text-cream">Регистрация</button>}
          {mode !== 'forgot' && <button onClick={() => setMode('forgot')} className="hover:text-cream">Забыли пароль?</button>}
        </div>
      </div>
    </div>
  )
}

export default function AuthGate({ children }) {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState(null)
  const [renderKey, setRenderKey] = useState(0)

  const loadSession = async () => {
    setLoading(true)
    try {
      const me = await backend.authMe()
      if (me.user) {
        localStorage.setItem(AUTH_FLAG, '1')
        const cloud = await backend.getCloud().catch(() => ({ data: null }))
        writeCloudToLocal(cloud.data)
        setUser(me.user)
        setRenderKey((v) => v + 1)
      } else {
        localStorage.removeItem(AUTH_FLAG)
        setUser(null)
      }
    } catch {
      localStorage.removeItem(AUTH_FLAG)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSession()
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-graphite-900 text-cream">
        <div className="text-sm text-cream-dim">Загрузка BrowserAI…</div>
      </div>
    )
  }

  if (!user) return <AuthPanel onAuthenticated={loadSession} />

  return children({ user, reloadAuth: loadSession, renderKey })
}
