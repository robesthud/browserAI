import { useEffect, useMemo, useState } from 'react'
import { backend } from '../lib/backend.js'

const SETTINGS_KEY = 'browserai.settings.v2'
const CHATS_KEY = 'browserai.chats.v1'
const AUTH_FLAG = 'browserai.auth.enabled'

function writeCloudToLocal(data) {
  if (!data) return
  // Восстанавливаем настройки пользователя (системный промпт, температура и т.д.)
  // Ключи API приходят отдельно через /api/settings и не хранятся в cloud напрямую
  if (data.settings) {
    try {
      const existing = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
      // Мержим: параметры генерации из cloud, но не затираем ключи если они уже есть
      const merged = {
        ...existing,
        ...data.settings,
        // Ключи придут отдельно из /api/settings, не перезатираем
        keys: existing.keys?.length > 0 ? existing.keys : (data.settings.keys || []),
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged))
    } catch {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings))
    }
  }
  // Восстанавливаем историю чатов
  if (Array.isArray(data.chats)) {
    localStorage.setItem(CHATS_KEY, JSON.stringify(data.chats))
  }
}

const inputCls = 'w-full rounded-xl border border-white/10 bg-graphite-900 px-4 py-3 text-cream placeholder:text-cream-faint focus:border-cream/30 focus:outline-none'

function AuthPanel({ onAuthenticated }) {
  const resetToken = useMemo(() => new URLSearchParams(window.location.search).get('reset_token') || '', [])
  // режимы: login | register | forgot | reset | sms-phone | sms-code | sms-reset
  const [mode, setMode] = useState(resetToken ? 'reset' : 'login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [smsResetToken, setSmsResetToken] = useState('')
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
        if (password !== password2) { setError('Пароли не совпадают'); return }
        await backend.authRegister({ email, name, phone, password, registrationSecret })
        await onAuthenticated()
        return
      }

      if (mode === 'forgot') {
        await backend.authForgotPassword(email)
        setMessage('Если email зарегистрирован, ссылка восстановления отправлена.')
        return
      }

      if (mode === 'reset') {
        await backend.authResetPassword(resetToken, password)
        setMessage('Пароль изменён. Теперь войдите.')
        window.history.replaceState({}, '', window.location.pathname)
        setMode('login')
        setPassword('')
        return
      }

      // SMS-восстановление: шаг 1 — ввод телефона
      if (mode === 'sms-phone') {
        const res = await fetch('/api/auth/sms-send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        })
        const data = await res.json()
        if (!res.ok) { setError(data.error || 'Ошибка'); return }
        setMessage('Код отправлен на ваш номер')
        setMode('sms-code')
        return
      }

      // SMS-восстановление: шаг 2 — ввод кода
      if (mode === 'sms-code') {
        const res = await fetch('/api/auth/sms-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code: smsCode }),
        })
        const data = await res.json()
        if (!res.ok) { setError(data.error || 'Неверный код'); return }
        setSmsResetToken(data.resetToken)
        setMessage('Код подтверждён! Введите новый пароль.')
        setMode('sms-reset')
        return
      }

      // SMS-восстановление: шаг 3 — новый пароль
      if (mode === 'sms-reset') {
        if (password !== password2) { setError('Пароли не совпадают'); return }
        await backend.authResetPassword(smsResetToken, password)
        setMessage('Пароль изменён! Теперь войдите.')
        setMode('login')
        setPassword('')
        setPassword2('')
        return
      }
    } catch (e) {
      setError(e.message || 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  const title = {
    login: 'Войти',
    register: 'Регистрация',
    forgot: 'Сброс по email',
    reset: 'Новый пароль',
    'sms-phone': 'Сброс по SMS',
    'sms-code': 'Введите код',
    'sms-reset': 'Новый пароль',
  }[mode] || 'BrowserAI'

  const btnLabel = busy ? 'Подождите…' : {
    login: 'Войти',
    register: 'Зарегистрироваться',
    forgot: 'Отправить ссылку на email',
    reset: 'Сменить пароль',
    'sms-phone': 'Получить SMS-код',
    'sms-code': 'Подтвердить код',
    'sms-reset': 'Сменить пароль',
  }[mode]

  return (
    <div className="flex min-h-screen items-center justify-center bg-graphite-900 px-4 py-8 text-cream">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-graphite-800 p-6 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-3xl font-semibold">BrowserAI</div>
          <div className="mt-1 text-[13px] text-cream-faint">{title}</div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {/* Имя */}
          {mode === 'register' && (
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Имя" className={inputCls} />
          )}

          {/* Email */}
          {['login', 'register', 'forgot'].includes(mode) && (
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="Email" required className={inputCls} />
          )}

          {/* Телефон при регистрации */}
          {mode === 'register' && (
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="Телефон +7... (для сброса пароля по SMS)"
              className={inputCls} />
          )}

          {/* Телефон при SMS-сбросе */}
          {mode === 'sms-phone' && (
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="Номер телефона +7..." required className={inputCls} />
          )}

          {/* SMS-код */}
          {mode === 'sms-code' && (
            <input type="text" inputMode="numeric" maxLength={6}
              value={smsCode} onChange={(e) => setSmsCode(e.target.value)}
              placeholder="6-значный код из SMS" required className={inputCls} />
          )}

          {/* Пароль */}
          {['login', 'register', 'reset', 'sms-reset'].includes(mode) && (
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'login' ? 'Пароль' : 'Новый пароль'}
              required minLength={10} className={inputCls} />
          )}

          {/* Подтверждение пароля */}
          {['register', 'reset', 'sms-reset'].includes(mode) && (
            <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)}
              placeholder="Повторите пароль" required className={inputCls} />
          )}

          {/* Секрет регистрации */}
          {mode === 'register' && (
            <input type="password" value={registrationSecret}
              onChange={(e) => setRegistrationSecret(e.target.value)}
              placeholder="Секрет регистрации (если не первый пользователь)"
              className={inputCls} />
          )}

          {error && (
            <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              {message}
            </div>
          )}

          <button disabled={busy}
            className="w-full rounded-xl bg-cream px-4 py-3 font-medium text-graphite-900 transition-opacity disabled:opacity-60">
            {btnLabel}
          </button>
        </form>

        {/* Навигация между режимами */}
        <div className="mt-5 flex flex-wrap justify-center gap-3 text-sm text-cream-dim">
          {mode !== 'login' && (
            <button onClick={() => { setMode('login'); setError(''); setMessage('') }}
              className="hover:text-cream">Войти</button>
          )}
          {mode !== 'register' && (
            <button onClick={() => { setMode('register'); setError(''); setMessage('') }}
              className="hover:text-cream">Регистрация</button>
          )}
          {!['forgot', 'sms-phone', 'sms-code', 'sms-reset', 'reset'].includes(mode) && (
            <>
              <button onClick={() => { setMode('forgot'); setError(''); setMessage('') }}
                className="hover:text-cream">Сброс по email</button>
              <button onClick={() => { setMode('sms-phone'); setError(''); setMessage('') }}
                className="hover:text-cream">Сброс по SMS</button>
            </>
          )}
          {['forgot', 'sms-phone', 'sms-code', 'sms-reset'].includes(mode) && mode !== 'sms-code' && (
            <button onClick={() => { setMode('login'); setError(''); setMessage('') }}
              className="hover:text-cream">← Назад</button>
          )}
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
